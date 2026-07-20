// @ci-tier redis reason="requires isolated Redis for claimIfUnowned CAS race sentinel"
/**
 * 票B B3 — task claim CAS (claimIfUnowned).
 *
 * Bug: callback claim was read-then-update (non-atomic); two cats racing
 * could both "win". claimIfUnowned performs a single atomic CAS on ownerCatId.
 *
 * LIVE SENTINELS:
 *  - in-memory + redis: claim unowned → claimed (+ 'claimed' event, status doing).
 *  - already owned by another cat → already_claimed, current owner preserved.
 *  - missing task → not_found.
 *  - N=20 concurrent claims on one redis task → EXACTLY 1 winner, 1 'claimed' event.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const CLEANUP_PATTERNS = ['task:*', 'tasks:*'];

function taskInput(overrides = {}) {
  return {
    threadId: 'thread-cas',
    title: 'CAS claim target',
    why: 'race me',
    createdBy: 'user',
    userId: 'user-1',
    ...overrides,
  };
}

describe('B3 claimIfUnowned — in-memory TaskStore', () => {
  it('claims an unowned task atomically with claimed event + doing status', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    const task = await store.create(taskInput());

    const result = await store.claimIfUnowned(task.id, 'opus', { why: 'taking it' });
    assert.equal(result.outcome, 'claimed');
    assert.equal(result.task.ownerCatId, 'opus');
    assert.equal(result.task.status, 'doing');
    assert.equal(result.task.why, 'taking it');
    const claimedEvents = (result.task.events ?? []).filter((e) => e.type === 'claimed');
    assert.equal(claimedEvents.length, 1);
  });

  it('already owned by another cat → already_claimed, owner preserved', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    const task = await store.create(taskInput({ ownerCatId: 'codex' }));

    const result = await store.claimIfUnowned(task.id, 'opus');
    assert.equal(result.outcome, 'already_claimed');
    assert.equal(result.task.ownerCatId, 'codex');

    const after = await store.get(task.id);
    assert.equal(after.ownerCatId, 'codex', 'loser must not overwrite the owner');
    assert.equal((after.events ?? []).filter((e) => e.type === 'claimed').length, 0);
  });

  it('same-cat re-claim is idempotent-claimed', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    const task = await store.create(taskInput({ ownerCatId: 'opus' }));

    const result = await store.claimIfUnowned(task.id, 'opus');
    assert.equal(result.outcome, 'claimed');
    assert.equal(result.task.ownerCatId, 'opus');
  });

  it('missing task → not_found', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    const result = await store.claimIfUnowned('nope', 'opus');
    assert.equal(result.outcome, 'not_found');
  });
});

describe('B3 claimIfUnowned — RedisTaskStore CAS', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisTaskStore.claimIfUnowned');
    ({ RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
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

  it('claims unowned task with event + TTL re-applied path intact', async () => {
    const task = await store.create(taskInput());
    const result = await store.claimIfUnowned(task.id, 'opus', { why: 'mine' });

    assert.equal(result.outcome, 'claimed');
    assert.equal(result.task.ownerCatId, 'opus');
    assert.equal(result.task.status, 'doing');
    assert.equal((result.task.events ?? []).filter((e) => e.type === 'claimed').length, 1);

    const persisted = await store.get(task.id);
    assert.equal(persisted.ownerCatId, 'opus');
    assert.equal(persisted.status, 'doing');
  });

  it('already claimed by another cat → already_claimed with current owner', async () => {
    const task = await store.create(taskInput({ ownerCatId: 'codex' }));
    const result = await store.claimIfUnowned(task.id, 'opus');

    assert.equal(result.outcome, 'already_claimed');
    assert.equal(result.task.ownerCatId, 'codex');
  });

  it('missing task → not_found', async () => {
    const result = await store.claimIfUnowned('missing-task-id', 'opus');
    assert.equal(result.outcome, 'not_found');
  });

  it('SENTINEL: 20 concurrent claims on one task → exactly 1 winner', async () => {
    const task = await store.create(taskInput());

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.claimIfUnowned(task.id, `cat-${i}`)),
    );

    const winners = results.filter((r) => r.outcome === 'claimed');
    const losers = results.filter((r) => r.outcome === 'already_claimed');
    assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);
    assert.equal(losers.length, 19);

    const winnerCat = winners[0].task.ownerCatId;
    for (const loser of losers) {
      assert.equal(loser.task.ownerCatId, winnerCat, 'losers must observe the winner as owner');
    }

    const final = await store.get(task.id);
    assert.equal(final.ownerCatId, winnerCat);
    assert.equal(
      (final.events ?? []).filter((e) => e.type === 'claimed').length,
      1,
      'exactly one claimed event may be appended',
    );
  });
});
