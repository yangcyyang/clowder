/**
 * ReviewReminderScheduler — 批次4-B2 分轨超时提醒.
 * docs/prd/batch4-codex-execution.md §3 B2 / 第七轮访谈参数落定:
 * "按验收人类型分轨不按票分级：gate（猫）轨=24h 私提醒验收人；human 轨=48h 私提醒 →
 * +48h 频道内可见@owner → 7-14 天状态动作（自动降回 doing+通知双方）。三级封顶，
 * 第三级必须是状态动作不是更响的闹钟"。
 *
 * Design mirrors ClaimedIdleScheduler.ts exactly (same author, same batch, same shape):
 * - Polling shape (start/stop/tick, .unref() timer, single-flight `ticking` guard,
 *   env-gated, Redis-mode-only startup via listByKind).
 * - Per-task ledger scoping: reminders/terminal-action are scoped to events AFTER the
 *   most recent "entered in_review" marker (prefers the 'review_requested' event batch4-B1
 *   appends when a task enters review — see task-review-transition.ts's prepareReviewEntry —
 *   falling back to the platform-generated 'status_changed'-to-in_review event, and finally
 *   to task.updatedAt for maximum robustness). A task that leaves and re-enters in_review
 *   (rejected → resubmitted) gets a completely fresh reminder budget, exactly like
 *   ClaimedIdleScheduler resets the nudge budget on a fresh claim.
 * - Gate(猫)-reviewer wake-up reuses the identical "durable enqueue + idempotencyKey"
 *   pattern as ClaimedIdleScheduler.sendNudge / task-review-transition.ts's
 *   notifyGateReviewer — NOT gated by CLOWDER_CLAIMED_IDLE_WAKEUP (that switch stays off in
 *   production per the batch4-B execution brief; this is an independent mechanism).
 *
 * Track selection ("按验收人类型分轨，不按票分级"): task.reviewerId naming a currently
 * registered cat → gate 轨; anything else (literal 'human', or absent on a legacy
 * pre-batch-4 task) → human 轨. A task can only be in ONE track at a time — the table has
 * no overlap (gate 轨 has exactly one level; human 轨 has three).
 *
 * Levels (each track/level pair fires at most once per review cycle — "每票每级各触发
 *一次，不重复轰炸"):
 *   gate  : level 1 @ CLOWDER_REVIEW_REMINDER_GATE_HOURS (default 24h) — private reminder
 *           enqueued directly to the reviewer cat. No further escalation defined for this
 *           track (per spec's table — only "24h 私提醒验收人", no second level).
 *   human : level 1 @ CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL1_HOURS (default 48h) — "私提醒":
 *           posted into the task's OWN discussion thread (taskThreadId), narrower audience
 *           than the shared parent channel — contrasted against level 2's explicitly
 *           "频道内可见" (channel-visible) escalation.
 *           level 2 @ CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL2_HOURS (default 96h = 48+48,
 *           absolute elapsed time from review-cycle-start, not "48h after level 1 actually
 *           fired" — simpler and robust against a delayed/missed level 1 e.g. from a
 *           temporary env toggle) — posted into the task's main channel (task.threadId)
 *           naming the owner ("@owner" — textual, not an invocation wake-up: the goal is
 *           visibility for any human reading the channel, not paging the owner cat, which
 *           per spec's wording discipline is a "频道内可见" action, not a "唤醒" action).
 *           level 3 @ CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL3_DAYS (default 10 — the spec's
 *           own range is "7-14 天", not a single value; 10 is a defensible midpoint, kept
 *           env-configurable — see batch report for the explicit flag-for-confirmation) —
 *           a STATE ACTION, not a louder reminder: force-reverts the task from 'in_review'
 *           back to 'doing' and posts a visible notice to both submitter and reviewer,
 *           asking for resubmission or an explicit give-up. Terminal for the review cycle —
 *           the scheduler never revisits this task again until it re-enters in_review.
 */

import { catRegistry, type CatId, type TaskEvent, type TaskItem, type UpdateTaskInput } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { appendTaskLifecycleNotice, taskLifecycleLabel } from '../../../../../routes/task-event-notices.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import type { SocketManager } from '../../../../../infrastructure/websocket/index.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

const log = createModuleLogger('ReviewReminderScheduler');

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_GATE_HOURS = 24;
const DEFAULT_HUMAN_LEVEL1_HOURS = 48;
const DEFAULT_HUMAN_LEVEL2_HOURS = 96;
/** Spec range is "7-14 天" — 10 is a documented midpoint default, not a firm spec value. See module doc. */
const DEFAULT_HUMAN_LEVEL3_DAYS = 10;
/** Pending reminder/wake-up queue entries expire after 24h — matches ClaimedIdleScheduler's own window. */
const WAKEUP_EXPIRES_MS = 24 * 60 * 60 * 1000;

/** Kill switch — default ON. See env-registry.ts CLOWDER_REVIEW_REMINDER_SCHEDULER entry. */
export function isReviewReminderSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_REVIEW_REMINDER_SCHEDULER ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/** Fail-open on operator typos/blank/non-positive — same convention as resolveClaimedIdleThresholdMinutes. */
function resolvePositiveNumber(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveGateReminderHours(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePositiveNumber(env.CLOWDER_REVIEW_REMINDER_GATE_HOURS, DEFAULT_GATE_HOURS);
}

export function resolveHumanLevel1Hours(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePositiveNumber(env.CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL1_HOURS, DEFAULT_HUMAN_LEVEL1_HOURS);
}

export function resolveHumanLevel2Hours(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePositiveNumber(env.CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL2_HOURS, DEFAULT_HUMAN_LEVEL2_HOURS);
}

export function resolveHumanLevel3Days(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePositiveNumber(env.CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL3_DAYS, DEFAULT_HUMAN_LEVEL3_DAYS);
}

const TITLE_MAX = 60;
function truncateTaskTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
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

function lastStatusChangedToTs(events: readonly TaskEvent[], to: TaskItem['status']): number | null {
  let last: number | null = null;
  for (const e of events) {
    if (e.type !== 'status_changed') continue;
    if ((e.data as { to?: string } | undefined)?.to !== to) continue;
    const ts = parseEventTs(e);
    if (last === null || ts >= last) last = ts;
  }
  return last;
}

/** "进入本轮 in_review 的时间点" — prefers the B1 review_requested marker, falls back gracefully. */
function resolveReviewCycleStartTs(task: TaskItem): number {
  const events = task.events ?? [];
  const reviewRequested = lastEventTsOfType(events, 'review_requested');
  if (reviewRequested !== null) return reviewRequested;
  const statusChanged = lastStatusChangedToTs(events, 'in_review');
  if (statusChanged !== null) return statusChanged;
  return task.updatedAt;
}

export interface ReviewReminderTaskStoreLike {
  listByKind: ITaskStore['listByKind'];
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
  listByThread: ITaskStore['listByThread'];
}

export interface ReviewReminderInvocationQueueLike {
  hasActiveIdempotencyKey(threadId: string, userId: string, idempotencyKey: string): boolean;
  enqueue: InvocationQueue['enqueue'];
  persistEntry(entry: QueueEntry): Promise<void>;
}

export interface ReviewReminderQueueProcessorLike {
  tryAutoExecute(threadId: string): Promise<void>;
}

export interface ReviewReminderSchedulerDeps {
  taskStore: ReviewReminderTaskStoreLike;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
  invocationQueue?: ReviewReminderInvocationQueueLike;
  queueProcessor?: ReviewReminderQueueProcessorLike;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable env lookup for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  scanIntervalMs?: number;
}

export class ReviewReminderScheduler {
  private readonly deps: ReviewReminderSchedulerDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: ReviewReminderSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`[review-reminder-scheduler] tick failed (best-effort): ${String(err)}`));
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
    if (!isReviewReminderSchedulerEnabled(this.deps.env)) return;

    this.ticking = true;
    try {
      const tasks = await this.deps.taskStore.listByKind('work');
      const now = this.now();
      for (const task of tasks) {
        if (task.status !== 'in_review') continue;
        try {
          await this.maybeAct(task, now);
        } catch (err) {
          log.warn(`[review-reminder-scheduler] failed to evaluate task ${task.id}: ${String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeAct(task: TaskItem, now: number): Promise<void> {
    const events = task.events ?? [];
    const cycleStartTs = resolveReviewCycleStartTs(task);
    const scoped = events.filter((e) => parseEventTs(e) >= cycleStartTs);

    if (scoped.some((e) => e.type === 'review_timeout_reverted')) return; // terminal for this cycle

    const track: 'gate' | 'human' = task.reviewerId && catRegistry.has(task.reviewerId) ? 'gate' : 'human';
    const elapsedMs = now - cycleStartTs;

    if (track === 'gate') {
      await this.maybeActGate(task, scoped, elapsedMs);
      return;
    }
    await this.maybeActHuman(task, scoped, elapsedMs, now);
  }

  private hasReminderLevel(scoped: readonly TaskEvent[], track: 'gate' | 'human', level: 1 | 2 | 3): boolean {
    return scoped.some(
      (e) =>
        e.type === 'review_reminder_sent' &&
        (e.data as { track?: string; level?: number } | undefined)?.track === track &&
        (e.data as { track?: string; level?: number } | undefined)?.level === level,
    );
  }

  private async maybeActGate(task: TaskItem, scoped: readonly TaskEvent[], elapsedMs: number): Promise<void> {
    const thresholdMs = resolveGateReminderHours(this.deps.env) * 3600_000;
    if (elapsedMs <= thresholdMs) return;
    if (this.hasReminderLevel(scoped, 'gate', 1)) return;
    const reviewerId = task.reviewerId as CatId;
    await this.sendGateReminder(task, reviewerId);
  }

  private async sendGateReminder(task: TaskItem, reviewerId: CatId): Promise<void> {
    if (!this.deps.invocationQueue) return;
    const label = await taskLifecycleLabel(this.deps.taskStore, task).catch(() => `#${task.id}`);
    const workThreadId = task.taskThreadId ?? task.threadId;
    const userId = task.userId ?? 'system';
    const idempotencyKey = `review-reminder:${task.id}:gate:1`;
    if (this.deps.invocationQueue.hasActiveIdempotencyKey(workThreadId, userId, idempotencyKey)) return;

    const content = [
      `[系统] 任务 ${label}（${truncateTaskTitle(task.title)}）已等待你验收超过 ${resolveGateReminderHours(this.deps.env)} 小时。`,
      '请审阅证据后用 cat_cafe_task_update 给出验收结论：done(通过)或打回 doing/blocked 并说明原因。',
    ].join('\n');

    const result = this.deps.invocationQueue.enqueue({
      threadId: workThreadId,
      userId,
      idempotencyKey,
      content,
      source: 'agent',
      sourceCategory: 'gate_review_reminder',
      targetCats: [reviewerId],
      intent: 'execute',
      autoExecute: true,
      expiresAt: Date.now() + WAKEUP_EXPIRES_MS,
    });
    if (result.outcome !== 'enqueued' || result.deduped || !result.entry) return;
    await this.deps.invocationQueue.persistEntry(result.entry);
    await this.deps.queueProcessor?.tryAutoExecute(workThreadId);

    await this.appendReminderEvent(task, 'gate', 1);
  }

  private async maybeActHuman(
    task: TaskItem,
    scoped: readonly TaskEvent[],
    elapsedMs: number,
    now: number,
  ): Promise<void> {
    const level3Ms = resolveHumanLevel3Days(this.deps.env) * 24 * 3600_000;
    if (elapsedMs > level3Ms) {
      await this.revertTimeout(task, now);
      return;
    }

    const level2Ms = resolveHumanLevel2Hours(this.deps.env) * 3600_000;
    if (elapsedMs > level2Ms && !this.hasReminderLevel(scoped, 'human', 2)) {
      await this.sendHumanChannelReminder(task);
      return;
    }

    const level1Ms = resolveHumanLevel1Hours(this.deps.env) * 3600_000;
    if (elapsedMs > level1Ms && !this.hasReminderLevel(scoped, 'human', 1)) {
      await this.sendHumanPrivateReminder(task);
    }
  }

  private async sendHumanPrivateReminder(task: TaskItem): Promise<void> {
    const label = await taskLifecycleLabel(this.deps.taskStore, task).catch(() => `#${task.id}`);
    const targetThreadId = task.taskThreadId ?? task.threadId;
    const posted = await appendTaskLifecycleNotice({
      task: { id: task.id, threadId: targetThreadId },
      content: `[提醒] 任务 ${label}（${truncateTaskTitle(task.title)}）已等待验收超过 ${resolveHumanLevel1Hours(this.deps.env)} 小时，请尽快查看。`,
      systemKind: 'task_review_reminder',
      eventType: 'review_reminder_human_l1',
      tone: 'info',
      dedupeKey: 'review-reminder-human-l1',
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    });
    if (!posted.posted) return;
    await this.appendReminderEvent(task, 'human', 1);
  }

  private async sendHumanChannelReminder(task: TaskItem): Promise<void> {
    const label = await taskLifecycleLabel(this.deps.taskStore, task).catch(() => `#${task.id}`);
    const ownerMention = task.ownerCatId ? `@${task.ownerCatId} ` : '';
    const posted = await appendTaskLifecycleNotice({
      task: { id: task.id, threadId: task.threadId },
      content: `[提醒] ${ownerMention}任务 ${label}（${truncateTaskTitle(task.title)}）等验收已超过 ${resolveHumanLevel2Hours(this.deps.env)} 小时，仍无验收结论。`,
      systemKind: 'task_review_reminder',
      eventType: 'review_reminder_human_l2',
      tone: 'warning',
      dedupeKey: 'review-reminder-human-l2',
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    });
    if (!posted.posted) return;
    await this.appendReminderEvent(task, 'human', 2);
  }

  private async appendReminderEvent(task: TaskItem, track: 'gate' | 'human', level: 1 | 2 | 3): Promise<void> {
    const event: TaskEvent = {
      ts: new Date(this.now()).toISOString(),
      catId: 'system',
      type: 'review_reminder_sent',
      data: { track, level },
    };
    await this.deps.taskStore.update(task.id, { events: [event] });
  }

  /** Human 轨 level 3: 状态动作, not a louder reminder — force-revert in_review → doing. */
  private async revertTimeout(task: TaskItem, now: number): Promise<void> {
    const label = await taskLifecycleLabel(this.deps.taskStore, task).catch(() => `#${task.id}`);
    const event: TaskEvent = {
      ts: new Date(now).toISOString(),
      catId: 'system',
      type: 'review_timeout_reverted',
      data: { track: 'human' },
    };
    const updated = await this.deps.taskStore.update(task.id, { status: 'doing', eventCatId: 'system', events: [event] });
    if (!updated) return;
    this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    const ownerMention = updated.ownerCatId ? `@${updated.ownerCatId} ` : '';
    await appendTaskLifecycleNotice({
      task: { id: updated.id, threadId: updated.threadId },
      content: [
        `[系统] ${ownerMention}任务 ${label}（${truncateTaskTitle(updated.title)}）超过 ${resolveHumanLevel3Days(this.deps.env)} 天无验收结论，已自动打回 doing。`,
        '请重新提交验收（cat_cafe_task_update status=in_review）或明确弃票（cat_cafe_task_unclaim）。',
      ].join('\n'),
      systemKind: 'task_review_timeout_reverted',
      eventType: 'review_timeout_reverted',
      tone: 'warning',
      dedupeKey: 'review-timeout-reverted',
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    }).catch(() => {});
  }
}
