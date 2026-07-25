/**
 * Terminal Invariant — batch 3-B, item 1.
 * Maka absorption #2 (docs/research/maka-absorption.md §3, runtime-runner.ts
 * pattern): "终态必须由唯一不可变终止事实支撑，防悬空 running" — a terminal
 * InvocationStatus (succeeded/failed/canceled) must be backed by an
 * immutable termination fact recorded in the SAME atomic write as the status
 * transition, so a record can never look terminal without an auditable
 * reason attached.
 *
 * `TERMINAL_STATES` in invocation-state-machine.ts means something narrower
 * ("no further transitions allowed" — excludes 'failed', since failed→running
 * retry is legal). This module's `TERMINAL_INVOCATION_STATUSES` is the
 * business-terminal set the task brief means by "终态": succeeded/failed/canceled.
 *
 * Backward-compat note (see report for full rationale): most existing call
 * sites (QueueProcessor.ts, messages.ts, callback-a2a-trigger.ts, ...) are
 * out of this batch's edit scope (owned by parallel batches / too large a
 * blast radius for one batch) and do not pass an explicit `terminalEvent`.
 * To avoid breaking them, `resolveTerminalEvent` never blocks or downgrades
 * a succeeded/canceled transition — it synthesizes a benign implicit event
 * for those. The one case treated as a genuine anomaly worth flagging is
 * status='failed' with neither an explicit terminalEvent nor an `error`
 * string: that really is "terminal with zero evidence," so it's tagged
 * 'missing_terminal_event' (record.error is backfilled with the same label
 * only when the caller left it empty — never overwrites a real message).
 */

import {
  classifyProviderErrorText,
  type ProviderErrorClassificationKind,
} from '../../agents/invocation/provider-error-classification.js';

export type TerminalEventKind =
  | ProviderErrorClassificationKind
  | 'succeeded'
  | 'canceled_by_user'
  | 'canceled_system'
  | 'process_restart'
  | 'missing_terminal_event'
  /** Batch 3-E item 2: pre-run daily cost cap tripped — the run never spawned any process.
   *  Never auto-retry-eligible (not in provider-error-classification.ts's AUTO_RETRY_WHITELIST). */
  | 'budget_exhausted';

/** Immutable termination fact. Once written for a given terminal transition, it is never mutated. */
export interface TerminalEvent {
  readonly kind: TerminalEventKind;
  readonly at: number;
  readonly source: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

type TerminalInvocationStatus = 'succeeded' | 'failed' | 'canceled';

/** Statuses that must be "explained" by a terminal fact — the business-terminal set (see module doc). */
export const TERMINAL_INVOCATION_STATUSES: ReadonlySet<TerminalInvocationStatus> = new Set([
  'succeeded',
  'failed',
  'canceled',
]);

export function isTerminalInvocationStatus(status: string | undefined): status is TerminalInvocationStatus {
  return status !== undefined && TERMINAL_INVOCATION_STATUSES.has(status as TerminalInvocationStatus);
}

export function buildTerminalEvent(
  kind: TerminalEventKind,
  source: string,
  detail?: Record<string, unknown>,
  at: number = Date.now(),
): TerminalEvent {
  return { kind, at, source, ...(detail ? { detail } : {}) };
}

export interface ResolveTerminalEventInput {
  readonly status?: string;
  readonly error?: string;
  readonly terminalEvent?: TerminalEvent;
}

/**
 * Pure resolver shared by the in-memory and Redis InvocationRecordStore
 * implementations, so the invariant can't drift between the two backends.
 *
 * Returns `undefined` when the target status isn't business-terminal (no
 * invariant applies to this update). Otherwise always returns a TerminalEvent
 * to attach — explicit (caller-supplied), derived (classified from an error
 * string), or synthetic (benign implicit / missing_terminal_event).
 */
export function resolveTerminalEvent(input: ResolveTerminalEventInput, now: number = Date.now()): TerminalEvent | undefined {
  if (!isTerminalInvocationStatus(input.status)) return undefined;
  if (input.terminalEvent) return input.terminalEvent;

  if (input.status === 'succeeded') {
    return buildTerminalEvent('succeeded', 'legacy-implicit', undefined, now);
  }
  if (input.status === 'canceled') {
    return buildTerminalEvent('canceled_system', 'legacy-implicit', undefined, now);
  }

  // status === 'failed'
  const error = input.error?.trim();
  if (error) {
    const classification = classifyProviderErrorText(error);
    return buildTerminalEvent(
      classification.kind,
      'derived-from-error',
      { error, classificationEvidence: classification.evidence, classificationReason: classification.reason },
      now,
    );
  }

  // Maka pattern: a terminal 'failed' claim backed by nothing is itself the anomaly.
  return buildTerminalEvent('missing_terminal_event', 'invocation-record-store', { attemptedStatus: input.status }, now);
}
