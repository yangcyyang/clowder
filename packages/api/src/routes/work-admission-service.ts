import { catRegistry, type CatId, type TaskEvent, type TaskItem } from '@cat-cafe/shared';
import { PENDING_MENTION_TTL_MS } from '../domains/cats/services/agents/invocation/a2a-idempotency.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';
import { appendTaskLifecycleNotice, taskLifecycleLabel } from './task-event-notices.js';
import { redactSecretsInText } from '../utils/env-var-secret-guard.js';
import type { WorkAdmissionDecision } from './work-admission.js';

export interface ExecutionRouteV1 {
  version: 1;
  sourceThreadId: string;
  rootMessageId: string;
  replyTargetThreadId: string;
  executionMessageId: string;
  /** message_anchor: F194 §3 step 2 thread-first routing (messages.ts), independent of any task. */
  mode: 'task_thread' | 'explicit_cross_thread' | 'message_anchor';
  taskId?: string;
  ownerCatId?: CatId;
}

export interface WorkAdmissionResult {
  route: ExecutionRouteV1;
  task: TaskItem;
  created: boolean;
}

export interface WorkAdmissionDeps {
  taskStore: ITaskStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  /**
   * Batch 3-A item 1: optional wake-candidate-cats enqueue hook (auto-claim canary).
   * Omitted at call sites that don't wire the queue (e.g. tests) — the wake-up is then
   * silently skipped, matching the default-off gate below.
   */
  invocationQueue?: InvocationQueue;
  queueProcessor?: Pick<QueueProcessor, 'tryAutoExecute'>;
}

export function isAutoTaskThreadRoutingEnabled(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOWDER_AUTO_TASK_THREAD_ROUTING === 'true') return true;
  return (env.CLOWDER_AUTO_TASK_THREAD_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(threadId);
}

/**
 * Batch 3-A item 1: gray-rollout gate for auto-claim wake-up.
 * docs/research/clowder-raft-thread-task-design.md §1 + §5.2 rule 1/2 — Raft claim is
 * automatic (a candidate agent claims or backs off), never human-assigned. Default is
 * empty = off; only threads named in CLOWDER_AUTO_CLAIM_THREADS wake candidate cats for
 * an unowned task.
 */
export function isAutoClaimWakeupEnabled(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLOWDER_AUTO_CLAIM_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(threadId);
}

function initialClaimEvents(ownerCatId: CatId | undefined, timestamp: number): readonly TaskEvent[] | undefined {
  if (!ownerCatId) return undefined;
  const ts = new Date(timestamp).toISOString();
  return [
    { ts, catId: ownerCatId, type: 'claimed', data: { from: null, to: ownerCatId } },
    { ts, catId: ownerCatId, type: 'status_changed', data: { from: 'todo', to: 'doing' } },
  ];
}

function taskTitleForSource(sourceMessage: StoredMessage, classifiedTitle: string): string {
  // Task metadata is injected into every cat's navigation context. An
  // unrevealed whisper body therefore cannot be reused as the task title even
  // though the source copy itself is protected by canViewMessage().
  if (sourceMessage.visibility === 'whisper' && !sourceMessage.revealedAt) return '私密工作指令';
  // Defense-in-depth: classified path already redacts; re-apply for resume_pending_plan titles.
  return redactSecretsInText(classifiedTitle);
}

const UNCLAIMED_NOTICE_TITLE_MAX = 60;

function truncateTaskTitleForNotice(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > UNCLAIMED_NOTICE_TITLE_MAX ? `${trimmed.slice(0, UNCLAIMED_NOTICE_TITLE_MAX - 1)}…` : trimmed;
}

/**
 * F194 可见性修复 (§2 root cause 3): create_from_message without a unique @mention
 * previously left a todo task with zero trace in the main thread — the 202 response
 * was the only signal, and only to the original HTTP caller. Post a normal, socket-visible
 * system notice so "谁来认领" is answered without opening the Tasks tab.
 */
async function persistUnclaimedTaskNotice(task: TaskItem, deps: WorkAdmissionDeps): Promise<void> {
  const label = await taskLifecycleLabel(deps.taskStore, task);
  await appendTaskLifecycleNotice({
    task,
    content: `已创建任务 ${label}：${truncateTaskTitleForNotice(task.title)}（待认领）`,
    systemKind: 'task_created_unclaimed',
    eventType: 'task_created_unclaimed',
    dedupeKey: 'created',
    deps,
  });
}

/** Batch 3-A item 1: candidate cap — bounds fan-out and avoids a claim-storm on wide-roster channels. */
const MAX_AUTO_CLAIM_CANDIDATES = 3;

function buildAutoClaimWakeContent(task: TaskItem): string {
  const lines = [
    `[系统] 出现一个无主任务：${truncateTaskTitleForNotice(task.title)}`,
    task.why ? `背景：${task.why}` : undefined,
    '',
    `请使用 cat_cafe_task_claim 认领任务 #${task.id}（taskId=${task.id}）。`,
    '若认领失败（already_claimed，说明已被其他猫抢先），请直接结束，不要输出任何内容。',
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

/**
 * Batch 3-A item 1: docs/research/clowder-raft-thread-task-design.md §1 + §5.2 rule 1/2 —
 * Raft's claim model is automatic (a candidate agent claims or backs off; humans never
 * assign). This wakes up to MAX_AUTO_CLAIM_CANDIDATES candidate cats for a freshly-created
 * unowned task by dropping one autoExecute queue entry per candidate — same durable
 * enqueue pattern as A2A (callback-a2a-trigger.ts's enqueueA2ATargets), same idempotency
 * convention shape (`auto-claim:{taskId}:{catId}`).
 *
 * Anti-storm: gated to an explicit thread allowlist (isAutoClaimWakeupEnabled, default
 * off), fires only once per task (caller only invokes this on first admission, guarded by
 * `discussion.created`), caps candidates to 3, and otherwise relies on the existing
 * per-cat concurrency slot to naturally throttle (a busy candidate's entry just waits).
 * Candidates who lose the claim race are instructed to end without output — no visible
 * message is posted here; only the eventual claim winner's own work becomes visible.
 */
async function wakeCandidateCatsForUnclaimedTask(task: TaskItem, sourceMessage: StoredMessage, deps: WorkAdmissionDeps): Promise<void> {
  if (!deps.invocationQueue) return;
  if (!isAutoClaimWakeupEnabled(sourceMessage.threadId)) return;

  const thread = await deps.threadStore.get(sourceMessage.threadId);
  if (!thread) return;
  const pool = thread.participatingCats?.length ? thread.participatingCats : (thread.preferredCats ?? []);
  const candidates = pool.filter((catId) => catRegistry.has(catId)).slice(0, MAX_AUTO_CLAIM_CANDIDATES);
  if (candidates.length === 0) return;

  const content = buildAutoClaimWakeContent(task);
  const expiresAt = Date.now() + PENDING_MENTION_TTL_MS;
  let enqueuedAny = false;

  for (const catId of candidates) {
    const idempotencyKey = `auto-claim:${task.id}:${catId}`;
    if (deps.invocationQueue.hasActiveIdempotencyKey(sourceMessage.threadId, sourceMessage.userId, idempotencyKey)) {
      continue;
    }
    const result = deps.invocationQueue.enqueue({
      threadId: sourceMessage.threadId,
      userId: sourceMessage.userId,
      idempotencyKey,
      content,
      source: 'agent',
      sourceCategory: 'auto_claim',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      pendingMentionId: idempotencyKey,
      expiresAt,
    });
    if (result.outcome === 'enqueued' && !result.deduped && result.entry) {
      await deps.invocationQueue.persistEntry(result.entry);
      enqueuedAny = true;
    }
  }

  if (enqueuedAny) {
    await deps.queueProcessor?.tryAutoExecute(sourceMessage.threadId);
  }
}

/**
 * F194 item 4 (batch 2-A): the owned-task counterpart to persistUnclaimedTaskNotice
 * above — batch 1 only notified for the unowned case, leaving owned auto-admitted
 * tasks with zero main-thread trace of their own creation (design doc §2 root
 * cause 4). Deliberately a brief one-liner (Raft's "the message carries a task
 * number and a status" philosophy) — no need to shout, just leave a breadcrumb.
 */
async function persistOwnedTaskCreatedNotice(task: TaskItem, deps: WorkAdmissionDeps): Promise<void> {
  const label = await taskLifecycleLabel(deps.taskStore, task);
  await appendTaskLifecycleNotice({
    task,
    content: `已创建任务 ${label}：${truncateTaskTitleForNotice(task.title)}（${task.ownerCatId} 执行中）`,
    systemKind: 'task_created',
    eventType: 'task_created',
    dedupeKey: 'created',
    deps,
  });
}

export async function admitWorkMessage(input: {
  decision: Exclude<WorkAdmissionDecision, { kind: 'reply_only' }>;
  sourceMessage: StoredMessage;
  userId: string;
  deps: WorkAdmissionDeps;
}): Promise<WorkAdmissionResult> {
  const { decision, sourceMessage, userId, deps } = input;
  const ownerCatId = decision.ownerCatId;
  const now = Date.now();
  const subjectKey = `work-intake:${sourceMessage.threadId}:${sourceMessage.id}`;
  const task = await deps.taskStore.upsertBySubject({
    kind: 'work',
    threadId: sourceMessage.threadId,
    subjectKey,
    title: taskTitleForSource(sourceMessage, decision.taskTitle),
    why:
      decision.kind === 'resume_pending_plan'
        ? `用户批准挂起方案 ${decision.pendingPlanMessageId}`
        : `来自明确工作指令 ${sourceMessage.id}`,
    createdBy: 'user',
    userId,
    sourceMessageId: sourceMessage.id,
    ...(ownerCatId ? { ownerCatId, status: 'doing', events: initialClaimEvents(ownerCatId, now) } : {}),
  });

  const discussion = await ensureTaskDiscussionThread(
    task,
    {
      taskStore: deps.taskStore,
      threadStore: deps.threadStore,
      messageStore: deps.messageStore,
      socketManager: deps.socketManager,
    },
    { userId, broadcastUpdate: false },
  );

  if (discussion.created) {
    deps.socketManager.broadcastToRoom(`thread:${discussion.task.threadId}`, 'task_created', discussion.task);
    // F194 §3 step 2: a thread-first anchor (ensureMessageAnchoredThread) already
    // broadcast thread_branched once when IT created the branch — re-announcing
    // it here would be a duplicate for the same threadId mapping. Only announce
    // when this call is the one that actually created the branch.
    if (!discussion.branchReused) {
      deps.socketManager.broadcastToRoom(`thread:${discussion.task.threadId}`, 'thread_branched', {
        sourceThreadId: discussion.task.threadId,
        newThreadId: discussion.threadId,
        fromMessageId: sourceMessage.id,
      });
    }
    // §2 root cause 3: no unique @mention → no owner → the task would otherwise
    // sit silently in the Tasks tab with zero trace in the main thread.
    // §2 root cause 4 (item 4): the owned case gets its own brief one-liner too —
    // batch 1 only covered the unowned branch.
    if (!ownerCatId) {
      await persistUnclaimedTaskNotice(discussion.task, deps);
      // Batch 3-A item 1: wake candidate cats for this freshly-created unowned task.
      // Best-effort — a wake-up failure must never fail task creation itself.
      await wakeCandidateCatsForUnclaimedTask(discussion.task, sourceMessage, deps).catch(() => {});
    } else {
      await persistOwnedTaskCreatedNotice(discussion.task, deps);
    }
  }

  return {
    task: discussion.task,
    created: discussion.created,
    route: {
      version: 1,
      sourceThreadId: sourceMessage.threadId,
      rootMessageId: sourceMessage.id,
      replyTargetThreadId: discussion.threadId,
      executionMessageId: discussion.sourceMessage.id,
      mode: 'task_thread',
      taskId: discussion.task.id,
      ...(ownerCatId ? { ownerCatId } : {}),
    },
  };
}
