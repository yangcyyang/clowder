/**
 * Auto-follow on participation/mention (batch 3-D, human side only).
 *
 * docs/research/clowder-raft-thread-task-design.md §3 step 2: "参与/被 @ 自动
 * follow 该 thread". Mirrors thread-reply-summary.ts's notifyBranchThreadReply
 * shape — a small, independently-testable function that index.ts's onAppend
 * composite listener calls fire-and-forget (branchReplyListener pattern), so
 * the append path itself never grows real logic.
 */

import type { FollowReason, IFollowStore } from '../domains/cats/services/stores/ports/FollowStore.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { SYSTEM_USER_IDS } from '../domains/cats/services/stores/visibility.js';

/**
 * Pure decision: does this message's author/target warrant an auto-follow,
 * and why? System/scheduler-authored messages never trigger a follow (no
 * real human to follow on behalf of).
 */
export function resolveAutoFollowReason(
  msg: Pick<StoredMessage, 'catId' | 'mentionsUser' | 'userId'>,
): FollowReason | null {
  if (SYSTEM_USER_IDS.has(msg.userId)) return null;
  if (msg.catId === null) return 'participant'; // human sent this message
  if (msg.mentionsUser) return 'mention'; // cat/connector message mentioning the human
  return null;
}

export interface AutoFollowDeps {
  followStore: IFollowStore;
  messageStore: Pick<IMessageStore, 'getById'>;
}

/**
 * Re-fetches the full StoredMessage (the composite onAppend callback only
 * carries id/threadId/timestamp/content) so this can read userId/catId/
 * mentionsUser without widening onAppend's Pick<> type across every store
 * implementation — same tradeoff notifyBranchThreadReply makes.
 */
export async function autoFollowOnAppend(
  deps: AutoFollowDeps,
  msg: { id: string },
): Promise<{ followed: boolean; reason?: FollowReason }> {
  const stored = await deps.messageStore.getById(msg.id);
  if (!stored) return { followed: false };
  const reason = resolveAutoFollowReason(stored);
  if (!reason) return { followed: false };
  const followed = await deps.followStore.follow(stored.userId, stored.threadId, reason);
  return { followed, reason };
}
