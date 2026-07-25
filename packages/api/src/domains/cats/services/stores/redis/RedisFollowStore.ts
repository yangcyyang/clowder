/**
 * Redis implementation of FollowStore (batch 3-D).
 * Per-user/per-thread follow record — drives the Activity aggregated inbox.
 *
 * Data structures (mirrors RedisPushSubscriptionStore's dual-index shape):
 * - Hash follow:{userId}:{threadId} — { reason, followedAt }
 * - Set  follow-index:{userId}      — thread ids the user follows
 *
 * Cascade cleanup (deleteByThread) uses a SCAN over follow:*:{threadId} —
 * same approach as RedisThreadReadStateStore.deleteByThread — rather than a
 * third by-thread reverse index, since cleanup is a cold path (once per
 * thread soft-delete) while listing-by-user is the hot path (once per
 * Activity feed request).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FollowReason, IFollowStore } from '../ports/FollowStore.js';
import { FollowKeys } from '../redis-keys/follow-keys.js';

export class RedisFollowStore implements IFollowStore {
  constructor(private readonly redis: RedisClient) {}

  async isFollowing(userId: string, threadId: string): Promise<boolean> {
    const exists = await this.redis.exists(FollowKeys.entry(userId, threadId));
    return exists === 1;
  }

  async follow(userId: string, threadId: string, reason: FollowReason): Promise<boolean> {
    if (await this.isFollowing(userId, threadId)) return false;
    const key = FollowKeys.entry(userId, threadId);
    const pipeline = this.redis.multi();
    pipeline.hset(key, 'reason', reason, 'followedAt', String(Date.now()));
    pipeline.sadd(FollowKeys.userIndex(userId), threadId);
    await pipeline.exec();
    return true;
  }

  async unfollow(userId: string, threadId: string): Promise<boolean> {
    const key = FollowKeys.entry(userId, threadId);
    const deleted = await this.redis.del(key);
    if (deleted === 0) return false;
    await this.redis.srem(FollowKeys.userIndex(userId), threadId);
    return true;
  }

  async listFollowedThreadIds(userId: string): Promise<string[]> {
    return this.redis.smembers(FollowKeys.userIndex(userId));
  }

  async getFollowedAt(userId: string, threadId: string): Promise<number | null> {
    const value = await this.redis.hget(FollowKeys.entry(userId, threadId), 'followedAt');
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async deleteByThread(threadId: string): Promise<void> {
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const pattern = `${prefix}${FollowKeys.threadPattern(threadId)}`;
    const suffix = `:${threadId}`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const bareKeys = prefix ? keys.map((k: string) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)) : keys;
        const pipeline = this.redis.multi();
        for (const key of bareKeys) {
          // key = follow:{userId}:{threadId} — strip both ends to recover userId.
          const withoutPrefix = key.startsWith('follow:') ? key.slice('follow:'.length) : key;
          const userId = withoutPrefix.endsWith(suffix) ? withoutPrefix.slice(0, -suffix.length) : null;
          pipeline.del(key);
          if (userId) pipeline.srem(FollowKeys.userIndex(userId), threadId);
        }
        await pipeline.exec();
      }
    } while (cursor !== '0');
  }
}
