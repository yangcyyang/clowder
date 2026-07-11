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
  | { outcome: 'published'; message: StoredMessage; replayed?: true }
  | { outcome: 'held'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'needs_attention'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'discarded'; hold: FreshnessHoldRecord };

export interface FreshnessReviewInput {
  holdId: string;
  expectedVersion: number;
  action: 'send_draft' | 'replace' | 'discard';
  replacementDraft?: AppendMessageInput;
  invocationId: string;
  userId: string;
  catId: CatId;
  threadId: string;
  now?: number;
}

export type FreshnessReviewResult =
  | { outcome: 'published'; message: StoredMessage; hold: FreshnessHoldRecord; replayed?: true }
  | { outcome: 'held'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'needs_attention'; hold: FreshnessHoldRecord; delta: FreshnessDelta }
  | { outcome: 'discarded'; hold: FreshnessHoldRecord };

export interface FreshnessEgressGateOptions {
  messageStore: IMessageStore;
  holdStore: IFreshnessHoldStore;
  maxDeltaMessages?: number;
  reviewWindowMs?: number;
  isEnabledFor?: (threadId: string, catId: CatId) => boolean;
}

export class FreshnessEgressGate {
  private readonly messageStore: IMessageStore;
  private readonly holdStore: IFreshnessHoldStore;
  private readonly maxDeltaMessages: number;
  private readonly reviewWindowMs: number;
  private readonly enabledForPolicy: (threadId: string, catId: CatId) => boolean;

  constructor(options: FreshnessEgressGateOptions) {
    this.messageStore = options.messageStore;
    this.holdStore = options.holdStore;
    this.maxDeltaMessages = this.positiveInteger(options.maxDeltaMessages, DEFAULT_MAX_DELTA_MESSAGES);
    this.reviewWindowMs = this.positiveInteger(options.reviewWindowMs, DEFAULT_REVIEW_WINDOW_MS);
    this.enabledForPolicy = options.isEnabledFor ?? (() => true);
  }

  isEnabledFor(threadId: string, catId: CatId): boolean {
    return this.enabledForPolicy(threadId, catId);
  }

  /**
   * Create an invocation-scoped gate after the router has already selected a
   * protected route. Stores and limits remain shared; rollout checks no longer
   * change underneath that route while it is running.
   */
  forProtectedRoute(): FreshnessEgressGate {
    return new FreshnessEgressGate({
      messageStore: this.messageStore,
      holdStore: this.holdStore,
      maxDeltaMessages: this.maxDeltaMessages,
      reviewWindowMs: this.reviewWindowMs,
      isEnabledFor: () => true,
    });
  }

  async submit(input: FreshnessSubmitInput): Promise<FreshnessSubmitResult> {
    if (!this.isEnabledFor(input.threadId, input.catId)) {
      return {
        outcome: 'published',
        message: await this.messageStore.append({
          ...input.draft,
          userId: input.userId,
          catId: input.catId,
          threadId: input.threadId,
        }),
      };
    }
    const audience = { kind: 'cat' as const, catId: input.catId };
    const existingHold = await this.holdStore.getBySubmission(input.invocationId, input.submissionKey);
    if (existingHold) return this.replaySubmission(existingHold);

    const draft: AppendMessageInput = {
      ...input.draft,
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
    };
    const appendResult = await this.messageStore.appendIfFresh(
      {
        ...draft,
        idempotencyKey: this.submitIdempotencyKey(input.invocationId, input.submissionKey),
      },
      {
        baseline: input.baselineWatermark,
        audience,
        groupId: draft.extra?.stream?.invocationId ?? input.invocationId,
      },
    );
    if (appendResult.outcome === 'appended') {
      return {
        outcome: 'published',
        message: appendResult.message,
        ...(appendResult.replayed ? { replayed: true as const } : {}),
      };
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
      observedWatermark: delta.observedWatermark,
      deltaMessageIds: delta.messages.map((message) => message.id),
      draft: structuredClone(draft) as FreshnessHeldDraft,
      createdAt: now,
      reviewDeadlineAt: now + this.reviewWindowMs,
    });

    if (created.outcome === 'created') {
      return { outcome: 'held', hold: created.hold, delta };
    }

    return this.replaySubmission(created.hold);
  }

  async getHold(holdId: string): Promise<FreshnessHoldRecord | null> {
    return this.holdStore.get(holdId);
  }

  async review(input: FreshnessReviewInput): Promise<FreshnessReviewResult> {
    const existing = await this.holdStore.get(input.holdId);
    if (!existing) throw new Error(`Freshness hold not found: ${input.holdId}`);
    this.assertReviewOwnership(existing, input);
    const now = input.now ?? Date.now();

    const terminalReplay = await this.replayTerminalReview(existing, now);
    if (terminalReplay) return terminalReplay;

    if (input.action === 'discard') {
      const discarded = await this.holdStore.discard(input.holdId, {
        expectedVersion: input.expectedVersion,
        now,
      });
      if (!discarded) throw new Error('Freshness hold version conflict');
      return { outcome: 'discarded', hold: discarded };
    }

    const claim = await this.claimOrRecoverReview(existing, input, now);
    if (claim.outcome === 'replayed') return claim.result;
    const claimed = claim.hold;
    const selectedDraft = this.selectReviewDraft(claimed, input);
    const heldDraft: AppendMessageInput = {
      ...selectedDraft,
      userId: claimed.userId,
      catId: claimed.catId,
      threadId: claimed.threadId,
    };
    return this.publishOrRehold(claimed, heldDraft, now);
  }

  private assertReviewOwnership(existing: FreshnessHoldRecord, input: FreshnessReviewInput): void {
    if (
      existing.invocationId !== input.invocationId ||
      existing.userId !== input.userId ||
      existing.catId !== input.catId ||
      existing.threadId !== input.threadId
    ) {
      throw new Error('Freshness hold ownership mismatch');
    }
  }

  private async claimOrRecoverReview(
    existing: FreshnessHoldRecord,
    input: FreshnessReviewInput,
    now: number,
  ): Promise<
    { outcome: 'claimed'; hold: FreshnessHoldRecord } | { outcome: 'replayed'; result: FreshnessReviewResult }
  > {
    if (existing.status === 'reviewing') {
      this.assertRecoverableReviewVersion(existing, input.expectedVersion);
      return { outcome: 'claimed', hold: existing };
    }

    const claimed = await this.holdStore.claimReview(input.holdId, {
      expectedVersion: input.expectedVersion,
      now,
    });
    if (claimed) return { outcome: 'claimed', hold: claimed };

    const latest = await this.holdStore.get(input.holdId);
    if (!latest) throw new Error(`Freshness hold not found: ${input.holdId}`);
    const terminalReplay = await this.replayTerminalReview(latest, now);
    if (terminalReplay) return { outcome: 'replayed', result: terminalReplay };
    this.assertRecoverableReviewVersion(latest, input.expectedVersion);
    return { outcome: 'claimed', hold: latest };
  }

  private assertRecoverableReviewVersion(hold: FreshnessHoldRecord, expectedVersion: number): void {
    if (hold.status !== 'reviewing' || (expectedVersion !== hold.version && expectedVersion !== hold.version - 1)) {
      throw new Error('Freshness hold version conflict');
    }
  }

  private selectReviewDraft(claimed: FreshnessHoldRecord, input: FreshnessReviewInput): AppendMessageInput {
    if (input.action !== 'replace') return claimed.draft as unknown as AppendMessageInput;
    if (!input.replacementDraft) throw new Error('replacementDraft is required for replace');
    return input.replacementDraft;
  }

  private async publishOrRehold(
    claimed: FreshnessHoldRecord,
    heldDraft: AppendMessageInput,
    now: number,
  ): Promise<FreshnessReviewResult> {
    const publishDraft: AppendMessageInput = {
      ...heldDraft,
      timestamp: now,
      idempotencyKey: `freshness-hold:${claimed.id}`,
      // Review publication is a two-store transition. Keep the message out of
      // history/fanout until the hold CAS succeeds.
      deliveryStatus: 'queued',
      freshnessReviewPublication: true,
    };
    const audience = { kind: 'cat' as const, catId: claimed.catId };
    const appendResult = await this.messageStore.appendIfFresh(publishDraft, {
      baseline: claimed.observedWatermark as ThreadAppendWatermark,
      audience,
      groupId: publishDraft.extra?.stream?.invocationId ?? claimed.invocationId,
    });

    if (appendResult.outcome === 'appended') {
      return this.releaseQueuedPublication(claimed, appendResult, now);
    }

    return this.reholdStalePublication(claimed, heldDraft, appendResult, audience, now);
  }

  private async releaseQueuedPublication(
    claimed: FreshnessHoldRecord,
    appendResult: Extract<Awaited<ReturnType<IMessageStore['appendIfFresh']>>, { outcome: 'appended' }>,
    now: number,
  ): Promise<FreshnessReviewResult> {
    const released = await this.holdStore.release(claimed.id, {
      expectedVersion: claimed.version,
      messageId: appendResult.message.id,
      committedWatermark: appendResult.committedWatermark,
      now,
    });
    if (released) {
      const delivered = await this.deliverReleasedMessage(released, now);
      return { outcome: 'published', message: delivered, hold: released };
    }

    const latest = await this.holdStore.get(claimed.id);
    if (latest?.status === 'released' && latest.releasedMessageId === appendResult.message.id) {
      const delivered = await this.deliverReleasedMessage(latest, now);
      return { outcome: 'published', message: delivered, hold: latest, replayed: true };
    }
    // Only a terminal state that cannot subsequently release this message
    // makes cancellation safe. A still-reviewing record may belong to the
    // concurrent winner using this same idempotent message.
    if (latest?.status === 'discarded' || latest?.status === 'needs_attention') {
      await this.messageStore.markCanceled(appendResult.message.id);
    }
    throw new Error('Freshness hold release version conflict');
  }

  private async reholdStalePublication(
    claimed: FreshnessHoldRecord,
    heldDraft: AppendMessageInput,
    appendResult: Extract<Awaited<ReturnType<IMessageStore['appendIfFresh']>>, { outcome: 'stale' }>,
    audience: { kind: 'cat'; catId: CatId },
    now: number,
  ): Promise<FreshnessReviewResult> {
    const delta = await this.messageStore.getFreshnessDelta(
      claimed.threadId,
      audience,
      claimed.observedWatermark as ThreadAppendWatermark,
      appendResult.observedWatermark,
      this.maxDeltaMessages,
    );
    const reheld = await this.holdStore.rehold(claimed.id, {
      expectedVersion: claimed.version,
      observedWatermark: delta.observedWatermark,
      deltaMessageIds: delta.messages.map((message) => message.id),
      draft: structuredClone(heldDraft) as FreshnessHeldDraft,
      now,
    });
    if (!reheld) {
      const latest = await this.holdStore.get(claimed.id);
      if (!latest) throw new Error(`Freshness hold not found: ${claimed.id}`);
      const latestTerminal = await this.replayTerminalReview(latest, now);
      if (latestTerminal) return latestTerminal;
      if (latest.status === 'held' || latest.status === 'reviewing') {
        return { outcome: 'held', hold: latest, delta: await this.deltaForHold(latest) };
      }
      throw new Error('Freshness hold rehold version conflict');
    }
    return {
      outcome: reheld.status === 'needs_attention' ? 'needs_attention' : 'held',
      hold: reheld,
      delta,
    };
  }

  private async replaySubmission(hold: FreshnessHoldRecord): Promise<FreshnessSubmitResult> {
    if (hold.status === 'released') {
      return {
        outcome: 'published',
        message: await this.deliverReleasedMessage(hold, Date.now()),
        replayed: true,
      };
    }
    if (hold.status === 'discarded') return { outcome: 'discarded', hold };
    const delta = await this.deltaForHold(hold);
    return {
      outcome: hold.status === 'needs_attention' ? 'needs_attention' : 'held',
      hold,
      delta,
    };
  }

  private async replayTerminalReview(hold: FreshnessHoldRecord, now: number): Promise<FreshnessReviewResult | null> {
    if (hold.status === 'released') {
      return {
        outcome: 'published',
        message: await this.deliverReleasedMessage(hold, now),
        hold,
        replayed: true,
      };
    }
    if (hold.status === 'discarded') return { outcome: 'discarded', hold };
    if (hold.status === 'needs_attention') {
      return { outcome: 'needs_attention', hold, delta: await this.deltaForHold(hold) };
    }
    return null;
  }

  private async deliverReleasedMessage(hold: FreshnessHoldRecord, now: number): Promise<StoredMessage> {
    if (!hold.releasedMessageId) throw new Error('Freshness hold released message id not found');
    let message = await this.messageStore.getByIdForFreshnessRelease(hold.releasedMessageId);
    if (!message) throw new Error('Freshness hold released message not found');
    if (message.deliveryStatus === 'queued') {
      message = await this.messageStore.releaseFreshnessReviewPublication(message.id, now);
    }
    if (!message || message.deliveryStatus === 'queued' || message.deliveryStatus === 'canceled') {
      throw new Error('Freshness hold released message could not be delivered');
    }
    if (message.deletedAt || message._tombstone) {
      throw new Error('Freshness hold released message is not publishable');
    }
    return message;
  }

  private async deltaForHold(hold: FreshnessHoldRecord): Promise<FreshnessDelta> {
    const messages = (
      await Promise.all(hold.deltaMessageIds.map((messageId) => this.messageStore.getById(messageId)))
    ).filter((message): message is StoredMessage => message !== null);
    return {
      observedWatermark: hold.observedWatermark as ThreadAppendWatermark,
      messages,
      truncated: false,
    };
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
  }

  private submitIdempotencyKey(invocationId: string, submissionKey: string): string {
    return `freshness-submit:${invocationId.length}:${invocationId}:${submissionKey}`;
  }
}
