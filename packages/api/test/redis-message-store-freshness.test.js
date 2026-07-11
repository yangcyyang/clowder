/**
 * Freshness Hold Task 1 — Redis linearization RED test.
 *
 * Run through scripts/run-isolated-redis-tests.sh. Production Redis is never
 * accepted by the shared isolation guard.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OPUS_AUDIENCE = { kind: 'cat', catId: 'opus' };

function revision(value, label) {
  assert.equal(typeof value, 'string', `${label} must be an opaque decimal string`);
  assert.match(value, /^\d+$/, `${label} must contain only decimal digits`);
  return BigInt(value);
}

describe('RedisMessageStore freshness linearization', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore freshness linearization');

    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
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

  test('concurrent inbound and conditional outbound have only the two legal linear outcomes', async () => {
    assert.equal(
      typeof store.captureFreshnessWatermark,
      'function',
      'Task 1 requires RedisMessageStore.captureFreshnessWatermark()',
    );
    assert.equal(typeof store.appendIfFresh, 'function', 'Task 1 requires RedisMessageStore.appendIfFresh()');

    // Inbound is submitted first. A correct shared Lua primitive linearizes it
    // before the conditional append, so the old baseline must be rejected.
    const inboundFirstThread = 'freshness-redis-inbound-first';
    const inboundFirstBaseline = await store.captureFreshnessWatermark(inboundFirstThread, OPUS_AUDIENCE);
    const inboundFirstPromise = store.append({
      userId: 'user-1',
      catId: null,
      threadId: inboundFirstThread,
      content: 'new inbound instruction',
      mentions: ['opus'],
      timestamp: 100,
    });
    const rejectedOutboundPromise = store.appendIfFresh(
      {
        userId: 'user-1',
        catId: 'opus',
        threadId: inboundFirstThread,
        content: 'stale outbound draft',
        mentions: [],
        timestamp: 100,
      },
      { baseline: inboundFirstBaseline, audience: OPUS_AUDIENCE },
    );
    const [inboundFirst, rejectedOutbound] = await Promise.all([inboundFirstPromise, rejectedOutboundPromise]);

    assert.equal(rejectedOutbound.outcome, 'stale');
    assert.ok(
      revision(rejectedOutbound.observedWatermark, 'observedWatermark') >=
        revision(inboundFirst.appendWatermark, 'inbound appendWatermark'),
    );
    assert.deepEqual(
      (await store.getByThread(inboundFirstThread, 10)).map((message) => message.content),
      ['new inbound instruction'],
      'stale conditional output must perform zero formal append',
    );

    // Conditional append is submitted first. If it is implemented as
    // check→await→ordinary append, the inbound command can slip into the gap;
    // a single Lua primitive instead commits outbound before inbound.
    const outboundFirstThread = 'freshness-redis-outbound-first';
    const outboundFirstBaseline = await store.captureFreshnessWatermark(outboundFirstThread, OPUS_AUDIENCE);
    const acceptedOutboundPromise = store.appendIfFresh(
      {
        userId: 'user-1',
        catId: 'opus',
        threadId: outboundFirstThread,
        content: 'fresh outbound draft',
        mentions: [],
        timestamp: 200,
      },
      { baseline: outboundFirstBaseline, audience: OPUS_AUDIENCE },
    );
    const inboundSecondPromise = store.append({
      userId: 'user-1',
      catId: null,
      threadId: outboundFirstThread,
      content: 'inbound after publication point',
      mentions: ['opus'],
      timestamp: 200,
    });
    const [acceptedOutbound, inboundSecond] = await Promise.all([acceptedOutboundPromise, inboundSecondPromise]);

    assert.equal(acceptedOutbound.outcome, 'appended');
    assert.ok(
      revision(acceptedOutbound.committedWatermark, 'committedWatermark') <
        revision(inboundSecond.appendWatermark, 'inbound appendWatermark'),
      'published outbound must linearize before the concurrently submitted inbound',
    );
    assert.deepEqual(
      new Set((await store.getByThread(outboundFirstThread, 10)).map((message) => message.content)),
      new Set(['fresh outbound draft', 'inbound after publication point']),
    );
  });
});
