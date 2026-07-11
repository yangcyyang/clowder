import { createHash } from 'node:crypto';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ThreadAppendWatermark } from '../domains/cats/services/stores/ports/MessageStore.js';

export type CallbackSideEffectClaim =
  | { outcome: 'legacy' | 'authorized' }
  | { outcome: 'replayed'; response: CallbackSideEffectResponse }
  | { outcome: 'stale'; response: CallbackSideEffectResponse };

export interface CallbackSideEffectResponse {
  status: 'duplicate' | 'freshness_retry_required';
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
  record: InvocationRecord;
  route: string;
  requestBody: unknown;
}): Promise<CallbackSideEffectClaim> {
  const { freshnessGate, record } = input;
  if (!freshnessGate || record.freshnessBaseline === undefined) return { outcome: 'legacy' };

  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(input.requestBody)))
    .digest('hex');
  const result = await freshnessGate.claimSideEffect({
    invocationId: record.invocationId,
    submissionKey: `${input.route}:${digest}`,
    userId: record.userId,
    catId: record.catId,
    threadId: record.threadId,
    baselineWatermark: record.freshnessBaseline as ThreadAppendWatermark,
  });

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
  return { outcome: 'authorized' };
}
