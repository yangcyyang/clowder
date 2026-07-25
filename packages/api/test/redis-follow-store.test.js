// @ci-tier redis reason="requires isolated Redis follow-store keys"
/**
 * RedisFollowStore tests (batch 3-D)
 * 有 Redis → 测全量；无 Redis → skip
 *
 * NOTE: not executed during batch 3-D authoring — the session's discipline
 * forbade any Redis writes for this task, so this file was written to mirror
 * redis-read-state-store.test.js's conventions but only verified via `tsc`
 * (see RedisFollowStore.ts) plus the Redis-free in-memory suites
 * (activity-auto-follow.test.js, activity-routes.test.js). Run via
 * `pnpm --filter @cat-cafe/api test:redis` to execute for real.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisFollowStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisFollowStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;
  let testSeq = 0;

  const uniqueId = (prefix) => `${prefix}-${++testSeq}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisFollowStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisFollowStore.js');
    RedisFollowStore = storeModule.RedisFollowStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-follow-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisFollowStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['follow:*', 'follow-index:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
  });

  it('isFollowing() is false before any follow() call', async () => {
    const tid = uniqueId('t');
    assert.equal(await store.isFollowing('user1', tid), false);
  });

  it('follow() creates the record and is reflected by isFollowing/listFollowedThreadIds', async () => {
    const tid = uniqueId('t');
    const created = await store.follow('user1', tid, 'participant');
    assert.equal(created, true);
    assert.equal(await store.isFollowing('user1', tid), true);
    assert.ok((await store.listFollowedThreadIds('user1')).includes(tid));
  });

  it('follow() is idempotent — second call for the same user+thread is a no-op', async () => {
    const tid = uniqueId('t');
    const first = await store.follow('user1', tid, 'participant');
    const second = await store.follow('user1', tid, 'mention');
    assert.equal(first, true);
    assert.equal(second, false);
  });

  it('getFollowedAt() returns null when not following, a timestamp once followed', async () => {
    const tid = uniqueId('t');
    assert.equal(await store.getFollowedAt('user1', tid), null);
    const before = Date.now();
    await store.follow('user1', tid, 'participant');
    const followedAt = await store.getFollowedAt('user1', tid);
    assert.ok(typeof followedAt === 'number' && followedAt >= before);
  });

  it('unfollow() removes the record and its user-index entry', async () => {
    const tid = uniqueId('t');
    await store.follow('user1', tid, 'participant');
    const removed = await store.unfollow('user1', tid);
    assert.equal(removed, true);
    assert.equal(await store.isFollowing('user1', tid), false);
    assert.ok(!(await store.listFollowedThreadIds('user1')).includes(tid));
  });

  it('unfollow() on a non-followed thread returns false', async () => {
    const tid = uniqueId('t');
    assert.equal(await store.unfollow('user1', tid), false);
  });

  it('deleteByThread() cascades across every follower of that thread', async () => {
    const tid = uniqueId('t');
    await store.follow('user1', tid, 'participant');
    await store.follow('user2', tid, 'mention');

    await store.deleteByThread(tid);

    assert.equal(await store.isFollowing('user1', tid), false);
    assert.equal(await store.isFollowing('user2', tid), false);
    assert.ok(!(await store.listFollowedThreadIds('user1')).includes(tid));
    assert.ok(!(await store.listFollowedThreadIds('user2')).includes(tid));
  });

  it('deleteByThread() does not affect other threads the same user follows', async () => {
    const keep = uniqueId('t');
    const drop = uniqueId('t');
    await store.follow('user1', keep, 'participant');
    await store.follow('user1', drop, 'participant');

    await store.deleteByThread(drop);

    const remaining = await store.listFollowedThreadIds('user1');
    assert.ok(remaining.includes(keep));
    assert.ok(!remaining.includes(drop));
  });
});
