// @ci-tier redis reason="requires isolated Redis message paging"
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const AUDIENCE = { kind: 'cat', catId: 'opus' };

describe('RedisMessageStore freshness delta paging', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore freshness delta paging');
    const [{ RedisMessageStore }, { createRedisClient }] = await Promise.all([
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('@cat-cafe/shared/utils'),
    ]);
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisMessageStore(redis, { ttlSeconds: 60 });
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  test('a bounded delta advances only to the last hydrated message', async () => {
    const threadId = 'freshness-delta-redis-paging';
    const baseline = await store.captureFreshnessWatermark(threadId, AUDIENCE);
    const messages = [];
    for (let index = 0; index < 3; index += 1) {
      messages.push(
        await store.append({
          userId: 'user-freshness-paging',
          catId: null,
          threadId,
          content: `page ${index + 1}`,
          mentions: ['opus'],
          timestamp: 300 + index,
          messageClass: 'substantive',
          deliveryStatus: 'queued',
        }),
      );
    }

    const first = await store.getFreshnessDelta(threadId, AUDIENCE, baseline, undefined, 1);
    assert.deepEqual(
      first.messages.map((message) => message.id),
      [messages[0].id],
    );
    assert.equal(first.observedWatermark, messages[0].appendWatermark);
    assert.equal(first.truncated, true);

    const second = await store.getFreshnessDelta(threadId, AUDIENCE, first.observedWatermark, undefined, 1);
    assert.deepEqual(
      second.messages.map((message) => message.id),
      [messages[1].id],
    );
    assert.equal(second.observedWatermark, messages[1].appendWatermark);
    assert.equal(second.truncated, true);

    const third = await store.getFreshnessDelta(threadId, AUDIENCE, second.observedWatermark, undefined, 1);
    assert.deepEqual(
      third.messages.map((message) => message.id),
      [messages[2].id],
    );
    assert.equal(third.observedWatermark, messages[2].appendWatermark);
    assert.equal(third.truncated, false);
  });
});
