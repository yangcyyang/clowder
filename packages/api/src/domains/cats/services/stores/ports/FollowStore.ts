/**
 * Follow Store (batch 3-D / docs/research/clowder-raft-thread-task-design.md
 * §1 + §5B.3 + §3 step 2 "follow + Activity"):
 *
 * Raft notification discipline: "参与/被 @ 自动 follow 该 thread → 新回复进
 * Activity + ping；做完 unfollow" / "DM 必 ping、follow 的 thread 回复 ping、
 * 被 @ ping，其余进 Activity。"
 *
 * Human side only for this batch ("先做人类侧"). `userId` is deliberately a
 * bare string (not a branded HumanUserId type) so a future cat-side follow
 * (e.g. a cat auto-following a task thread it claimed) can reuse the exact
 * same methods without a shape change — no cat wiring exists yet, this is
 * just leaving the door open per the task brief.
 */

export type FollowReason = 'participant' | 'mention' | 'manual';

export interface FollowRecord {
  userId: string;
  threadId: string;
  reason: FollowReason;
  followedAt: number;
}

export interface IFollowStore {
  /**
   * Idempotent: a no-op (returns false) if already following. The reason
   * recorded is whichever one first caused the follow — later calls never
   * downgrade/overwrite it.
   * Returns true if this call newly created the follow record.
   */
  follow(userId: string, threadId: string, reason: FollowReason): boolean | Promise<boolean>;
  /** Returns true if a follow record existed and was removed. */
  unfollow(userId: string, threadId: string): boolean | Promise<boolean>;
  isFollowing(userId: string, threadId: string): boolean | Promise<boolean>;
  /** All thread ids this user currently follows (order unspecified). */
  listFollowedThreadIds(userId: string): string[] | Promise<string[]>;
  /**
   * When this user started following threadId, or null if not following.
   * Used to bound "unread since" for threads that have no read-state cursor yet
   * (e.g. a long-lived thread the user was just auto-followed into) — without
   * this, a missing cursor would otherwise read as "everything is unread".
   */
  getFollowedAt(userId: string, threadId: string): number | null | Promise<number | null>;
  /** Cascade cleanup: called on thread soft-delete so no follower record lingers. */
  deleteByThread(threadId: string): Promise<void>;
}
