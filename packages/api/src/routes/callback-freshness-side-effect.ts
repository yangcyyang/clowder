import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, ThreadAppendWatermark } from '../domains/cats/services/stores/ports/MessageStore.js';

export type CallbackSideEffectClaim =
  | { outcome: 'legacy' }
  | { outcome: 'authorized'; abort: () => Promise<void> }
  | { outcome: 'replayed'; response: CallbackSideEffectResponse }
  | { outcome: 'stale'; response: CallbackSideEffectResponse };

export interface CallbackSideEffectResponse {
  status: 'duplicate' | 'freshness_retry_required' | 'stale_ignored';
  disposition: 'published' | 'held';
  threadId: string;
  retryRequired?: true;
  baselineWatermark?: ThreadAppendWatermark;
  observedWatermark?: ThreadAppendWatermark;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * Linearizes a protected callback before its first externally visible write.
 * The digest keeps callback content out of Redis keys while making retries stable.
 */
export async function claimCallbackSideEffect(input: {
  freshnessGate?: FreshnessEgressGate;
  registry: Pick<
    import('../domains/cats/services/agents/invocation/InvocationRegistry.js').InvocationRegistry,
    'isLatest'
  >;
  record: InvocationRecord;
  route: string;
  requestBody: unknown;
}): Promise<CallbackSideEffectClaim> {
  const { freshnessGate, record } = input;
  if (!freshnessGate || record.freshnessBaseline === undefined) return { outcome: 'legacy' };

  if (!(await input.registry.isLatest(record.invocationId))) {
    return {
      outcome: 'stale',
      response: { status: 'stale_ignored', disposition: 'held', threadId: record.threadId },
    };
  }

  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(input.requestBody)))
    .digest('hex');
  const claimInput = {
    invocationId: record.invocationId,
    submissionKey: `${input.route}:${digest}`,
    userId: record.userId,
    catId: record.catId,
    threadId: record.threadId,
    baselineWatermark: record.freshnessBaseline as ThreadAppendWatermark,
  };
  const result = await freshnessGate.claimSideEffect(claimInput);

  if (result.outcome === 'stale') {
    return {
      outcome: 'stale',
      response: {
        status: 'freshness_retry_required',
        disposition: 'held',
        threadId: record.threadId,
        retryRequired: true,
        baselineWatermark: result.baselineWatermark,
        observedWatermark: result.observedWatermark,
      },
    };
  }
  if (result.replayed) {
    return {
      outcome: 'replayed',
      response: { status: 'duplicate', disposition: 'published', threadId: record.threadId },
    };
  }
  return { outcome: 'authorized', abort: () => freshnessGate.abortSideEffect(claimInput) };
}

export interface FreshnessHoldDelta {
  /** Freshness-relevant messages this cat hasn't seen yet, up to `limit` (default 50). */
  unreadCount: number;
  /** Newest unread message id — a caller can `message read --around` it before retrying. */
  latestMessageId?: string;
  /** True when `unreadCount` undercounts because more unread messages exist past `limit`. */
  truncated: boolean;
}

/**
 * [thread-task-design] §5.3 point 3 / §5B.4: "claim/提交时如有未读新消息，先拦下让 agent
 * 看完再重试". claimCallbackSideEffect's 'stale' outcome already carries this hold/retry
 * signal, but only as opaque watermark revisions — not enough for a caller to know *what*
 * to inject before retrying. This reads the concrete delta (count + latest id) off the
 * same appendWatermark/msg:freshness mechanism MessageStore already uses to compute
 * staleness, so the hold signal is actionable instead of a blind "try again".
 *
 * Not yet wired into a route: the intended call site is callback-task-routes.ts's
 * claim-task/task-claim handlers (`if (freshness.outcome === 'stale') return await
 * withFreshnessHoldDelta(freshness, { messageStore, catId: actor.catId });`), but that
 * file had a large concurrent in-flight edit (batch 2-C, dual-auth task-* endpoints) at
 * the time this was written, so the integration step is left for a follow-up pass.
 */
export async function describeFreshnessHoldDelta(input: {
  messageStore: Pick<IMessageStore, 'getFreshnessDelta'>;
  catId: CatId;
  threadId: string;
  baselineWatermark: ThreadAppendWatermark;
  observedWatermark: ThreadAppendWatermark;
  limit?: number;
}): Promise<FreshnessHoldDelta> {
  const delta = await input.messageStore.getFreshnessDelta(
    input.threadId,
    { kind: 'cat', catId: input.catId },
    input.baselineWatermark,
    input.observedWatermark,
    input.limit,
  );
  const latest = delta.messages[delta.messages.length - 1];
  return {
    unreadCount: delta.messages.length,
    ...(latest ? { latestMessageId: latest.id } : {}),
    truncated: delta.truncated,
  };
}

/**
 * Convenience wrapper for the common call shape: given claimCallbackSideEffect's 'stale'
 * result, return its response enriched with the freshness delta. Falls back to the bare
 * response (unreadCount: 0) if the watermarks are missing — this should not happen for a
 * genuinely 'stale' outcome, but staying defensive keeps this a pure additive enrichment
 * that can never throw where the un-enriched response would have succeeded.
 */
export async function withFreshnessHoldDelta(
  stale: Extract<CallbackSideEffectClaim, { outcome: 'stale' }>,
  input: { messageStore: Pick<IMessageStore, 'getFreshnessDelta'>; catId: CatId; limit?: number },
): Promise<CallbackSideEffectResponse & Partial<FreshnessHoldDelta>> {
  const { baselineWatermark, observedWatermark, threadId } = stale.response;
  if (baselineWatermark === undefined || observedWatermark === undefined) {
    return stale.response;
  }
  try {
    const delta = await describeFreshnessHoldDelta({
      messageStore: input.messageStore,
      catId: input.catId,
      threadId,
      baselineWatermark,
      observedWatermark,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return { ...stale.response, ...delta };
  } catch {
    // Enrichment is best-effort; a broken delta lookup must not break the hold response.
    return stale.response;
  }
}
