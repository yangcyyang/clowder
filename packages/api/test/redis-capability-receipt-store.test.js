// @ci-tier redis reason="requires isolated Redis capability receipt CAS"

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const CLEANUP_PATTERNS = ['auth-receipt:v1:*'];

describe('RedisCapabilityReceiptStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisCapabilityReceiptStore;
  let digestCapabilityArguments;
  let AuthReceiptKeys;
  let redis;
  let now;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisCapabilityReceiptStore');
    ({ RedisCapabilityReceiptStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisCapabilityReceiptStore.js'
    ));
    ({ digestCapabilityArguments } = await import(
      '../dist/domains/cats/services/stores/ports/CapabilityReceiptStore.js'
    ));
    ({ AuthReceiptKeys } = await import(
      '../dist/domains/cats/services/stores/redis-keys/authorization-keys.js'
    ));
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
    now = 100_000;
    store = new RedisCapabilityReceiptStore(redis, {
      now: () => now,
      physicalGraceMs: 60_000,
    });
  });

  function intent(overrides = {}) {
    return {
      version: 1,
      executorId: 'antigravity.native.run_command',
      action: 'run_command',
      invocationId: 'inv-redis-1',
      threadId: 'thread-redis-1',
      catId: 'antigravity',
      userId: 'user-1',
      taskId: 'task-397',
      argumentDigest: digestCapabilityArguments({ commandLine: 'touch redis-sentinel', cwd: '/tmp/a1' }),
      ...overrides,
    };
  }

  async function issue(inputIntent = intent(), overrides = {}) {
    return store.issue({
      requestId: 'request-redis-1',
      intent: inputIntent,
      approvedBy: 'user-1',
      approvalScope: 'once',
      expiresAt: 130_000,
      ...overrides,
    });
  }

  test('persists only token hash and enforces a physical TTL', async () => {
    const issued = await issue();
    const data = await redis.hgetall(AuthReceiptKeys.detail(issued.receipt.receiptId));
    const ttl = await redis.pttl(AuthReceiptKeys.detail(issued.receipt.receiptId));

    assert.equal(data.receiptId, issued.receipt.receiptId);
    assert.equal(data.tokenHash, issued.receipt.tokenHash);
    assert.equal(JSON.stringify(data).includes(issued.bearer), false);
    assert.ok(ttl > 0 && ttl <= 90_000, `expected bounded TTL, got ${ttl}`);
  });

  test('survives store reconstruction and consumes exactly once', async () => {
    const expected = intent();
    const issued = await issue(expected);
    const reconstructed = new RedisCapabilityReceiptStore(redis, {
      now: () => now,
      physicalGraceMs: 60_000,
    });

    const first = await reconstructed.consume(
      issued.bearer,
      expected,
      'antigravity.native.run_command',
    );
    const replay = await reconstructed.consume(
      issued.bearer,
      expected,
      'antigravity.native.run_command',
    );

    assert.equal(first.ok, true);
    assert.deepEqual(replay, { ok: false, code: 'already_used' });
  });

  test('wrong scope does not burn the valid receipt', async () => {
    const expected = intent();
    const issued = await issue(expected);

    const mismatch = await store.consume(
      issued.bearer,
      { ...expected, invocationId: 'inv-other' },
      'antigravity.native.run_command',
    );
    const exact = await store.consume(issued.bearer, expected, 'antigravity.native.run_command');

    assert.deepEqual(mismatch, { ok: false, code: 'scope_mismatch' });
    assert.equal(exact.ok, true);
  });

  test('twenty concurrent consumers have one CAS winner', async () => {
    const expected = intent();
    const issued = await issue(expected);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.consume(
          issued.bearer,
          expected,
          `antigravity.native.run_command`,
        ),
      ),
    );

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.code === 'already_used').length, 19);
  });

  test('logical expiry returns expired while the grace key still exists', async () => {
    const expected = intent();
    const issued = await issue(expected, { expiresAt: 100_100 });
    now = 100_101;

    const result = await store.consume(issued.bearer, expected, 'antigravity.native.run_command');
    const exists = await redis.exists(AuthReceiptKeys.detail(issued.receipt.receiptId));

    assert.deepEqual(result, { ok: false, code: 'expired' });
    assert.equal(exists, 1, 'short physical grace keeps an auditable expired reason');
  });
});
