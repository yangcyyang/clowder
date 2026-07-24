import type { CatId, TaskEvent, TaskItem } from '@cat-cafe/shared';
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
}

export function isAutoTaskThreadRoutingEnabled(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOWDER_AUTO_TASK_THREAD_ROUTING === 'true') return true;
  return (env.CLOWDER_AUTO_TASK_THREAD_THREADS ?? '')
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
