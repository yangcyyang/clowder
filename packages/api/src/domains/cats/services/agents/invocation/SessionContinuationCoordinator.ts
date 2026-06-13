/**
 * SessionContinuationCoordinator owns continuation lifecycle.
 *
 * It keeps continuation logic out of QueueProcessor/messages routes:
 * - prepare: consume a pending capsule and prepend its continuation prompt
 * - commit: store newly produced capsules, or restore a consumed one on failure
 */

import { type CollaborationContinuityCapsuleV1, formatContinuationPrompt } from './CollaborationContinuityCapsule.js';

export type SessionStrategy = 'resume' | 'reborn';
type Awaitable<T> = T | Promise<T>;

export type InvocationFinalStatus = 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user';

export interface ConsumedContinuationToken {
  capsule: CollaborationContinuityCapsuleV1;
  threadId: string;
  catId: string;
  userId: string;
}

export interface PrepareInvocationInput {
  threadId: string;
  catId: string;
  userId: string;
  content: string;
}

export interface PrepareInvocationResult {
  content: string;
  consumedContinuation?: ConsumedContinuationToken;
  sessionPolicy: SessionStrategy;
}

export interface CommitInvocationInput {
  finalStatus: InvocationFinalStatus;
  threadId: string;
  catId: string;
  userId: string;
  consumedContinuation?: ConsumedContinuationToken;
  producedCapsules?: Iterable<CollaborationContinuityCapsuleV1>;
}

export interface SessionContinuationCoordinatorDeps {
  threadStore: {
    getMemberSessionStrategy(threadId: string, catId: string, userId: string): Awaitable<SessionStrategy | undefined>;
    consumePendingContinuation(
      threadId: string,
      catId: string,
      userId: string,
    ): Awaitable<CollaborationContinuityCapsuleV1 | null>;
    setPendingContinuation(
      threadId: string,
      catId: string,
      userId: string,
      capsule: CollaborationContinuityCapsuleV1,
    ): Awaitable<void>;
  };
}

export class SessionContinuationCoordinator {
  constructor(private readonly deps: SessionContinuationCoordinatorDeps) {}

  async resolveSessionStrategy(threadId: string, catId: string, userId: string): Promise<SessionStrategy> {
    return (await this.deps.threadStore.getMemberSessionStrategy(threadId, catId, userId)) ?? 'resume';
  }

  private async resolveSessionStrategyForCommit(
    threadId: string,
    catId: string,
    userId: string,
  ): Promise<SessionStrategy> {
    try {
      return await this.resolveSessionStrategy(threadId, catId, userId);
    } catch {
      // Losing the strategy lookup must not drop a continuation capsule.
      return 'resume';
    }
  }

  async prepareInvocationContext(input: PrepareInvocationInput): Promise<PrepareInvocationResult> {
    const { threadId, catId, userId, content } = input;
    const sessionPolicy = await this.resolveSessionStrategy(threadId, catId, userId);

    if (sessionPolicy === 'reborn') {
      return { content, sessionPolicy };
    }

    const capsule = await this.deps.threadStore.consumePendingContinuation(threadId, catId, userId);
    if (!capsule) {
      return { content, sessionPolicy };
    }

    const continuationPrompt = formatContinuationPrompt(capsule);
    return {
      content: content.startsWith(continuationPrompt) ? content : `${continuationPrompt}\n\n${content}`,
      consumedContinuation: { capsule, threadId, catId, userId },
      sessionPolicy,
    };
  }

  async commitInvocationOutcome(input: CommitInvocationInput): Promise<void> {
    const { finalStatus, userId, consumedContinuation, producedCapsules } = input;
    const produced = producedCapsules ? Array.from(producedCapsules) : [];
    let consumedSuperseded = false;

    for (const capsule of produced) {
      if (capsule.threadId !== input.threadId) {
        continue;
      }
      if ((await this.resolveSessionStrategyForCommit(capsule.threadId, capsule.catId, userId)) === 'reborn') {
        continue;
      }
      await this.deps.threadStore.setPendingContinuation(capsule.threadId, capsule.catId, userId, capsule);
      if (
        consumedContinuation &&
        capsule.threadId === consumedContinuation.threadId &&
        capsule.catId === consumedContinuation.catId
      ) {
        consumedSuperseded = true;
      }
    }

    if (consumedSuperseded || finalStatus === 'succeeded' || !consumedContinuation) {
      return;
    }

    if (
      (await this.resolveSessionStrategyForCommit(
        consumedContinuation.threadId,
        consumedContinuation.catId,
        consumedContinuation.userId,
      )) === 'reborn'
    ) {
      return;
    }

    await this.deps.threadStore.setPendingContinuation(
      consumedContinuation.threadId,
      consumedContinuation.catId,
      consumedContinuation.userId,
      consumedContinuation.capsule,
    );
  }
}
