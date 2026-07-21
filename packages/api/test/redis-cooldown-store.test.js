// @ci-tier redis reason="requires isolated Redis cooldown store"
/**
 * RedisCooldownStore tests — 理智线 T6 (task #388)
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

describe('RedisCooldownStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisCooldownStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const COOLDOWN_PATTERNS = ['cooldown:*', 'cooldowns:active'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisCooldownStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisCooldownStore.js');
    RedisCooldownStore = storeModule.RedisCooldownStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-cooldown-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisCooldownStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, COOLDOWN_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, COOLDOWN_PATTERNS);
  });

  it('set() persists a cooldown, readable via get()', async () => {
    const until = Date.now() + 60_000;
    await store.set({
      catId: 'opus',
      until,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: "You've hit your session limit · resets 3:30am (Asia/Shanghai)",
    });
    const record = await store.get('opus');
    assert.ok(record);
    assert.equal(record.catId, 'opus');
    assert.equal(record.until, until);
    assert.equal(record.reason, 'usage_limit');
  });

  it('set() max-merges concurrently: N writes with varying until all converge to the max', async () => {
    const base = Date.now();
    const untils = [base + 10_000, base + 60_000, base + 30_000, base + 5_000];
    await Promise.all(
      untils.map((until) =>
        store.set({ catId: 'opus', until, reason: 'usage_limit', source: 'anthropic', originalError: 'x' }),
      ),
    );
    const record = await store.get('opus');
    assert.equal(record.until, base + 60_000, 'concurrent writes must converge to the max until, not a race loser');
  });

  it('clear() removes both the hash and the active-set membership', async () => {
    await store.set({
      catId: 'opus',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });
    await store.clear('opus');
    assert.equal(await store.get('opus'), null);
    const active = await store.listActive();
    assert.equal(
      active.find((r) => r.catId === 'opus'),
      undefined,
    );
  });

  it('listActive() returns all tracked cooldowns and self-heals stale active-set entries', async () => {
    await store.set({
      catId: 'opus',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });
    await store.set({
      catId: 'codex',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'openai',
      originalError: 'y',
    });
    // Simulate a stale active-set entry (hash already expired/removed out-of-band).
    // NOTE: redis client has keyPrefix:'cat-cafe:' auto-applied — use the unprefixed
    // key name here too, matching CooldownKeys.ACTIVE's own (unprefixed) key.
    await redis.sadd('cooldowns:active', 'ghost-cat');

    const active = await store.listActive();
    assert.deepEqual(active.map((r) => r.catId).sort(), ['codex', 'opus']);
    const activeSetAfter = await redis.smembers('cooldowns:active');
    assert.ok(!activeSetAfter.includes('ghost-cat'), 'stale active-set member must be self-healed on listActive()');
  });

  it('reads survive a fresh client instance against the same Redis (restart-safety proxy)', async () => {
    const until = Date.now() + 60_000;
    await store.set({
      catId: 'opus',
      until,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });
    const freshClient = createRedisClient({ url: REDIS_URL });
    const freshStore = new RedisCooldownStore(freshClient);
    const record = await freshStore.get('opus');
    assert.ok(record, 'cooldown must be readable from a brand-new client (proves Redis persistence, not in-memory)');
    assert.equal(record.until, until);
    await freshClient.quit();
  });
});
