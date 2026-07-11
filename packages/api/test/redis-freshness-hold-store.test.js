import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { RedisFreshnessHoldStore } from '../dist/domains/cats/services/stores/redis/RedisFreshnessHoldStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const NOW = 1_700_000_000_000;

function createInput(overrides = {}) {
  return {
    invocationId: 'redis-inv-1',
    submissionKey: 'redis-client-message-1',
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    baselineWatermark: '20',
    observedWatermark: '22',
    deltaMessageIds: ['msg-21', 'msg-22'],
    draft: {
      content: 'Redis 重启后必须恢复的完整稿件',
      messageClass: 'substantive',
      replyTo: 'msg-parent',
      targetCats: ['codex'],
      richBlocks: [{ id: 'redis-card', kind: 'card', v: 1, bodyMarkdown: '持久附件' }],
    },
    createdAt: NOW,
    reviewDeadlineAt: NOW + 30 * 60_000,
    ...overrides,
  };
}

describe('RedisFreshnessHoldStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisFreshnessHoldStore');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!redis || !connected) return;
    await cleanupPrefixedRedisKeys(redis, ['freshness-hold:*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['freshness-hold:*']);
  });

  it('recovers dedupe index, CAS state and full draft from a new store instance', async () => {
    const firstStore = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
    const created = await firstStore.createOrGet(createInput());
    assert.equal(created.outcome, 'created');

    const claim = await firstStore.claimReview(created.hold.id, {
      expectedVersion: created.hold.version,
      now: NOW + 1,
    });
    assert.ok(claim);
    const reheld = await firstStore.rehold(created.hold.id, {
      expectedVersion: claim.version,
      observedWatermark: '23',
      deltaMessageIds: ['msg-23'],
      draft: { ...created.hold.draft, content: '重启前改写稿' },
      now: NOW + 2,
    });
    assert.equal(reheld.status, 'held');

    const recoveredStore = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
    const recovered = await recoveredStore.get(created.hold.id);
    assert.equal(recovered.status, 'held');
    assert.equal(recovered.version, reheld.version);
    assert.equal(recovered.reviewCount, 1);
    assert.equal(recovered.observedWatermark, '23');
    assert.deepEqual(recovered.deltaMessageIds, ['msg-23']);
    assert.equal(recovered.draft.content, '重启前改写稿');
    assert.deepEqual(recovered.draft.richBlocks, created.hold.draft.richBlocks);

    const replay = await recoveredStore.createOrGet(createInput({ draft: { content: '不得覆盖' } }));
    assert.equal(replay.outcome, 'existing');
    assert.equal(replay.hold.id, created.hold.id);
    assert.equal(replay.hold.draft.content, '重启前改写稿');
  });

  it('allows exactly one concurrent claimReview winner after recovery', async () => {
    const firstStore = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
    const created = await firstStore.createOrGet(createInput({ submissionKey: 'redis-cas-key' }));
    const recoveredStore = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        recoveredStore.claimReview(created.hold.id, {
          expectedVersion: created.hold.version,
          now: NOW + 1,
        }),
      ),
    );

    assert.equal(results.filter((result) => result !== null).length, 1);
    assert.equal(results.filter((result) => result === null).length, 19);
  });
});
