/**
 * 批次4-B3 失能打标 —— assignee incapacitation streak tracker.
 * docs/prd/batch4-codex-execution.md §3 B3: "失能信号来源: 挂在 A2 的错误分类上
 * (额度死/permission_denied/进程异常等持续态)".
 *
 * Signal source (batch4-A's provider-error-classification.ts, already landed): this module
 * hooks task-run-linkage.ts's applyTaskRunOutcome — the one existing call site where a
 * task-linked invocation's terminal outcome (success/failure + raw error text) AND its
 * owner catId are both already in hand, with zero new call sites needed elsewhere. Every
 * task-linked run failure gets classified via classifyProviderErrorText; the three kinds the
 * spec names map onto IncapacitationClassification below. Runs NOT linked to a task (plain
 * chat replies that error) do not feed this tracker — see batch report for the scope note.
 *
 * Streak semantics ("持续 >30 分钟，防闪断误报"):
 *   - First qualifying failure for a cat opens a streak (records `since`).
 *   - Further qualifying failures while the streak is open do NOT reset `since` — the
 *     classification label may update to the most recent kind, but the onset timestamp is
 *     what "持续" is measured against. This intentionally treats "keeps failing in
 *     incapacitating ways, even if the specific kind varies" as one continuous streak.
 *   - ANY success for that cat closes the streak immediately (a real completed run is
 *     unambiguous proof of health) — this is the "防闪断" guard: a streak that self-heals
 *     within the 30-minute grace window never gets tagged in the first place, because
 *     AssigneeIncapacitationScheduler only tags streaks that are BOTH open AND older than
 *     the threshold at scan time.
 *
 * Deliberately in-memory only (process-local, not persisted to Redis): the scheduler that
 * consumes this (AssigneeIncapacitationScheduler.ts) only needs the streak's *existence* and
 * *onset timestamp* to decide "tag or not yet" on each 60s tick — losing streak progress on
 * an infrequent process restart delays detection by at most one threshold window (an
 * availability nit). The actual "have I already tagged this task" state that WOULD cause a
 * repeat-tag storm if lost is tracked durably on the task's own event ledger (task.events),
 * exactly like ClaimedIdleScheduler's idle_nudged bookkeeping — NOT here.
 *
 * IMPORTANT restart-correctness subtlety (found during design, not by accident): a naive
 * "no open streak in the map → clear any existing tag" rule would spuriously auto-clear
 * EVERY tagged task the instant the process restarts (the map starts empty, so every cat
 * momentarily looks "not incapacitated" even if it's still genuinely broken). To avoid this,
 * getSignal() returns a THIRD state — `undefined` ("no information observed yet this process
 * lifetime") — distinct from an explicit `{ kind: 'healthy' }` marker left by recordSuccess().
 * The scheduler must treat `undefined` as "do nothing for this cat" (neither tag nor clear),
 * and only clear a tag once it has POSITIVE evidence of a recorded success. This means an
 * existing tag correctly survives a restart until the platform actually observes fresh
 * evidence (success or continued failure) for that specific cat.
 */

import type { ProviderErrorClassificationKind } from '../agents/invocation/provider-error-classification.js';

export type IncapacitationClassification = 'quota_exhausted' | 'permission_denied' | 'process_abnormal';

export const INCAPACITATION_CLASSIFICATION_LABEL_ZH: Record<IncapacitationClassification, string> = {
  quota_exhausted: '额度耗尽',
  permission_denied: '权限被拒(EPERM/治理拦截)',
  process_abnormal: '进程异常(崩溃/卡死)',
};

/**
 * Maps the 9-kind ProviderErrorClassificationKind taxonomy onto the 3 kinds this batch names
 * as incapacitating. `transient_network` is deliberately excluded — by definition it is
 * expected to recover on its own (that's the whole point of the "transient" label), which
 * would conflict with "assignee 状态异常" framing. Anything not listed returns null (does
 * not open/extend an incapacitation streak).
 */
export function toIncapacitationClassification(
  kind: ProviderErrorClassificationKind,
): IncapacitationClassification | null {
  switch (kind) {
    case 'quota':
      return 'quota_exhausted';
    case 'permission_denied':
      return 'permission_denied';
    case 'cli_crash':
    case 'cli_stall':
      return 'process_abnormal';
    default:
      return null;
  }
}

export interface IncapacitationStreak {
  readonly kind: 'incapacitated';
  readonly classification: IncapacitationClassification;
  /** Epoch ms — when the FIRST qualifying failure in this unbroken streak was observed. */
  readonly since: number;
}

export interface HealthySignal {
  readonly kind: 'healthy';
}

/** `undefined` = no information observed yet this process lifetime — scheduler must treat this as "do nothing". */
export type CatHealthSignal = IncapacitationStreak | HealthySignal | undefined;

export class AssigneeIncapacitationTracker {
  private readonly signals = new Map<string, IncapacitationStreak | HealthySignal>();

  /** A qualifying failure for `catId`. Opens a new streak, or extends (keeps `since`) an existing one. */
  recordFailure(catId: string, classification: IncapacitationClassification, now: number): void {
    const existing = this.signals.get(catId);
    const since = existing?.kind === 'incapacitated' ? existing.since : now;
    this.signals.set(catId, { kind: 'incapacitated', classification, since });
  }

  /** 防闪断: any successful run for `catId` marks it explicitly healthy (not a deletion — see module doc's restart-correctness note). */
  recordSuccess(catId: string): void {
    this.signals.set(catId, { kind: 'healthy' });
  }

  /** `undefined` = never observed this process lifetime — callers must NOT infer either health or incapacitation from that. */
  getSignal(catId: string): CatHealthSignal {
    return this.signals.get(catId);
  }

  listSignals(): ReadonlyMap<string, IncapacitationStreak | HealthySignal> {
    return this.signals;
  }

  /** Test-only escape hatch — mirrors _resetTaskLifecycleNoticeDedupeForTests's convention. */
  _resetForTests(): void {
    this.signals.clear();
  }
}

/**
 * Module-level singleton accessor — same pattern as StartupPermissionCheck.ts's
 * setActiveStartupPermissionCheck/getActiveStartupPermissionCheck: lets task-run-linkage.ts
 * (a different module, already busy, not part of index.ts's startup wiring) push
 * success/failure signals without threading a new dependency through the whole
 * QueueProcessor→applyTaskRunOutcome call chain. index.ts registers the real instance once
 * at startup; tests never call set() unless they explicitly want to (so
 * getActiveAssigneeIncapacitationTracker() is safely `undefined` by default).
 */
let activeInstance: AssigneeIncapacitationTracker | undefined;

export function setActiveAssigneeIncapacitationTracker(instance: AssigneeIncapacitationTracker | undefined): void {
  activeInstance = instance;
}

export function getActiveAssigneeIncapacitationTracker(): AssigneeIncapacitationTracker | undefined {
  return activeInstance;
}
