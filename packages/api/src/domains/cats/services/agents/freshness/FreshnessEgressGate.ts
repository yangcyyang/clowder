/**
 * Freshness Egress Gate
 *
 * The only domain entry point allowed to turn an invocation draft into a
 * formal message. MessageStore owns the atomic compare+append primitive;
 * FreshnessHoldStore owns the recoverable review state machine.
 */

import type { CatId } from '@cat-cafe/shared';
import type {
  FreshnessHeldDraft,
  FreshnessHoldRecord,
  IFreshnessHoldStore,
} from '../../stores/ports/FreshnessHoldStore.js';
import type {
  AppendMessageInput,
  FreshnessDelta,
  IMessageStore,
  StoredMessage,
  ThreadAppendWatermark,
} from '../../stores/ports/MessageStore.js';

const DEFAULT_MAX_DELTA_MESSAGES = 50;
const DEFAULT_REVIEW_WINDOW_MS = 30 * 60 * 1000;

export interface FreshnessSubmitInput {
  invocationId: string;
  submissionKey: string;
  userId: string;
  catId: CatId;
  threadId: string;
  baselineWatermark: ThreadAppendWatermark;
  draft: AppendMessageInput;
  now?: number;
}

export type FreshnessSubmitResult =
  | { outcome: 'published'; message: StoredMessage }
  | { outcome: 'held'; hold: FreshnessHoldRecord; delta: FreshnessDelta };

export interface FreshnessReviewInput {
  holdId: string;
  expectedVersion: number;
  action: 'send_draft' | 'replace' | 'discard';
  replacementDraft?: AppendMessageInput;
  invocationId?: string;
  userId?: string;
  catId?: CatId;
  threadId?: string;
  now?: number;
}

export type FreshnessReviewResult =
  | { outcome: 'published'; message: StoredMessage; hold: FreshnessHoldRecord }
  | { outcome: 'held'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'needs_attention'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'discarded'; hold: FreshnessHoldRecord };

export interface FreshnessEgressGateOptions {
  messageStore: IMessageStore;
  holdStore: IFreshnessHoldStore;
  maxDeltaMessages?: number;
  reviewWindowMs?: number;
}

export class FreshnessEgressGate {
  private readonly messageStore: IMessageStore;
  private readonly holdStore: IFreshnessHoldStore;
  private readonly maxDeltaMessages: number;
  private readonly reviewWindowMs: number;

  constructor(options: FreshnessEgressGateOptions) {
    this.messageStore = options.messageStore;
    this.holdStore = options.holdStore;
    this.maxDeltaMessages = this.positiveInteger(options.maxDeltaMessages, DEFAULT_MAX_DELTA_MESSAGES);
    this.reviewWindowMs = this.positiveInteger(options.reviewWindowMs, DEFAULT_REVIEW_WINDOW_MS);
  }

  async submit(input: FreshnessSubmitInput): Promise<FreshnessSubmitResult> {
    const audience = { kind: 'cat' as const, catId: input.catId };
    const draft: AppendMessageInput = {
      ...input.draft,
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
    };
    const appendResult = await this.messageStore.appendIfFresh(draft, {
      baseline: input.baselineWatermark,
      audience,
    });
    if (appendResult.outcome === 'appended') {
      return { outcome: 'published', message: appendResult.message };
    }

    const delta = await this.messageStore.getFreshnessDelta(
      input.threadId,
      audience,
      input.baselineWatermark,
      appendResult.observedWatermark,
      this.maxDeltaMessages,
    );
    const now = input.now ?? Date.now();
    const created = await this.holdStore.createOrGet({
      invocationId: input.invocationId,
      submissionKey: input.submissionKey,
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
      baselineWatermark: input.baselineWatermark,
      observedWatermark: appendResult.observedWatermark,
      deltaMessageIds: delta.messages.map((message) => message.id),
      draft: structuredClone(draft) as FreshnessHeldDraft,
      createdAt: now,
      reviewDeadlineAt: now + this.reviewWindowMs,
    });

    if (created.outcome === 'created') {
      return { outcome: 'held', hold: created.hold, delta };
    }

    // A transport retry must replay the original hold context, not reinterpret
    // the same submission against messages that arrived later.
    const replayDelta = await this.messageStore.getFreshnessDelta(
      created.hold.threadId,
      { kind: 'cat', catId: created.hold.catId },
      created.hold.baselineWatermark as ThreadAppendWatermark,
      created.hold.observedWatermark as ThreadAppendWatermark,
      this.maxDeltaMessages,
    );
    return { outcome: 'held', hold: created.hold, delta: replayDelta };
  }

  async review(input: FreshnessReviewInput): Promise<FreshnessReviewResult> {
    const existing = await this.holdStore.get(input.holdId);
    if (!existing) throw new Error(`Freshness hold not found: ${input.holdId}`);
    if (
      (input.invocationId && existing.invocationId !== input.invocationId) ||
      (input.userId && existing.userId !== input.userId) ||
      (input.catId && existing.catId !== input.catId) ||
      (input.threadId && existing.threadId !== input.threadId)
    ) {
      throw new Error('Freshness hold ownership mismatch');
    }
    const now = input.now ?? Date.now();

    if (input.action === 'discard') {
      const discarded = await this.holdStore.discard(input.holdId, {
        expectedVersion: input.expectedVersion,
        now,
      });
      if (!discarded) throw new Error('Freshness hold version conflict');
      return { outcome: 'discarded', hold: discarded };
    }

    const claimed = await this.holdStore.claimReview(input.holdId, {
      expectedVersion: input.expectedVersion,
      now,
    });
    if (!claimed) {
      const latest = await this.holdStore.get(input.holdId);
      if (latest?.status === 'needs_attention') {
        const delta = await this.deltaForHold(latest);
        return { outcome: 'needs_attention', hold: latest, delta };
      }
      throw new Error('Freshness hold version conflict');
    }

    if (input.action === 'replace' && !input.replacementDraft) {
      throw new Error('replacementDraft is required for replace');
    }
    const selectedDraft =
      input.action === 'replace' ? input.replacementDraft! : (claimed.draft as unknown as AppendMessageInput);
    const heldDraft: AppendMessageInput = {
      ...selectedDraft,
      userId: claimed.userId,
      catId: claimed.catId,
      threadId: claimed.threadId,
    };
    const publishDraft: AppendMessageInput = {
      ...heldDraft,
      timestamp: now,
      idempotencyKey: `freshness-hold:${claimed.id}`,
    };
    const audience = { kind: 'cat' as const, catId: claimed.catId };
    const appendResult = await this.messageStore.appendIfFresh(publishDraft, {
      baseline: claimed.observedWatermark as ThreadAppendWatermark,
      audience,
    });

    if (appendResult.outcome === 'appended') {
      const released = await this.holdStore.release(claimed.id, {
        expectedVersion: claimed.version,
        messageId: appendResult.message.id,
        committedWatermark: appendResult.committedWatermark,
        now,
      });
      if (!released) {
        // The message append is idempotent. A retry will recover the same
        // message and finish this CAS transition rather than double-publish.
        throw new Error('Freshness hold release version conflict');
      }
      return { outcome: 'published', message: appendResult.message, hold: released };
    }

    const delta = await this.messageStore.getFreshnessDelta(
      claimed.threadId,
      audience,
      claimed.observedWatermark as ThreadAppendWatermark,
      appendResult.observedWatermark,
      this.maxDeltaMessages,
    );
    const reheld = await this.holdStore.rehold(claimed.id, {
      expectedVersion: claimed.version,
      observedWatermark: appendResult.observedWatermark,
      deltaMessageIds: delta.messages.map((message) => message.id),
      draft: structuredClone(heldDraft) as FreshnessHeldDraft,
      now,
    });
    if (!reheld) throw new Error('Freshness hold rehold version conflict');
    return {
      outcome: reheld.status === 'needs_attention' ? 'needs_attention' : 'held',
      hold: reheld,
      delta,
    };
  }

  private async deltaForHold(hold: FreshnessHoldRecord): Promise<FreshnessDelta> {
    return this.messageStore.getFreshnessDelta(
      hold.threadId,
      { kind: 'cat', catId: hold.catId },
      hold.baselineWatermark as ThreadAppendWatermark,
      hold.observedWatermark as ThreadAppendWatermark,
      this.maxDeltaMessages,
    );
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
  }
}
