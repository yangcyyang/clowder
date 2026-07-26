/**
 * AssigneeIncapacitationScheduler — 批次4-B3 失能打标.
 * docs/prd/batch4-codex-execution.md §3 B3: "assignee 状态异常持续 >30 分钟(防闪断误报)
 * → 其名下 in_progress/todo 票自动打'assignee 失能'标 → 通知 owner + 票所在频道(可见即可,
 * 不 DM 轰炸) → 绝不自动转派 ... 恢复后自动清标,但票上留一条事件记录"。
 *
 * Design mirrors ClaimedIdleScheduler.ts's polling shape exactly (60s tick, .unref() timer,
 * single-flight `ticking` guard, env-gated). Signal input is
 * AssigneeIncapacitationTracker (assignee-incapacitation-tracker.ts), fed by
 * task-run-linkage.ts's applyTaskRunOutcome — see that tracker's module doc for the full
 * "why this hook point" reasoning and the restart-correctness subtlety (an `undefined`
 * signal means "no information yet" and must never be treated as either healthy or
 * incapacitated).
 *
 * "in_progress/todo 票" — this codebase's TaskStatus enum has no literal 'in_progress'
 * value; the spec's English gloss maps onto this platform's 'doing' status. Scope: status
 * ∈ {todo, doing}, kind='work', ownerCatId set to a currently-registered cat.
 *
 * NEVER reassigns (task.ownerCatId is never touched here) — "转派由人/gate 决定并带交接"
 * is a human/gate decision, not a platform action. Tagging/clearing are the only two
 * ledger-mutating actions this scheduler ever performs.
 */

import { catRegistry, type CatId, type TaskEvent, type TaskItem, type UpdateTaskInput } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { appendTaskLifecycleNotice, taskLifecycleLabel } from '../../../../../routes/task-event-notices.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import type { SocketManager } from '../../../../../infrastructure/websocket/index.js';
import {
  INCAPACITATION_CLASSIFICATION_LABEL_ZH,
  type AssigneeIncapacitationTracker,
} from '../../tasks/assignee-incapacitation-tracker.js';

const log = createModuleLogger('AssigneeIncapacitationScheduler');

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_MINUTES = 30;
const TAGGABLE_STATUSES: ReadonlySet<TaskItem['status']> = new Set(['todo', 'doing']);

/** Kill switch — default ON. See env-registry.ts CLOWDER_ASSIGNEE_INCAPACITATION_TAGGING entry. */
export function isAssigneeIncapacitationTaggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_ASSIGNEE_INCAPACITATION_TAGGING ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/** Fail-open on operator typos/blank/non-positive — same convention as resolveClaimedIdleThresholdMinutes. */
export function resolveIncapacitationThresholdMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLOWDER_ASSIGNEE_INCAPACITATION_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_THRESHOLD_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_MINUTES;
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

/** Current tag state derived from the ledger: whichever of the two event types happened most recently wins. */
function isCurrentlyTagged(task: TaskItem): boolean {
  const events = task.events ?? [];
  let lastTag: number | null = null;
  let lastRecovered: number | null = null;
  for (const e of events) {
    if (e.type === 'assignee_incapacitated') {
      const ts = parseEventTs(e);
      if (lastTag === null || ts >= lastTag) lastTag = ts;
    } else if (e.type === 'assignee_recovered') {
      const ts = parseEventTs(e);
      if (lastRecovered === null || ts >= lastRecovered) lastRecovered = ts;
    }
  }
  if (lastTag === null) return false;
  if (lastRecovered === null) return true;
  return lastTag > lastRecovered;
}

export interface AssigneeIncapacitationTaskStoreLike {
  listByKind: ITaskStore['listByKind'];
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
  listByThread: ITaskStore['listByThread'];
}

export interface AssigneeIncapacitationSchedulerDeps {
  taskStore: AssigneeIncapacitationTaskStoreLike;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;
  tracker: Pick<AssigneeIncapacitationTracker, 'getSignal'>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable env lookup for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  scanIntervalMs?: number;
}

export class AssigneeIncapacitationScheduler {
  private readonly deps: AssigneeIncapacitationSchedulerDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: AssigneeIncapacitationSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`[assignee-incapacitation-scheduler] tick failed (best-effort): ${String(err)}`));
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
    if (!isAssigneeIncapacitationTaggingEnabled(this.deps.env)) return;

    this.ticking = true;
    try {
      const tasks = await this.deps.taskStore.listByKind('work');
      const now = this.now();
      const groups = new Map<CatId, TaskItem[]>();
      for (const task of tasks) {
        if (!TAGGABLE_STATUSES.has(task.status)) continue;
        if (!task.ownerCatId || !catRegistry.has(task.ownerCatId)) continue;
        const list = groups.get(task.ownerCatId) ?? [];
        list.push(task);
        groups.set(task.ownerCatId, list);
      }

      for (const [catId, catTasks] of groups) {
        try {
          await this.maybeActForCat(catId, catTasks, now);
        } catch (err) {
          log.warn(`[assignee-incapacitation-scheduler] failed to evaluate cat ${catId}: ${String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeActForCat(catId: CatId, tasks: readonly TaskItem[], now: number): Promise<void> {
    const signal = this.deps.tracker.getSignal(catId);
    // 关键: undefined(本进程生命周期内从未观测到这只猫的任何结果)一律不动——既不打标也不
    // 清标。这避免了"进程重启后内存里的失能状态清零，导致所有已打标的票被误判'已恢复'"的
    // 虚假清标(见 assignee-incapacitation-tracker.ts 模块文档的重启正确性说明)。
    if (signal === undefined) return;

    if (signal.kind === 'healthy') {
      for (const task of tasks) {
        if (isCurrentlyTagged(task)) {
          await this.clearTag(task, catId);
        }
      }
      return;
    }

    // signal.kind === 'incapacitated'
    const thresholdMs = resolveIncapacitationThresholdMinutes(this.deps.env) * 60_000;
    if (now - signal.since <= thresholdMs) return; // 防闪断: not yet past the grace window

    for (const task of tasks) {
      if (!isCurrentlyTagged(task)) {
        await this.applyTag(task, catId, signal.classification, signal.since);
      }
    }
  }

  private async applyTag(
    task: TaskItem,
    catId: CatId,
    classification: string,
    since: number,
  ): Promise<void> {
    const event: TaskEvent = {
      ts: new Date(this.now()).toISOString(),
      catId: 'system',
      type: 'assignee_incapacitated',
      data: { classification, since },
    };
    const updated = await this.deps.taskStore.update(task.id, { events: [event] });
    if (!updated) return;
    this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    const label = await taskLifecycleLabel(this.deps.taskStore, updated).catch(() => `#${updated.id}`);
    const classificationLabel =
      INCAPACITATION_CLASSIFICATION_LABEL_ZH[classification as keyof typeof INCAPACITATION_CLASSIFICATION_LABEL_ZH] ??
      classification;

    // 双通知 (B-AC3): ① owner (task.userId) via task_attention socket event.
    if (updated.userId) {
      this.deps.socketManager.emitToUser(updated.userId, 'task_attention', updated);
    }
    // ② 票所在频道 (可见即可，不 DM 轰炸).
    await appendTaskLifecycleNotice({
      task: { id: updated.id, threadId: updated.threadId },
      content: [
        `[系统] @${catId} 状态异常已持续超过 ${resolveIncapacitationThresholdMinutes(this.deps.env)} 分钟（${classificationLabel}）。`,
        `任务 ${label}（${truncateTaskTitle(updated.title)}）已打上"assignee 失能"标——平台不会自动转派，需人工或 gate 决定是否转交并做好交接。`,
      ].join('\n'),
      systemKind: 'assignee_incapacitated',
      eventType: 'assignee_incapacitated',
      tone: 'warning',
      dedupeKey: `assignee-incapacitated:${catId}:${since}`,
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    }).catch(() => {});
  }

  private async clearTag(task: TaskItem, catId: CatId): Promise<void> {
    const events = task.events ?? [];
    const lastTagEvent = [...events].reverse().find((e) => e.type === 'assignee_incapacitated');
    const since = (lastTagEvent?.data as { since?: number } | undefined)?.since ?? task.updatedAt;
    const classification = (lastTagEvent?.data as { classification?: string } | undefined)?.classification ?? 'unknown';
    const now = this.now();

    const event: TaskEvent = {
      ts: new Date(now).toISOString(),
      catId: 'system',
      type: 'assignee_recovered',
      data: { classification, since, durationMs: now - since },
    };
    const updated = await this.deps.taskStore.update(task.id, { events: [event] });
    if (!updated) return;
    this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    const label = await taskLifecycleLabel(this.deps.taskStore, updated).catch(() => `#${updated.id}`);
    const durationMinutes = Math.max(1, Math.round((now - since) / 60_000));
    await appendTaskLifecycleNotice({
      task: { id: updated.id, threadId: updated.threadId },
      content: `[系统] @${catId} 已恢复，任务 ${label} 的"assignee 失能"标已清除（本次失能持续约 ${durationMinutes} 分钟，记录已留档）。`,
      systemKind: 'assignee_recovered',
      eventType: 'assignee_recovered',
      tone: 'success',
      dedupeKey: `assignee-recovered:${catId}:${since}`,
      deps: { messageStore: this.deps.messageStore, socketManager: this.deps.socketManager },
    }).catch(() => {});
  }
}
