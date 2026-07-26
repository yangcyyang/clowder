// @ci-tier redis reason="requires isolated Redis to verify claimed-idle nudge persistence"
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const CLEANUP_PATTERNS = ['task:*', 'tasks:*'];

function createQueue() {
  const enqueued = [];
  return {
    enqueued,
    hasQueuedOrProcessingForCat: () => false,
    hasActiveIdempotencyKey: () => false,
    enqueue(input) {
      const entry = { id: `entry-${enqueued.length + 1}`, ...input };
      enqueued.push(entry);
      return { outcome: 'enqueued', entry, deduped: false, queuePosition: enqueued.length };
    },
    async persistEntry() {},
  };
}

describe('ClaimedIdleScheduler — RedisTaskStore 护栏', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let ClaimedIdleScheduler;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'ClaimedIdleScheduler Redis 护栏');
    ({ RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
    ({ ClaimedIdleScheduler } = await import('../dist/domains/cats/services/agents/invocation/ClaimedIdleScheduler.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    store = new RedisTaskStore(redis);
  });

  it('第一条 idle_nudged 必须跨两次扫描持久化，16 分钟后不得再次唤醒', async () => {
    const initialNow = Date.now();
    const task = await store.create({
      threadId: 'thread-main',
      taskThreadId: 'thread-work',
      title: '隔离 Redis 唤醒器回归',
      why: '防止每分钟重复唤醒',
      createdBy: 'user',
      userId: 'user-1',
      ownerCatId: 'opus',
      status: 'doing',
      events: [{ ts: new Date(initialNow - 60 * 60_000).toISOString(), catId: 'opus', type: 'claimed', data: {} }],
    });
    await store.update(task.id, { events: [] });
    await redis.hset(`task:${task.id}`, { updatedAt: String(initialNow - 20 * 60_000) });

    const queue = createQueue();
    let now = initialNow;
    const scheduler = new ClaimedIdleScheduler({
      taskStore: store,
      messageStore: { async append() { throw new Error('本测试不应升级'); } },
      socketManager: { broadcastToRoom() {} },
      invocationQueue: queue,
      invocationTracker: { has: () => false },
      queueProcessor: { async tryAutoExecute() {} },
      now: () => now,
      env: { CLOWDER_CLAIMED_IDLE_MINUTES: '15' },
    });

    await scheduler.tick();
    assert.equal(queue.enqueued.length, 1, '首次闲置应只唤醒一次');
    const afterFirst = await store.get(task.id);
    assert.equal((afterFirst.events ?? []).filter((event) => event.type === 'idle_nudged').length, 1);

    now += 16 * 60_000;
    await scheduler.tick();
    assert.equal(queue.enqueued.length, 1, '30 分钟间隔内不得二次唤醒');
    const afterSecond = await store.get(task.id);
    assert.equal((afterSecond.events ?? []).filter((event) => event.type === 'idle_nudged').length, 1);
  });
});
