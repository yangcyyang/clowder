/**
 * Provider Error Classification — batch 3-B, item 2.
 * Maka absorption #4 (docs/research/maka-absorption.md §3): "结构化码优先分级，
 * 仅特定类触发确定性恢复" — structured evidence is graded before free text,
 * and only the classes explicitly whitelisted elsewhere (AutoRetryScheduler)
 * are allowed to trigger deterministic recovery. This module only classifies
 * and presents; it never performs recovery itself.
 *
 * Priority order (first match wins — mirrors runtime-runner.ts's dispatch table):
 *   1. aborted            — explicit abort/cancel signal (structured flag first, text second)
 *   2. quota              — HTTP 402/429 (structured) or quota/rate-limit wording (text)
 *   3. context_overflow   — structured context-length signal (not yet threaded end-to-end,
 *                           see follow-up note below) or the existing invoke-helpers.ts
 *                           text heuristics (reused, not re-implemented, to avoid drift)
 *   4. transient_network  — Node network error codes / 5xx (structured) or
 *                           ECONNRESET-shaped text (text)
 *   5. cli_stall          — R8-1/R8-2 (docs/research/reliability-raft-round8-absorption.md
 *                           §二): the CLI stream idle watchdog (utils/cli-spawn.ts) killed
 *                           the child because no stdout/stderr data arrived for too long.
 *                           Checked before cli_crash — it is a more specific, known cause
 *                           of the same "process died on us" shape.
 *   6. output_truncated   — R8-2: CLI reported an explicit output-length/truncation signal.
 *                           NOTE (coverage honesty — see report): as of this batch, no
 *                           provider in this repo is confirmed to surface such a signal on
 *                           its *failure* path (Anthropic API's stop_reason:'max_tokens' and
 *                           ACP's AcpStopReason:'max_tokens' both exist, but both codepaths
 *                           treat them as normal successful completions, never as a failure
 *                           string reaching this classifier). This tier + pattern is added
 *                           per "识别不了的不猜，先占位" as a receiving slot for the day a
 *                           provider's failure text does mention truncation — it does not
 *                           claim any provider triggers it today.
 *   7. cli_crash          — non-zero exit code / signal-kill with no usable output
 *   8. agent_error        — fallback bucket for everything else
 *
 * Follow-up (not done in this batch — would require touching each
 * providers/*AgentService.ts's error-handling code, deferred to keep this
 * batch's blast radius to files outside 3-A/3-C's active edits):
 * thread the raw `{__cliError, exitCode, signal}` / `{__cliTimeout}` objects
 * from utils/cli-spawn.ts through to this classifier instead of only the
 * flattened `AgentMessage.error` string, so exitCode/signal/httpStatus are
 * always structured evidence rather than falling back to regex.
 */

import {
  isContextWindowOverflowError,
  isPromptTokenLimitExceededError,
  isTransientAcpPromptFailure,
} from './invoke-helpers.js';

export type ProviderErrorClassificationKind =
  | 'aborted'
  | 'quota'
  | 'context_overflow'
  | 'transient_network'
  | 'cli_stall'
  | 'output_truncated'
  | 'cli_crash'
  | 'agent_error';

/**
 * Structured evidence about a provider/CLI failure, when available. All
 * fields are optional — a caller with only a flattened error string (the
 * common case today, see follow-up note above) can supply just `message`;
 * classification still runs, just at the text-regex tier instead of the
 * structured tier.
 */
export interface ProviderErrorEvidence {
  /** Free-text error message (already flattened by the caller, if that's all that's available). */
  readonly message?: string;
  /** True when the failure is a direct result of an AbortSignal firing (user cancel, thread delete, retry superseded). Highest-priority structured signal. */
  readonly aborted?: boolean;
  /** HTTP status code from the provider's own response, when the transport surfaced one. */
  readonly httpStatus?: number;
  /** CLI child process exit code (utils/cli-spawn.ts `__cliError.exitCode`). `null` = killed by signal, not a normal exit. */
  readonly exitCode?: number | null;
  /** CLI child process kill signal (utils/cli-spawn.ts `__cliError.signal`). */
  readonly signal?: string | null;
  /** Node.js system error code, e.g. 'ECONNRESET' / 'ETIMEDOUT' / 'ECONNREFUSED' (`err.code` on network failures). */
  readonly nodeErrorCode?: string;
  /** True when the CLI produced no usable stdout/NDJSON events before dying — the "silent crash" signature that separates cli_crash from a network blip. Defaults to true (unknown = assume no output) when omitted, since most callers today can't report this yet. */
  readonly emptyOutput?: boolean;
  /** R8-1: true when utils/cli-spawn.ts's stdout/stderr idle watchdog killed the child (CliSpawnOptions.idleTimeoutMs / CLOWDER_CLI_IDLE_TIMEOUT_SEC — see `__cliTimeout.idleWatchdogKill`). Highest-priority structured signal for `cli_stall`. */
  readonly idleWatchdogKill?: boolean;
  /** R8-2: true when a caller has structured evidence that the CLI's output was truncated (max-tokens/length limit). No current caller sets this — see module doc's coverage note; kept for future callers with richer signal. */
  readonly outputTruncated?: boolean;
}

export interface ProviderErrorClassification {
  readonly kind: ProviderErrorClassificationKind;
  /** Which evidence tier produced this classification — audit/debug only, never used for decisions. */
  readonly evidence: 'structured' | 'text' | 'none';
  /** Short human-readable reason, preserved for terminal event detail / API presentation. */
  readonly reason: string;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const ABORT_TEXT_PATTERN = /\b(AbortError|aborted|user[_-]?cancel(?:ed|led)?)\b/i;
const QUOTA_TEXT_PATTERN = /(quota|rate[- ]?limit|usage limit|too many requests|insufficient_quota|billing|配额|额度)/i;
const NETWORK_TEXT_PATTERN = /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|network error|fetch failed)/i;
/** R8-1: matches utils/cli-spawn.ts's `cli stream idle timeout after <N>s` (idleWatchdogKill) wording — see that module's comment for the wording discipline. */
const CLI_STALL_TEXT_PATTERN = /cli stream idle timeout/i;
/** R8-2: no confirmed current producer — see module doc coverage note. Generic enough to catch future provider text without being so broad it swallows unrelated errors. */
const OUTPUT_TRUNCATED_TEXT_PATTERN =
  /(max[_-]?output[_-]?tokens|output[- ]?truncated|response[- ]?truncated|truncated (?:due to|because of) (?:length|max[_-]?tokens|token limit)|finish_reason["'\s:]*["']?length)/i;
const CLI_EXIT_TEXT_PATTERN = /CLI 异常退出 \(code:\s*(?:\d+|null)(?:,\s*signal:\s*[^)]+)?\)/i;

/**
 * Classify a provider/CLI failure. Structured evidence (aborted flag,
 * httpStatus, nodeErrorCode, exitCode/signal) is always checked before any
 * regex on `message` — see module doc for the full priority order.
 */
export function classifyProviderError(evidence: ProviderErrorEvidence): ProviderErrorClassification {
  const message = evidence.message?.trim();

  // 1) Explicit abort/cancel — highest-priority structured signal.
  if (evidence.aborted) {
    return { kind: 'aborted', evidence: 'structured', reason: 'abort_signal' };
  }
  if (message && ABORT_TEXT_PATTERN.test(message)) {
    return { kind: 'aborted', evidence: 'text', reason: message };
  }

  // 2) Quota / budget exhaustion — structured HTTP status first.
  if (evidence.httpStatus === 402 || evidence.httpStatus === 429) {
    return { kind: 'quota', evidence: 'structured', reason: `http_${evidence.httpStatus}` };
  }
  if (message && QUOTA_TEXT_PATTERN.test(message)) {
    return { kind: 'quota', evidence: 'text', reason: message };
  }

  // 3) Context-length overflow — reuse the existing, already-battle-tested
  //    invoke-helpers.ts predicates instead of re-deriving overlapping regex.
  if (message && (isContextWindowOverflowError(message) || isPromptTokenLimitExceededError(message))) {
    return { kind: 'context_overflow', evidence: 'text', reason: message };
  }

  // 4) Transient network failure.
  if (evidence.nodeErrorCode && NETWORK_ERROR_CODES.has(evidence.nodeErrorCode)) {
    return { kind: 'transient_network', evidence: 'structured', reason: evidence.nodeErrorCode };
  }
  if (evidence.httpStatus !== undefined && evidence.httpStatus >= 500) {
    return { kind: 'transient_network', evidence: 'structured', reason: `http_${evidence.httpStatus}` };
  }
  if (message && (isTransientAcpPromptFailure(message) || NETWORK_TEXT_PATTERN.test(message))) {
    return { kind: 'transient_network', evidence: 'text', reason: message };
  }

  // 5) CLI stream idle watchdog (R8-1) — structured flag first, then the
  //    literal wording utils/cli-spawn.ts emits when it fires.
  if (evidence.idleWatchdogKill) {
    return { kind: 'cli_stall', evidence: 'structured', reason: 'idle_watchdog_kill' };
  }
  if (message && CLI_STALL_TEXT_PATTERN.test(message)) {
    return { kind: 'cli_stall', evidence: 'text', reason: message };
  }

  // 6) Output truncated (R8-2) — no confirmed current producer, see module doc.
  if (evidence.outputTruncated) {
    return { kind: 'output_truncated', evidence: 'structured', reason: 'output_truncated' };
  }
  if (message && OUTPUT_TRUNCATED_TEXT_PATTERN.test(message)) {
    return { kind: 'output_truncated', evidence: 'text', reason: message };
  }

  // 7) CLI crash: non-zero exit / signal-kill, no usable output.
  const hasAbnormalExit =
    (evidence.exitCode !== undefined && evidence.exitCode !== null && evidence.exitCode !== 0) ||
    Boolean(evidence.signal);
  if (hasAbnormalExit && evidence.emptyOutput !== false) {
    return {
      kind: 'cli_crash',
      evidence: 'structured',
      reason: `exit_${evidence.exitCode ?? 'null'}${evidence.signal ? `_signal_${evidence.signal}` : ''}`,
    };
  }
  if (message && CLI_EXIT_TEXT_PATTERN.test(message)) {
    return { kind: 'cli_crash', evidence: 'text', reason: message };
  }

  // 8) Fallback.
  if (message) {
    return { kind: 'agent_error', evidence: 'text', reason: message };
  }
  return { kind: 'agent_error', evidence: 'none', reason: 'unclassified' };
}

/** Convenience wrapper for the common case of only having a flattened error string. */
export function classifyProviderErrorText(message: string): ProviderErrorClassification {
  return classifyProviderError({ message });
}

/**
 * Whitelist consumed by AutoRetryScheduler (batch 3-B, item 3). Kept here,
 * next to the classification table, so the whitelist can never drift out of
 * sync with the kinds this module actually produces.
 *
 * R8-2 (docs/research/reliability-raft-round8-absorption.md §二): extended with
 * cli_stall + output_truncated — both are infra-caused, not agent-authored, the
 * same rationale that already justified transient_network/cli_crash. Only takes
 * effect when CLOWDER_AUTO_RETRY is explicitly turned on (default off).
 */
export const AUTO_RETRY_WHITELIST: ReadonlySet<ProviderErrorClassificationKind> = new Set([
  'transient_network',
  'cli_crash',
  'cli_stall',
  'output_truncated',
]);

export function isAutoRetryEligible(kind: ProviderErrorClassificationKind): boolean {
  return AUTO_RETRY_WHITELIST.has(kind);
}

/**
 * Mirrors `TaskFailureClass` from packages/shared/src/types/task.ts (7
 * values: agent_error/build_failed/test_failed/timeout/budget_exhausted/
 * infra_error/manual_fail). Not imported directly: that type isn't
 * re-exported from packages/shared/src/types/index.ts's public barrel as of
 * this batch, and packages/shared is outside packages/api's edit scope for
 * batch 3-B (it's also mid-edit by the parallel 3-A batch). Kept as an
 * identical literal union so it stays structurally assignable to the real
 * TaskFailureClass wherever a future caller bridges into the Task system.
 */
export type TaskFailureClassMirror =
  | 'agent_error'
  | 'build_failed'
  | 'test_failed'
  | 'timeout'
  | 'budget_exhausted'
  | 'infra_error'
  | 'manual_fail';

/**
 * Map a classification kind onto the existing 7-value TaskFailureClass enum
 * for anything that bridges into the Task system. `context_overflow` has no
 * dedicated slot in that enum — it maps to 'infra_error', with the real
 * classification preserved verbatim in the terminal event's
 * `detail.classificationReason` for anyone reading the raw InvocationRecord.
 */
export function toTaskFailureClass(kind: ProviderErrorClassificationKind): TaskFailureClassMirror {
  switch (kind) {
    case 'quota':
      return 'budget_exhausted';
    case 'transient_network':
    case 'cli_crash':
    case 'context_overflow':
    case 'cli_stall':
    case 'output_truncated':
      return 'infra_error';
    case 'aborted':
      // Closest existing semantic: an explicit signal ended the run, not an
      // agent bug — 'manual_fail' is the least-wrong bucket in the current enum.
      return 'manual_fail';
    case 'agent_error':
    default:
      return 'agent_error';
  }
}
