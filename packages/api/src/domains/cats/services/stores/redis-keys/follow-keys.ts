/**
 * Redis key patterns for thread follow records (batch 3-D).
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const FollowKeys = {
  /** Hash: follow:{userId}:{threadId} → { reason, followedAt } */
  entry: (userId: string, threadId: string) => `follow:${userId}:${threadId}`,
  /** Set: follow-index:{userId} → thread ids the user follows (hot path for feed listing). */
  userIndex: (userId: string) => `follow-index:${userId}`,
  /** Pattern for cascade cleanup on thread soft-delete: follow:*:{threadId} */
  threadPattern: (threadId: string) => `follow:*:${threadId}`,
} as const;
