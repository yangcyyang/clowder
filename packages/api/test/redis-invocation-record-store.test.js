// @ci-tier redis reason="requires isolated Redis invocation record store"
/**
 * RedisInvocationRecordStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisInvocationRecordStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisInvocationRecordStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisInvocationRecordStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js');
    RedisInvocationRecordStore = storeModule.RedisInvocationRecordStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-invocation-record-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisInvocationRecordStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
  });

  it('create() returns created outcome', async () => {
    const result = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'redis-key-1',
    });

    assert.equal(result.outcome, 'created');
    assert.ok(result.invocationId.length > 0);
  });

  it('create() record has correct initial state', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'redis-key-2',
    });

    const record = await store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    assert.equal(record.userMessageId, null);
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.deepEqual(record.targetCats, ['opus', 'codex']);
    assert.equal(record.intent, 'ideate');
    assert.equal(record.idempotencyKey, 'redis-key-2');
    assert.equal(record.error, undefined);
  });

  it('Lua atomic dedup returns duplicate on same key', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(first.outcome, 'created');

    const second = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.invocationId, first.invocationId);
  });

  it('different threadId with same key does not dedup', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });
    const second = await store.create({
      threadId: 'thread-2',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });

    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'created');
    assert.notEqual(first.invocationId, second.invocationId);
  });

  it('get() returns null for non-existent id', async () => {
    const result = await store.get('non-existent-id');
    assert.equal(result, null);
  });

  it('update() changes status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'upd-key',
    });

    const updated = await store.update(invocationId, { status: 'running' });
    assert.equal(updated.status, 'running');
  });

  it('update() backfills userMessageId', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'backfill-key',
    });

    const before = await store.get(invocationId);
    assert.equal(before.userMessageId, null);

    await store.update(invocationId, { userMessageId: 'msg-456' });
    const after = await store.get(invocationId);
    assert.equal(after.userMessageId, 'msg-456');
  });

  it('update() persists and hydrates userMessageIds batch audit trail', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-batch',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'redis-batch-audit-key',
    });

    await store.update(invocationId, {
      userMessageIds: ['msg-1', 'msg-2', 'msg-3', 'msg-4'],
    });

    const record = await store.get(invocationId);
    assert.deepEqual(record.userMessageIds, ['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  it('update() sets error on failed status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'err-key',
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'CLI ENOENT' });
    const record = await store.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI ENOENT');
  });

  it('update() returns null for non-existent id', async () => {
    const result = await store.update('non-existent', { status: 'running' });
    assert.equal(result, null);
  });

  it('getByIdempotencyKey() finds record', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'lookup-key',
    });

    const found = await store.getByIdempotencyKey('thread-1', 'user-1', 'lookup-key');
    assert.ok(found);
    assert.equal(found.id, invocationId);
  });

  it('CAS update() succeeds when expectedStatus matches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-ok-key',
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'queued',
    });
    assert.ok(result);
    assert.equal(result.status, 'running');
  });

  it('CAS update() returns null when expectedStatus mismatches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-fail-key',
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'failed', // actual is 'queued'
    });
    assert.equal(result, null);

    // Status unchanged
    const record = await store.get(invocationId);
    assert.equal(record.status, 'queued');
  });

  it('concurrent CAS update: only one wins (Lua atomic)', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-race-key',
    });

    // Transition through proper lifecycle: queued → running → failed (retry starts from failed)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'boom' });

    // Fire N concurrent CAS transitions: failed → running
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.update(invocationId, {
          status: 'running',
          error: '',
          expectedStatus: 'failed',
        }),
      ),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}`);
    assert.equal(losers.length, N - 1);
    assert.equal(winners[0].status, 'running');
  });

  it('non-CAS update rejects illegal transition atomically', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'guard-no-cas',
    });

    // queued → running → succeeded (terminal)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → failed is illegal, must be rejected
    const result = await store.update(invocationId, { status: 'failed', error: 'should not happen' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('same-status update on terminal state is rejected (cloud P1)', async () => {
    // Reproduces cloud Codex P1: succeeded→succeeded bypassed state machine
    // because Lua only checked transitions when newStatus ~= current.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'self-transition',
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → succeeded should be rejected (terminal, no self-transitions)
    const result = await store.update(invocationId, { status: 'succeeded', error: 'late error' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('concurrent non-CAS updates cannot regress terminal state (race regression)', async () => {
    // Reproduces the P1 bug: concurrent non-CAS writes could bypass state machine.
    // Before fix: hget(status) → validate → hset was non-atomic, allowing
    // a stale read to overwrite a newer terminal status.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'race-no-cas',
    });

    // Get to running state
    await store.update(invocationId, { status: 'running' });

    // Fire concurrent: one tries succeeded, another tries failed
    // Both are legal from running, but only one should win.
    // The loser's transition should be rejected (not silently applied).
    const [r1, r2] = await Promise.all([
      store.update(invocationId, { status: 'succeeded' }),
      store.update(invocationId, { status: 'failed', error: 'late failure' }),
    ]);

    const record = await store.get(invocationId);

    if (r1 !== null) {
      // succeeded won — failed must have been rejected (succeeded is terminal)
      assert.equal(record.status, 'succeeded');
      assert.equal(record.error, undefined);
    } else {
      // failed won — succeeded must have been rejected (failed is not terminal, but
      // the point is: final state must be consistent with one atomic transition)
      assert.equal(record.status, 'failed');
      assert.ok(r2 !== null);
    }

    // Key invariant: exactly one winner
    const winners = [r1, r2].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'Exactly one concurrent update should succeed');
  });

  it('getByIdempotencyKey() returns null for wrong scope', async () => {
    await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scoped-key',
    });

    const r1 = await store.getByIdempotencyKey('thread-2', 'user-1', 'scoped-key');
    assert.equal(r1, null);
    const r2 = await store.getByIdempotencyKey('thread-1', 'user-2', 'scoped-key');
    assert.equal(r2, null);
  });

  // ─── Terminal Invariant (batch 3-B, item 1) — parity with the in-memory store ───

  it('succeeded transition without explicit terminalEvent gets a benign implicit fact', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'term-succeeded',
    });
    await store.update(invocationId, { status: 'running' });
    const updated = await store.update(invocationId, { status: 'succeeded' });

    assert.equal(updated.terminalEvent.kind, 'succeeded');
    assert.equal(updated.terminalEvent.source, 'legacy-implicit');
  });

  it('failed transition with an error string derives classification atomically alongside the status write', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'term-failed-network',
    });
    await store.update(invocationId, { status: 'running' });
    const updated = await store.update(invocationId, { status: 'failed', error: 'connect ECONNRESET' });

    assert.equal(updated.status, 'failed');
    assert.equal(updated.error, 'connect ECONNRESET');
    assert.equal(updated.terminalEvent.kind, 'transient_network');
    assert.equal(updated.terminalEvent.source, 'derived-from-error');
  });

  it('failed transition with no error and no terminalEvent is tagged missing_terminal_event and backfills error', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'term-missing',
    });
    await store.update(invocationId, { status: 'running' });
    const updated = await store.update(invocationId, { status: 'failed' });

    assert.equal(updated.terminalEvent.kind, 'missing_terminal_event');
    assert.equal(updated.error, 'missing_terminal_event');
  });

  it('explicit terminalEvent is honored verbatim over automatic derivation', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'term-explicit',
    });
    await store.update(invocationId, { status: 'running' });
    const explicit = { kind: 'process_restart', at: 12345, source: 'startup-reconciler', detail: { foo: 'bar' } };
    const updated = await store.update(invocationId, {
      status: 'failed',
      error: 'connect ECONNRESET',
      terminalEvent: explicit,
    });

    assert.deepEqual(updated.terminalEvent, explicit);
  });

  it('terminalEvent is cleared when a failed record is retried back to running', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'term-retry-clear',
    });
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'connect ECONNRESET' });
    assert.ok((await store.get(invocationId)).terminalEvent);

    const retried = await store.update(invocationId, { status: 'running', expectedStatus: 'failed', error: '' });
    assert.equal(retried.terminalEvent, undefined);
  });
});
