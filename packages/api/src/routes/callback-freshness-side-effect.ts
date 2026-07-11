import { createHash } from 'node:crypto';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ThreadAppendWatermark } from '../domains/cats/services/stores/ports/MessageStore.js';

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
