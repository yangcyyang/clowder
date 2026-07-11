import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { RedisFreshnessHoldStore } from '../dist/domains/cats/services/stores/redis/RedisFreshnessHoldStore.js';
import { FreshnessHoldKeys } from '../dist/domains/cats/services/stores/redis-keys/freshness-hold-keys.js';
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

function privateDraft(prefix) {
  return {
    content: `${prefix}-CONTENT`,
    richBlocks: [{ id: `${prefix}-RICH`, kind: 'card', v: 1, bodyMarkdown: `${prefix}-RICH-BODY` }],
    extra: {
      privateMarker: `${prefix}-EXTRA`,
      nested: { secret: `${prefix}-NESTED` },
    },
  };
}

function assertPrivatePayloadScrubbed(record, prefix) {
  assert.deepEqual(record.draft, { content: '' });
  assert.deepEqual(record.deltaMessageIds, []);
  assert.equal(JSON.stringify(record).includes(prefix), false);
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
    assert.deepEqual(
      await recoveredStore.getBySubmission(createInput().invocationId, createInput().submissionKey),
      recovered,
    );
    assert.equal(await recoveredStore.getBySubmission(createInput().invocationId, 'missing'), null);
  });

  it('atomically removes resolved draft and delta from Redis while preserving terminal tombstones', async () => {
    const store = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });

    const releasePrefix = 'REDIS-RELEASE-PRIVATE';
    const releasable = await store.createOrGet(
      createInput({
        invocationId: 'redis-inv-private-release',
        submissionKey: 'redis-private-release',
        draft: privateDraft(releasePrefix),
        deltaMessageIds: [`${releasePrefix}-DELTA`],
      }),
    );
    const claimed = await store.claimReview(releasable.hold.id, {
      expectedVersion: releasable.hold.version,
      now: NOW + 1,
    });
    const released = await store.release(releasable.hold.id, {
      expectedVersion: claimed.version,
      messageId: 'redis-released-message-id',
      committedWatermark: '23',
      now: NOW + 2,
    });

    assert.equal(released.status, 'released');
    assert.equal(released.releasedMessageId, 'redis-released-message-id');
    assert.equal(released.committedWatermark, '23');
    assert.equal(released.invocationId, 'redis-inv-private-release');
    assert.equal(released.submissionKey, 'redis-private-release');
    assertPrivatePayloadScrubbed(released, releasePrefix);
    const releaseRaw = await redis.hgetall(FreshnessHoldKeys.detail(releasable.hold.id));
    assert.equal(releaseRaw.draft, undefined);
    assert.equal(releaseRaw.deltaMessageIds, undefined);
    assert.equal(JSON.stringify(releaseRaw).includes(releasePrefix), false);
    const releaseReplay = await store.createOrGet(
      createInput({
        invocationId: 'redis-inv-private-release',
        submissionKey: 'redis-private-release',
        draft: privateDraft(releasePrefix),
        deltaMessageIds: [`${releasePrefix}-DELTA`],
      }),
    );
    assert.equal(releaseReplay.outcome, 'existing');
    assert.equal(releaseReplay.hold.id, releasable.hold.id);
    assertPrivatePayloadScrubbed(releaseReplay.hold, releasePrefix);

    const discardPrefix = 'REDIS-DISCARD-PRIVATE';
    const discardable = await store.createOrGet(
      createInput({
        invocationId: 'redis-inv-private-discard',
        submissionKey: 'redis-private-discard',
        draft: privateDraft(discardPrefix),
        deltaMessageIds: [`${discardPrefix}-DELTA`],
      }),
    );
    const discarded = await store.discard(discardable.hold.id, {
      expectedVersion: discardable.hold.version,
      now: NOW + 3,
    });

    assert.equal(discarded.status, 'discarded');
    assert.equal(discarded.invocationId, 'redis-inv-private-discard');
    assert.equal(discarded.submissionKey, 'redis-private-discard');
    assertPrivatePayloadScrubbed(discarded, discardPrefix);
    const discardRaw = await redis.hgetall(FreshnessHoldKeys.detail(discardable.hold.id));
    assert.equal(discardRaw.draft, undefined);
    assert.equal(discardRaw.deltaMessageIds, undefined);
    assert.equal(JSON.stringify(discardRaw).includes(discardPrefix), false);
    assert.equal(await store.discard(discardable.hold.id, { expectedVersion: discarded.version, now: NOW + 4 }), null);

    const attentionPrefix = 'REDIS-ATTENTION-PRIVATE';
    const attention = await store.createOrGet(
      createInput({
        invocationId: 'redis-inv-private-attention',
        submissionKey: 'redis-private-attention',
        draft: privateDraft(attentionPrefix),
        deltaMessageIds: [`${attentionPrefix}-DELTA`],
        reviewDeadlineAt: NOW + 5,
      }),
    );
    assert.equal(await store.expireDue(NOW + 5), 1);
    const retained = await store.get(attention.hold.id);
    assert.equal(retained.status, 'needs_attention');
    assert.deepEqual(retained.draft, privateDraft(attentionPrefix));
    assert.deepEqual(retained.deltaMessageIds, [`${attentionPrefix}-DELTA`]);
    const attentionRaw = await redis.hgetall(FreshnessHoldKeys.detail(attention.hold.id));
    assert.equal(attentionRaw.draft.includes(attentionPrefix), true);
    assert.equal(attentionRaw.deltaMessageIds.includes(attentionPrefix), true);
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

  it('fails closed when a claimed review crosses its deadline before release or rehold', async () => {
    const store = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });

    for (const transition of ['release', 'rehold']) {
      const created = await store.createOrGet(
        createInput({
          invocationId: `redis-inv-late-${transition}`,
          submissionKey: `redis-late-${transition}`,
          reviewDeadlineAt: NOW + 10,
        }),
      );
      const claimed = await store.claimReview(created.hold.id, {
        expectedVersion: created.hold.version,
        now: NOW + 9,
      });
      assert.ok(claimed);

      const result =
        transition === 'release'
          ? await store.release(created.hold.id, {
              expectedVersion: claimed.version,
              messageId: `redis-msg-${transition}`,
              committedWatermark: '25',
              now: NOW + 10,
            })
          : await store.rehold(created.hold.id, {
              expectedVersion: claimed.version,
              observedWatermark: '25',
              deltaMessageIds: ['redis-msg-25'],
              draft: { ...created.hold.draft, content: 'deadline 后不得重新进入待审' },
              now: NOW + 10,
            });

      assert.equal(result, null);
      const retained = await store.get(created.hold.id);
      assert.equal(retained.status, 'needs_attention');
      assert.equal(retained.attentionReason, 'timeout');
      assert.equal(retained.draft.content, created.hold.draft.content);
    }
  });

  it('recovers an active-hold index isolated by user and thread', async () => {
    const store = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
    const held = await store.createOrGet(
      createInput({ invocationId: 'active-held', submissionKey: 'active-held', createdAt: NOW + 1 }),
    );
    const reviewing = await store.createOrGet(
      createInput({ invocationId: 'active-reviewing', submissionKey: 'active-reviewing', createdAt: NOW + 2 }),
    );
    await store.claimReview(reviewing.hold.id, { expectedVersion: reviewing.hold.version, now: NOW + 3 });

    const attention = await store.createOrGet(
      createInput({
        invocationId: 'active-attention',
        submissionKey: 'active-attention',
        createdAt: NOW + 4,
        reviewDeadlineAt: NOW + 5,
      }),
    );
    await store.expireDue(NOW + 5);

    const released = await store.createOrGet(
      createInput({ invocationId: 'resolved-release', submissionKey: 'resolved-release', createdAt: NOW + 6 }),
    );
    const releasedClaim = await store.claimReview(released.hold.id, {
      expectedVersion: released.hold.version,
      now: NOW + 7,
    });
    await store.release(released.hold.id, {
      expectedVersion: releasedClaim.version,
      messageId: 'redis-released-message',
      committedWatermark: '26',
      now: NOW + 8,
    });

    const discarded = await store.createOrGet(
      createInput({ invocationId: 'resolved-discard', submissionKey: 'resolved-discard', createdAt: NOW + 9 }),
    );
    await store.discard(discarded.hold.id, { expectedVersion: discarded.hold.version, now: NOW + 10 });

    await store.createOrGet(
      createInput({
        invocationId: 'other-user',
        submissionKey: 'other-user',
        userId: 'user-2',
        createdAt: NOW + 11,
      }),
    );
    await store.createOrGet(
      createInput({
        invocationId: 'other-thread',
        submissionKey: 'other-thread',
        threadId: 'thread-2',
        createdAt: NOW + 12,
      }),
    );

    const recovered = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
    const active = await recovered.listActive('user-1', 'thread-1');
    assert.deepEqual(
      active.map((record) => [record.id, record.status]),
      [
        [attention.hold.id, 'needs_attention'],
        [reviewing.hold.id, 'reviewing'],
        [held.hold.id, 'held'],
      ],
    );
  });
});
