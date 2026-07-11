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
const MAX_WATERMARK = '9007199254740991';

function revision(value, label) {
  assert.equal(typeof value, 'string', `${label} must be an opaque decimal string`);
  assert.match(value, /^\d+$/, `${label} must contain only decimal digits`);
  return BigInt(value);
}

describe('RedisMessageStore freshness linearization', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let MessageKeys;
  let FreshnessEgressGate;
  let FreshnessHoldStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore freshness linearization');

    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    ({ MessageKeys } = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'));
    ({ FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'));
    ({ FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js'));
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

  test('keeps a queued review publication on the watermark but behind a private delta barrier', async () => {
    const threadId = 'freshness-redis-private-review-delta';
    const sentinel = 'QUEUED-REVIEW-DRAFT-MUST-NOT-HYDRATE';
    const baseline = await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE);
    const queued = await store.append({
      userId: 'user-1',
      catId: 'opus',
      threadId,
      content: sentinel,
      mentions: [],
      timestamp: 330,
      deliveryStatus: 'queued',
      freshnessReviewPublication: true,
    });

    assert.equal(await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE), queued.appendWatermark);
    assert.equal(await store.getById(queued.id), null);
    assert.equal((await store.getByIdForFreshnessRelease(queued.id)).content, sentinel);
    assert.equal(JSON.stringify(await store.scanAll()).includes(sentinel), false);
    const privateDelta = await store.getFreshnessDelta(threadId, OPUS_AUDIENCE, baseline);
    assert.deepEqual(privateDelta.messages, []);
    assert.equal(privateDelta.observedWatermark, baseline);
    assert.equal(privateDelta.truncated, true);
    assert.equal(JSON.stringify(privateDelta).includes(sentinel), false);

    const ordinaryDelivery = await store.markDelivered(queued.id, 331);
    assert.equal(ordinaryDelivery.deliveryStatus, 'queued');
    const stillPrivateDelta = await store.getFreshnessDelta(threadId, OPUS_AUDIENCE, baseline);
    assert.deepEqual(stillPrivateDelta.messages, []);

    await store.releaseFreshnessReviewPublication(queued.id, 332);
    const deliveredDelta = await store.getFreshnessDelta(threadId, OPUS_AUDIENCE, baseline);
    assert.deepEqual(
      deliveredDelta.messages.map((message) => [message.id, message.content]),
      [[queued.id, sentinel]],
    );
  });

  test('keeps a Redis-backed review draft private when hold release throws, then reveals it after delivery', async () => {
    const threadId = 'freshness-redis-review-release-crash';
    const invocationId = 'freshness-redis-review-release-crash-invocation';
    const sentinel = 'REDIS-RELEASE-CRASH-PRIVATE-DRAFT';
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const release = holdStore.release.bind(holdStore);
    let crashBeforeRelease = true;
    holdStore.release = async (...args) => {
      if (crashBeforeRelease) {
        crashBeforeRelease = false;
        throw new Error('simulated Redis-backed release crash');
      }
      return release(...args);
    };
    const gate = new FreshnessEgressGate({ messageStore: store, holdStore });
    const baseline = await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE);
    const trigger = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'trigger hold before Redis-backed review',
      mentions: ['opus'],
      timestamp: 335,
      deliveryStatus: 'queued',
    });
    const submitInput = {
      invocationId,
      submissionKey: 'redis-release-crash-submit',
      userId: 'user-1',
      catId: 'opus',
      threadId,
      baselineWatermark: baseline,
      draft: {
        userId: 'user-1',
        catId: 'opus',
        threadId,
        content: sentinel,
        mentions: [],
        timestamp: 336,
        extra: { stream: { invocationId } },
      },
    };
    const held = await gate.submit(submitInput);
    assert.equal(held.outcome, 'held');
    const reviewInput = {
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      invocationId,
      userId: 'user-1',
      catId: 'opus',
      threadId,
      now: 337,
    };

    await assert.rejects(gate.review(reviewInput), /simulated Redis-backed release crash/);
    const privateDelta = await store.getFreshnessDelta(threadId, OPUS_AUDIENCE, trigger.appendWatermark);
    assert.deepEqual(privateDelta.messages, []);
    assert.equal(privateDelta.observedWatermark, trigger.appendWatermark);
    assert.equal(privateDelta.truncated, true);
    assert.equal(JSON.stringify(privateDelta).includes(sentinel), false);

    const recovered = await gate.review(reviewInput);
    assert.equal(recovered.outcome, 'published');
    assert.equal(recovered.message.deliveryStatus, 'delivered');
    const deliveredDelta = await store.getFreshnessDelta(threadId, OPUS_AUDIENCE, trigger.appendWatermark);
    assert.deepEqual(
      deliveredDelta.messages.map((message) => [message.id, message.content]),
      [[recovered.message.id, sentinel]],
    );
  });

  test('marks a conditional idempotency replay without appending a second message', async () => {
    const threadId = 'freshness-redis-conditional-replay';
    const baseline = await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE);
    const input = {
      userId: 'user-1',
      catId: 'opus',
      threadId,
      content: 'protected publication retry',
      mentions: [],
      timestamp: 340,
      idempotencyKey: 'protected-submit:invocation:submission',
    };

    const first = await store.appendIfFresh(input, { baseline, audience: OPUS_AUDIENCE });
    const retry = await store.appendIfFresh(input, { baseline, audience: OPUS_AUDIENCE });

    assert.equal(first.outcome, 'appended');
    assert.equal(first.replayed, undefined);
    assert.equal(retry.outcome, 'appended');
    assert.equal(retry.replayed, true);
    assert.equal(retry.message.id, first.message.id);
    assert.equal((await store.getByThread(threadId, 10)).length, 1);
  });

  test('atomically claims a current callback side effect once and rejects stale claims', async () => {
    const threadId = 'freshness-redis-side-effect-claim';
    const baseline = await store.captureFreshnessWatermark(threadId, OPUS_AUDIENCE);
    const claim = {
      userId: 'user-1',
      threadId,
      audience: OPUS_AUDIENCE,
      baseline,
      idempotencyKey: 'invocation-1:start-vote',
      groupId: 'invocation-1',
    };

    const first = await store.claimFreshnessSideEffect(claim);
    const replay = await store.claimFreshnessSideEffect(claim);
    assert.equal(first.outcome, 'claimed');
    assert.equal(first.replayed, false);
    assert.equal(replay.outcome, 'claimed');
    assert.equal(replay.replayed, true);

    await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'new input before task creation',
      mentions: ['opus'],
      timestamp: 345,
    });
    const stale = await store.claimFreshnessSideEffect({
      ...claim,
      idempotencyKey: 'invocation-1:create-task',
    });
    assert.equal(stale.outcome, 'stale');
    assert.ok(revision(stale.observedWatermark, 'side effect observed') > revision(baseline, 'side effect baseline'));
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

  test('uses exact max-safe watermark text and rejects the next append before any write', async () => {
    const threadId = 'freshness-redis-watermark-limit';
    await redis.set(MessageKeys.freshnessSequence(threadId), '9007199254740990');

    const final = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'last exactly representable freshness append',
      mentions: ['opus'],
      timestamp: 600,
    });
    assert.equal(final.appendWatermark, MAX_WATERMARK);

    const rejectedIdempotencyKey = 'must-not-be-written-at-watermark-limit';
    await assert.rejects(
      store.append({
        userId: 'user-1',
        catId: null,
        threadId,
        content: 'must fail before hash and indexes',
        mentions: ['opus'],
        timestamp: 601,
        idempotencyKey: rejectedIdempotencyKey,
      }),
      /freshness watermark exhausted/,
    );

    assert.equal(await redis.get(MessageKeys.freshnessSequence(threadId)), MAX_WATERMARK);
    assert.equal(await redis.get(MessageKeys.idempotency('user-1', threadId, rejectedIdempotencyKey)), null);
    assert.deepEqual(
      (await store.getByThread(threadId, 10)).map((message) => message.id),
      [final.id],
    );
  });

  test('fails closed before restore or reveal can partially mutate at the watermark limit', async () => {
    const restoreThreadId = 'freshness-redis-restore-watermark-limit';
    const restorable = await store.append({
      userId: 'user-1',
      catId: null,
      threadId: restoreThreadId,
      content: 'soft deleted before restore limit',
      mentions: ['opus'],
      timestamp: 610,
    });
    await store.softDelete(restorable.id, 'user-1');
    await redis.set(MessageKeys.freshnessSequence(restoreThreadId), MAX_WATERMARK);

    await assert.rejects(store.restore(restorable.id), /freshness watermark exhausted/);
    const stillDeleted = await store.getById(restorable.id);
    assert.ok(stillDeleted.deletedAt);
    assert.equal(await store.captureFreshnessWatermark(restoreThreadId, OPUS_AUDIENCE), '0');

    const revealThreadId = 'freshness-redis-reveal-watermark-limit';
    const privateMessage = await store.append({
      userId: 'user-1',
      catId: null,
      threadId: revealThreadId,
      content: 'whisper before reveal limit',
      mentions: [],
      visibility: 'whisper',
      whisperTo: ['opus'],
      timestamp: 620,
    });
    await redis.set(MessageKeys.freshnessSequence(revealThreadId), MAX_WATERMARK);

    await assert.rejects(store.revealWhispers(revealThreadId, 'user-1'), /freshness watermark exhausted/);
    const stillPrivate = await store.getById(privateMessage.id);
    assert.equal(stillPrivate.revealedAt, undefined);
    assert.equal(await store.captureFreshnessWatermark(revealThreadId, OPUS_AUDIENCE), privateMessage.appendWatermark);
    assert.equal(await store.captureFreshnessWatermark(revealThreadId, CODEX_AUDIENCE), '0');
  });

  test('rejects a multi-whisper reveal before any partial mutation at the watermark limit', async () => {
    const threadId = 'freshness-redis-multi-reveal-watermark-limit';
    const first = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'first private message',
      mentions: [],
      visibility: 'whisper',
      whisperTo: ['opus'],
      timestamp: 630,
    });
    const second = await store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'second private message',
      mentions: [],
      visibility: 'whisper',
      whisperTo: ['opus'],
      timestamp: 631,
    });
    await redis.set(MessageKeys.freshnessSequence(threadId), '9007199254740990');

    await assert.rejects(store.revealWhispers(threadId, 'user-1'), /freshness watermark exhausted/);

    assert.equal((await store.getById(first.id)).revealedAt, undefined);
    assert.equal((await store.getById(second.id)).revealedAt, undefined);
    assert.equal(await redis.get(MessageKeys.freshnessSequence(threadId)), '9007199254740990');
    assert.equal(await store.captureFreshnessWatermark(threadId, CODEX_AUDIENCE), '0');
  });
});
