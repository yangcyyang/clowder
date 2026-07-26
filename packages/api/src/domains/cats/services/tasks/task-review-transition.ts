/**
 * 批次4-B: 统一的 "进入/离开 in_review" 处理 —— 三条状态变更入口
 * (callback-task-routes.ts 的 /api/callbacks/update-task、/api/callbacks/task-update，
 * tasks.ts 的 PATCH /api/tasks/:id) 共用同一份逻辑，避免各自为政、校验/通知漂移。
 *
 * Covers:
 *   B1 — reviewer 缺省解析 + "执行者永不 review 自己的票" 服务端校验 + 通知验收人
 *        (human=既有的状态变更可见通知；猫=唤醒投递，durable enqueue，同
 *        ClaimedIdleScheduler.sendNudge/work-admission-service.wakeCandidateCatsForUnclaimedTask
 *        的 "durable enqueue + idempotencyKey" 模式，不依赖认领闲置唤醒器开关)。
 *   B4①③ — 证据自动锚定 + 静态扫描 (task-review-evidence.ts, 调用方在此编排)。
 *   B4④ — 验收动作留痕: 任何离开 in_review 的状态变更 (非 B2 第三级超时状态动作，那个
 *        有自己的 review_timeout_reverted 事件) 都记一条 review_action_recorded。
 */

import { catRegistry, type CatId, type TaskEvent, type TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { InvocationQueue, QueueEntry } from '../agents/invocation/InvocationQueue.js';
import { taskLifecycleLabel } from '../../../../routes/task-event-notices.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { SocketManager } from '../../../../infrastructure/websocket/index.js';
import { anchorReviewEvidence } from './task-review-evidence.js';
import { resolveConfiguredDefaultReviewerId, type ReviewerId } from './task-reviewer-defaults.js';
import { resolveReviewerAvoidingSelfReview } from './task-status-transitions.js';

const log = createModuleLogger('task-review-transition');

/** Pending gate-reviewer wake-up entries expire after 24h — same window as ClaimedIdleScheduler's nudge. */
const WAKEUP_EXPIRES_MS = 24 * 60 * 60 * 1000;

export interface ReviewTransitionQueueLike {
  hasActiveIdempotencyKey(threadId: string, userId: string, idempotencyKey: string): boolean;
  enqueue: InvocationQueue['enqueue'];
  persistEntry(entry: QueueEntry): Promise<void>;
}

export interface ReviewTransitionQueueProcessorLike {
  tryAutoExecute(threadId: string): Promise<void>;
}

export interface ReviewTransitionDeps {
  taskStore: Pick<ITaskStore, 'update' | 'listByThread'>;
  threadStore?: Pick<IThreadStore, 'get'>;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
  invocationQueue?: ReviewTransitionQueueLike;
  queueProcessor?: ReviewTransitionQueueProcessorLike;
  env?: NodeJS.ProcessEnv;
}

export type PrepareReviewEntryResult =
  | { ok: true; reviewerId: ReviewerId; events: TaskEvent[] }
  /** 批次4-B1 B-AC1: 执行者=验收人时服务端拒绝整个 in_review 转移（不落回缺省）——调用方
   *  应在合并 taskStore.update() 之前直接把这个结果映射成一个 4xx 错误返回给调用者。 */
  | { ok: false; reason: string; suggestedReviewerId: ReviewerId };

/**
 * Call BEFORE persisting a status change TO 'in_review' (task is still pre-transition).
 * Resolves the reviewer (existing task.reviewerId, or the platform default for legacy tasks
 * that predate this batch) and applies the self-review guard (B-AC1: rejects outright when
 * executor===reviewer, see resolveReviewerAvoidingSelfReview's doc for why reject rather than
 * silently redirect). Pure/no I/O — on success, merge the returned reviewerId + events into
 * the same taskStore.update() call that sets the status; on failure, reject the request
 * before ever calling taskStore.update().
 */
export function prepareReviewEntry(
  task: Pick<TaskItem, 'reviewerId' | 'ownerCatId'>,
  env: NodeJS.ProcessEnv = process.env,
): PrepareReviewEntryResult {
  const now = new Date().toISOString();
  const defaultReviewerId = resolveConfiguredDefaultReviewerId(env);
  const candidate: ReviewerId = task.reviewerId ?? defaultReviewerId;
  const resolution = resolveReviewerAvoidingSelfReview({
    candidateReviewerId: candidate,
    ownerCatId: task.ownerCatId,
    defaultReviewerId,
  });
  if (!resolution.ok) {
    return { ok: false, reason: resolution.reason, suggestedReviewerId: resolution.suggestedReviewerId };
  }

  const event: TaskEvent = {
    ts: now,
    catId: 'system',
    type: 'review_requested',
    data: { reviewerId: resolution.reviewerId },
  };
  return { ok: true, reviewerId: resolution.reviewerId, events: [event] };
}

/** Durable-enqueue wake-up for a gate (cat) reviewer — mirrors ClaimedIdleScheduler.sendNudge's pattern exactly. */
async function notifyGateReviewer(task: TaskItem, reviewerId: CatId, deps: ReviewTransitionDeps): Promise<void> {
  if (!deps.invocationQueue) return;
  const label = await taskLifecycleLabel(deps.taskStore, task).catch(() => `#${task.id}`);
  const workThreadId = task.taskThreadId ?? task.threadId;
  const userId = task.userId ?? 'system';
  const idempotencyKey = `gate-review-wakeup:${task.id}:${reviewerId}`;

  if (deps.invocationQueue.hasActiveIdempotencyKey(workThreadId, userId, idempotencyKey)) return;

  const content = [
    `[系统] 任务 ${label}（${task.title}）已置于待验收(in_review)，你是本票验收人。`,
    '请审阅证据(commit/diff/测试输出)后用 cat_cafe_task_update 给出验收结论：done(通过)或打回 doing/blocked 并说明原因。',
  ].join('\n');

  const result = deps.invocationQueue.enqueue({
    threadId: workThreadId,
    userId,
    idempotencyKey,
    content,
    source: 'agent',
    sourceCategory: 'gate_review_wakeup',
    targetCats: [reviewerId],
    intent: 'execute',
    autoExecute: true,
    expiresAt: Date.now() + WAKEUP_EXPIRES_MS,
  });
  if (result.outcome !== 'enqueued' || result.deduped || !result.entry) return;
  await deps.invocationQueue.persistEntry(result.entry);
  await deps.queueProcessor?.tryAutoExecute(workThreadId);
}

/**
 * Call AFTER the task has been persisted with status='in_review' (task = the updated record,
 * already carrying the reviewerId prepareReviewEntry resolved). Best-effort — never throws:
 *   - reviewer wake-up when reviewerId is a registered cat (gate 轨). Human 轨 relies on the
 *     visible status-change notice each call site already posts (existing behavior) — see
 *     module doc.
 *   - B4①③ evidence anchor + static scan (delegated to task-review-evidence.ts).
 */
export async function onTaskEnteredReview(task: TaskItem, deps: ReviewTransitionDeps): Promise<void> {
  if (task.reviewerId && task.reviewerId !== 'human' && catRegistry.has(task.reviewerId)) {
    try {
      await notifyGateReviewer(task, task.reviewerId, deps);
    } catch (err) {
      log.warn(`[task-review-transition] gate reviewer wake-up failed (best-effort): ${String(err)}`);
    }
  }

  try {
    await anchorReviewEvidence(task, {
      taskStore: deps.taskStore,
      threadStore: deps.threadStore,
      messageStore: deps.messageStore,
      socketManager: deps.socketManager,
      env: deps.env,
    });
  } catch (err) {
    log.warn(`[task-review-transition] evidence anchor failed (best-effort): ${String(err)}`);
  }
}

/**
 * 批次4-B4④ 验收动作留痕: pure — call BEFORE persisting a status change AWAY from
 * 'in_review' triggered by a human/cat-initiated action (never for
 * ReviewReminderScheduler's own timeout revert, which appends its own dedicated
 * 'review_timeout_reverted' event instead — see that scheduler). Merge the returned events
 * into the SAME taskStore.update() call that performs the status change, alongside whatever
 * else the caller is already passing — avoids a second write for what is otherwise a single
 * logical transition. Returns [] when the transition isn't "leaving in_review" (no-op).
 */
export function prepareReviewActionEvent(params: {
  previousStatus: TaskItem['status'];
  nextStatus: TaskItem['status'];
  previousEvents: readonly TaskEvent[] | undefined;
  actorId: string;
}): TaskEvent[] {
  if (params.previousStatus !== 'in_review' || params.nextStatus === 'in_review') return [];
  const evidenceEventTs = [...(params.previousEvents ?? [])].reverse().find((e) => e.type === 'evidence_anchored')?.ts;
  return [
    {
      ts: new Date().toISOString(),
      catId: params.actorId,
      type: 'review_action_recorded',
      data: {
        from: 'in_review',
        to: params.nextStatus,
        actorId: params.actorId,
        ...(evidenceEventTs ? { evidenceEventTs } : {}),
      },
    },
  ];
}
