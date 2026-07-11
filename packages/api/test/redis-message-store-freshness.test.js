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
const CODEX_AUDIENCE = { kind: 'cat', catId: 'codex' };

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

  test('repairs a dangling legacy idempotency pointer without allowing duplicate publication', async () => {
    const threadId = 'freshness-redis-legacy-idempotency';
    const idempotencyKey = 'legacy-retry';
    await redis.set(`msg:idem:user-1:${threadId}:${idempotencyKey}`, 'missing-message-id');

    const input = {
      userId: 'user-1',
      catId: 'opus',
      threadId,
      content: 'publish exactly once',
      mentions: [],
      timestamp: 300,
      idempotencyKey,
    };
    const results = await Promise.all(Array.from({ length: 12 }, () => store.append(input)));

    assert.equal(new Set(results.map((message) => message.id)).size, 1);
    assert.equal(
      (await store.getByThread(threadId, 20)).filter((message) => message.content === input.content).length,
      1,
    );
  });

  test('keeps queued publications out of history and emits onAppend once after delivery', async () => {
    const appended = [];
    const listenerStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onAppend: (message) => appended.push(message.id),
    });
    const queued = await listenerStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: 'freshness-redis-private-queued',
      content: 'private until release CAS',
      mentions: [],
      timestamp: 325,
      deliveryStatus: 'queued',
    });

    assert.deepEqual(await listenerStore.getRecent(10, 'user-1'), []);
    assert.deepEqual(appended, []);

    await listenerStore.markDelivered(queued.id, 326);
    assert.deepEqual(
      (await listenerStore.getRecent(10, 'user-1')).map((message) => message.id),
      [queued.id],
    );
    assert.deepEqual(appended, [queued.id]);

    await listenerStore.markDelivered(queued.id, 327);
    assert.deepEqual(appended, [queued.id]);
  });

  test('allows only same parent-group siblings past a shared baseline', async () => {
    const threadId = 'freshness-redis-sibling-group';
    const baseline = await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE);
    await store.append({
      userId: 'user-1',
      catId: 'codex',
      threadId,
      content: 'first sibling proposal',
      mentions: [],
      timestamp: 350,
      extra: { stream: { invocationId: 'redis-parent-group' } },
    });

    const sibling = await store.appendIfFresh(
      {
        userId: 'user-1',
        catId: 'opus',
        threadId,
        content: 'second sibling proposal',
        mentions: [],
        timestamp: 351,
        extra: { stream: { invocationId: 'redis-parent-group' } },
      },
      { baseline, audience: OPUS_AUDIENCE, groupId: 'redis-parent-group' },
    );
    assert.equal(sibling.outcome, 'appended');

    const independent = await store.appendIfFresh(
      {
        userId: 'user-1',
        catId: 'opus',
        threadId,
        content: 'independent stale draft',
        mentions: [],
        timestamp: 352,
        extra: { stream: { invocationId: 'redis-independent-group' } },
      },
      { baseline, audience: OPUS_AUDIENCE, groupId: 'redis-independent-group' },
    );
    assert.equal(independent.outcome, 'stale');
  });

  test('keeps reveal, delete, restore and thread deletion freshness indexes in sync', async () => {
    const threadId = 'freshness-redis-index-lifecycle';
    const whispered = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'private user instruction',
      mentions: [],
      visibility: 'whisper',
      whisperTo: ['opus'],
      timestamp: 400,
    });
    const privateRevision = revision(whispered.appendWatermark, 'private appendWatermark');
    assert.equal(await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE), whispered.appendWatermark);
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), '0');

    assert.equal(await store.revealWhispers(threadId, 'user-1'), 1);
    const revealed = await store.getById(whispered.id);
    assert.ok(revision(revealed.appendWatermark, 'revealed appendWatermark') > privateRevision);
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), revealed.appendWatermark);

    await store.softDelete(whispered.id, 'user-1');
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), '0');

    const restored = await store.restore(whispered.id);
    assert.ok(
      revision(restored.appendWatermark, 'restored appendWatermark') > revision(revealed.appendWatermark, 'revealed'),
    );
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), restored.appendWatermark);

    assert.equal(await store.deleteByThread(threadId), 1);
    assert.equal(await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE), '0');
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), '0');

    const reused = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'first instruction after thread reuse',
      mentions: [],
      timestamp: 500,
    });
    assert.ok(
      revision(reused.appendWatermark, 'reused thread appendWatermark') >
        revision(restored.appendWatermark, 'pre-delete appendWatermark'),
      'thread reuse must retain a monotonic ABA tombstone',
    );
  });
});
