/**
 * ClaimedIdleScheduler — "认领闲置唤醒器".
 *
 * Root cause (2026-07-26 00:20 incident): a cat claims a task (status → 'doing',
 * ownerCatId set), posts a single plan message, and then ends its turn with an
 * empty queue and no active invocation. Nothing on the platform ever wakes it
 * back up — the task hangs claimed-but-idle indefinitely. The same-day
 * work-admission-service.ts wake-up (wakeCandidateCatsForUnclaimedTask) only
 * covers the *unowned* task case; this module covers the *claimed* case.
 *
 * Design mirrors two existing patterns rather than inventing new machinery:
 * - Polling shape (start/stop/tick, .unref() timer, single-flight `ticking`
 *   guard, env-gated, Redis-mode-only startup): AutoRetryScheduler.ts.
 * - Wake-up delivery (durable enqueue → persistEntry → tryAutoExecute, same
 *   idempotency-key convention): wakeCandidateCatsForUnclaimedTask in
 *   work-admission-service.ts.
 *
 * "认领闲置" judgement (per task, only kind='work', status='doing', ownerCatId set):
 * 1. No active invocation for the owner on the task's *work* thread
 *    (task.taskThreadId — the dedicated discussion thread created by
 *    ensureTaskDiscussionThread — falling back to task.threadId only for the
 *    rare legacy task that never got one). Checked via InvocationTracker.has()
 *    (ground-truth "is a process running for this cat right now") AND
 *    InvocationQueue.hasQueuedOrProcessingForCat() (queued or in-flight queue
 *    entry) — either one means "not idle".
 * 2. Idle duration = now - task.updatedAt exceeds CLOWDER_CLAIMED_IDLE_MINUTES
 *    (default 15). TRADEOFF (per spec, deliberately accepted): this does NOT
 *    also check the owner's most recent message timestamp in the thread —
 *    doing so would require a messageStore.getByThread() read per candidate
 *    task on every 60s tick. task.updatedAt already advances on every task
 *    ledger touch (claim, status change, and — critically — this scheduler's
 *    own idle_nudged event, see below), so it under-counts idle time only in
 *    the edge case where the owner keeps chatting in the thread WITHOUT ever
 *    touching the task record. The reported incident (a single plan message
 *    right at claim time, then silence) is exactly the case task.updatedAt
 *    already captures correctly.
 *
 * Anti-storm guardrails (all four required by spec):
 * 1. Max 2 nudges per claim cycle. Counted by filtering task.events for
 *    type==='idle_nudged' AFTER the most recent 'claimed' event — deliberately
 *    scoped per claim cycle (chosen over a dedicated `idleNudgeCount` field:
 *    smaller diff, zero TaskStore/RedisTaskStore changes since `events` already
 *    round-trips through both stores). If the task is unclaimed and re-claimed
 *    by a different (or the same) cat, the new claim gets a fresh budget.
 * 2. Minimum 30 minutes between nudges — checked against the last 'idle_nudged'
 *    event's own timestamp, not task.updatedAt (which the nudge itself bumps,
 *    so relying on it alone would let nudge #2 fire after only the 15-minute
 *    idle threshold instead of the required 30).
 * 3. After the cap is exhausted and the task is STILL idle (checked on every
 *    tick, same idle-duration + no-active-invocation gate as a nudge would
 *    use), post exactly one 'task_idle_escalated' ledger event + one system
 *    notice to the task's *main* thread (task.threadId — same convention as
 *    persistUnclaimedTaskNotice/persistOwnedTaskCreatedNotice: the main
 *    channel is what the shepherd actually watches). The ledger event makes
 *    this terminal for the claim cycle — no cat is spawned, zero tokens spent,
 *    and the scheduler never revisits this task again until it changes hands.
 * 4. Total kill switch CLOWDER_CLAIMED_IDLE_WAKEUP (default ON; '0'/'false'
 *    turns it off) checked at the top of every tick.
 */

import { catRegistry, type CatId, type TaskEvent, type TaskItem, type UpdateTaskInput } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { appendTaskLifecycleNotice, taskLifecycleLabel } from '../../../../../routes/task-event-notices.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import type { SocketManager } from '../../../../../infrastructure/websocket/index.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

const log = createModuleLogger('ClaimedIdleScheduler');

/** 批次 4 定稿：首次唤醒至少等待 120 分钟，避免短暂空档变成催促风暴。 */
const DEFAULT_IDLE_MINUTES = 120;
/** Spec: scan cadence. */
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
/** Spec: minimum spacing between the two nudges. */
const MIN_NUDGE_INTERVAL_MS = 30 * 60_000;
/** Spec: hard cap — 2 nudges per claim cycle, then escalate instead. */
export const MAX_CLAIMED_IDLE_NUDGES = 2;
/** Spec: pending nudge queue entries expire after 24h (matches the "durable enqueue" pattern's own TTL field, just a different window than auto-claim's 7-day PENDING_MENTION_TTL_MS — a stale claimed-idle nudge is far less useful after a day). */
const NUDGE_EXPIRES_MS = 24 * 60 * 60 * 1000;

/** Batch: total kill switch for claimed-idle wake-up. Default ON — see env-registry.ts CLOWDER_CLAIMED_IDLE_WAKEUP entry for the "why default-on" rationale. */
export function isClaimedIdleWakeupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_CLAIMED_IDLE_WAKEUP ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/**
 * Parse CLOWDER_CLAIMED_IDLE_MINUTES. Unset/blank/non-numeric/non-positive → default 120
 * (fail-open on operator typos, same convention as resolveLibraryRebuildHours).
 */
export function resolveClaimedIdleThresholdMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLOWDER_CLAIMED_IDLE_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_IDLE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_MINUTES;
  return n;
}

const UNCLAIMED_NOTICE_TITLE_MAX = 60;

function truncateTaskTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > UNCLAIMED_NOTICE_TITLE_MAX
    ? `${trimmed.slice(0, UNCLAIMED_NOTICE_TITLE_MAX - 1)}…`
    : trimmed;
}

function buildClaimedIdleWakeContent(task: TaskItem, label: string, idleMinutes: number): string {
  return [
    `[系统] 你认领的任务 ${label}（${truncateTaskTitle(task.title)}）已闲置 ${idleMinutes} 分钟且无进行中的执行。`,
    '请把进度或阻塞说一句；无法继续则用 cat_cafe_task_update 置 blocked 并写明卡点，或 cat_cafe_task_unclaim 放手。',
  ].join('\n');
}

/** Minimal structural dependencies — duck-typed so tests can supply lightweight fakes (AutoRetryScheduler's test style). */
export interface ClaimedIdleTaskStoreLike {
  listByKind: ITaskStore['listByKind'];
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
  listByThread: ITaskStore['listByThread'];
}

export interface ClaimedIdleInvocationTrackerLike {
  /** Ground-truth "is a process actively running for this cat in this thread right now". */
  has(threadId: string, catId?: string): boolean;
}

export interface ClaimedIdleInvocationQueueLike {
  hasQueuedOrProcessingForCat(threadId: string, catId: string): boolean;
  hasActiveIdempotencyKey(threadId: string, userId: string, idempotencyKey: string): boolean;
  enqueue: InvocationQueue['enqueue'];
  persistEntry(entry: QueueEntry): Promise<void>;
}

export interface ClaimedIdleQueueProcessorLike {
  tryAutoExecute(threadId: string): Promise<void>;
}

export interface ClaimedIdleSchedulerDeps {
  taskStore: ClaimedIdleTaskStoreLike;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
  invocationQueue: ClaimedIdleInvocationQueueLike;
  invocationTracker: ClaimedIdleInvocationTrackerLike;
  queueProcessor?: ClaimedIdleQueueProcessorLike;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable env lookup for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  scanIntervalMs?: number;
}

export class ClaimedIdleScheduler {
  private readonly deps: ClaimedIdleSchedulerDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks if a scan takes longer than the interval. */
  private ticking = false;

  constructor(deps: ClaimedIdleSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`[claimed-idle-scheduler] tick failed (best-effort): ${String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan pass. Exposed for tests — production code should use start()/stop(). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (!isClaimedIdleWakeupEnabled(this.deps.env)) return;

    this.ticking = true;
    try {
      const tasks = await this.deps.taskStore.listByKind('work');
      const now = this.now();
      for (const task of tasks) {
        try {
          await this.maybeAct(task, now);
        } catch (err) {
          log.warn(`[claimed-idle-scheduler] failed to evaluate task ${task.id}: ${String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeAct(task: TaskItem, now: number): Promise<void> {
    if (task.status !== 'doing' || !task.ownerCatId) return;
    const ownerCatId = task.ownerCatId;
    if (!catRegistry.has(ownerCatId)) return; // owner no longer a registered cat — nothing to wake

    const workThreadId = task.taskThreadId ?? task.threadId;
    const events = task.events ?? [];
    const lastClaimTs = lastEventTsOfType(events, 'claimed');
    // Scope the nudge/escalation ledger to the CURRENT claim cycle: an earlier
    // owner's exhausted budget (or escalation) must not carry over to a fresh claim.
    const scoped = lastClaimTs === null ? events : events.filter((e) => parseEventTs(e) >= lastClaimTs);

    if (scoped.some((e) => e.type === 'task_idle_escalated')) return; // terminal for this claim cycle

    const idleThresholdMs = resolveClaimedIdleThresholdMinutes(this.deps.env) * 60_000;
    if (now - task.updatedAt <= idleThresholdMs) return; // not idle long enough yet

    // Ground-truth "currently active" check — either signal means "not actually idle".
    if (this.deps.invocationTracker.has(workThreadId, ownerCatId)) return;
    if (this.deps.invocationQueue.hasQueuedOrProcessingForCat(workThreadId, ownerCatId)) return;

    const nudgeEvents = scoped.filter((e) => e.type === 'idle_nudged');

    if (nudgeEvents.length >= MAX_CLAIMED_IDLE_NUDGES) {
      await this.escalate(task, ownerCatId);
      return;
    }

    const lastNudgeTs = nudgeEvents.length > 0 ? parseEventTs(nudgeEvents[nudgeEvents.length - 1]!) : null;
    if (lastNudgeTs !== null && now - lastNudgeTs < MIN_NUDGE_INTERVAL_MS) return; // too soon since the last nudge

    await this.sendNudge(task, workThreadId, ownerCatId, nudgeEvents.length, now);
  }

  private async sendNudge(
    task: TaskItem,
    workThreadId: string,
    ownerCatId: CatId,
    priorNudgeCount: number,
    now: number,
  ): Promise<void> {
    const label = await taskLifecycleLabel(this.deps.taskStore, task).catch(() => `#${task.id}`);
    const idleMinutes = Math.max(1, Math.round((now - task.updatedAt) / 60_000));
    const content = buildClaimedIdleWakeContent(task, label, idleMinutes);
    const nudgeNumber = priorNudgeCount + 1;
    const idempotencyKey = `claimed-idle:${task.id}:${nudgeNumber}`;
    const userId = task.userId ?? 'system';

    if (this.deps.invocationQueue.hasActiveIdempotencyKey(workThreadId, userId, idempotencyKey)) return;

    const result = this.deps.invocationQueue.enqueue({
      threadId: workThreadId,
      userId,
      idempotencyKey,
      content,
      source: 'agent',
      sourceCategory: 'claimed_idle_nudge',
      targetCats: [ownerCatId],
      intent: 'execute',
      autoExecute: true,
      expiresAt: now + NUDGE_EXPIRES_MS,
    });

    if (result.outcome !== 'enqueued' || result.deduped || !result.entry) return;
    await this.deps.invocationQueue.persistEntry(result.entry);
    await this.deps.queueProcessor?.tryAutoExecute(workThreadId);

    const event: TaskEvent = {
      ts: new Date(now).toISOString(),
      catId: 'system',
      type: 'idle_nudged',
      data: { nudgeNumber, idleMinutes },
    };
    await this.deps.taskStore.update(task.id, { events: [event] });
  }

  private async escalate(task: TaskItem, ownerCatId: CatId): Promise<void> {
    const event: TaskEvent = {
      ts: new Date(this.now()).toISOString(),
      catId: 'system',
      type: 'task_idle_escalated',
      data: {},
    };
    const updated = await this.deps.taskStore.update(task.id, { events: [event] });
    if (!updated) return;
    this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    const label = await taskLifecycleLabel(this.deps.taskStore, updated).catch(() => `#${updated.id}`);
    await appendTaskLifecycleNotice({
      task: updated,
      content: `认领闲置：@${ownerCatId} 两次提醒无进展（任务 ${label}），建议铲屎官人工处理或让其 unclaim。`,
      systemKind: 'task_idle_escalated',
      eventType: 'task_idle_escalated',
      tone: 'warning',
      dedupeKey: 'idle_escalated',
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    }).catch(() => {});
  }
}

function parseEventTs(event: TaskEvent): number {
  const ts = Date.parse(event.ts);
  return Number.isFinite(ts) ? ts : 0;
}

function lastEventTsOfType(events: readonly TaskEvent[], type: TaskEvent['type']): number | null {
  let last: number | null = null;
  for (const e of events) {
    if (e.type !== type) continue;
    const ts = parseEventTs(e);
    if (last === null || ts >= last) last = ts;
  }
  return last;
}
