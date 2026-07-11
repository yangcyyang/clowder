import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FreshnessHoldStore } from '../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js';

const NOW = 1_700_000_000_000;

function draft(content = '基于旧上下文形成的完整草稿') {
  return {
    content,
    messageClass: 'substantive',
    replyTo: 'msg-parent',
    targetCats: ['codex'],
    richBlocks: [{ id: 'card-1', kind: 'card', v: 1, bodyMarkdown: '完整附件' }],
    deliveryStatus: 'queued',
  };
}

function createInput(overrides = {}) {
  return {
    invocationId: 'inv-1',
    submissionKey: 'client-message-1',
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    baselineWatermark: '10',
    observedWatermark: '12',
    deltaMessageIds: ['msg-11', 'msg-12'],
    draft: draft(),
    createdAt: NOW,
    reviewDeadlineAt: NOW + 30 * 60_000,
    ...overrides,
  };
}

async function createHeld(store, overrides = {}) {
  const result = await store.createOrGet(createInput(overrides));
  assert.equal(result.outcome, 'created');
  assert.equal(result.hold.status, 'held');
  assert.equal(result.hold.version, 1);
  assert.equal(result.hold.reviewCount, 0);
  return result.hold;
}

describe('FreshnessHoldStore', () => {
  it('createOrGet deduplicates by invocation submission key and preserves the first full draft', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });

    const first = await store.createOrGet(createInput());
    const replay = await store.createOrGet(createInput({ draft: draft('重试请求不应覆盖原稿') }));
    const anotherInvocation = await store.createOrGet(
      createInput({ invocationId: 'inv-2', draft: draft('另一个 invocation 的稿件') }),
    );

    assert.equal(first.outcome, 'created');
    assert.equal(replay.outcome, 'existing');
    assert.equal(replay.hold.id, first.hold.id);
    assert.deepEqual(replay.hold.draft, draft());
    assert.equal(anotherInvocation.outcome, 'created');
    assert.notEqual(anotherInvocation.hold.id, first.hold.id);
  });

  it('claimReview is a version CAS with exactly one concurrent winner', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });
    const held = await createHeld(store);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claimReview(held.id, { expectedVersion: held.version, now: NOW + 1 })),
    );
    const winners = results.filter((result) => result !== null);

    assert.equal(winners.length, 1);
    assert.equal(winners[0].status, 'reviewing');
    assert.equal(winners[0].version, held.version + 1);
    assert.equal(results.filter((result) => result === null).length, 19);
  });

  it('supports rehold, release and discard, then fails closed after two reviews', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });

    const limited = await createHeld(store, { submissionKey: 'limit-key' });
    const reviewing1 = await store.claimReview(limited.id, { expectedVersion: limited.version, now: NOW + 1 });
    assert.ok(reviewing1);
    const reheld1 = await store.rehold(limited.id, {
      expectedVersion: reviewing1.version,
      observedWatermark: '13',
      deltaMessageIds: ['msg-13'],
      draft: draft('第一次改写稿'),
      now: NOW + 2,
    });
    assert.equal(reheld1.status, 'held');
    assert.equal(reheld1.reviewCount, 1);
    assert.deepEqual(reheld1.draft, draft('第一次改写稿'));

    const reviewing2 = await store.claimReview(reheld1.id, { expectedVersion: reheld1.version, now: NOW + 3 });
    assert.ok(reviewing2);
    const exhausted = await store.rehold(reheld1.id, {
      expectedVersion: reviewing2.version,
      observedWatermark: '14',
      deltaMessageIds: ['msg-14'],
      draft: draft('第二次改写稿'),
      now: NOW + 4,
    });
    assert.equal(exhausted.status, 'needs_attention');
    assert.equal(exhausted.reviewCount, 2);
    assert.equal(exhausted.attentionReason, 'review_limit');
    assert.deepEqual(exhausted.draft, draft('第二次改写稿'));
    assert.equal(await store.claimReview(exhausted.id, { expectedVersion: exhausted.version, now: NOW + 5 }), null);

    const releasable = await createHeld(store, { invocationId: 'inv-release', submissionKey: 'release-key' });
    const releaseClaim = await store.claimReview(releasable.id, {
      expectedVersion: releasable.version,
      now: NOW + 6,
    });
    const released = await store.release(releasable.id, {
      expectedVersion: releaseClaim.version,
      messageId: 'msg-published',
      committedWatermark: '15',
      now: NOW + 7,
    });
    assert.equal(released.status, 'released');
    assert.equal(released.releasedMessageId, 'msg-published');
    assert.equal(released.committedWatermark, '15');

    const discardable = await createHeld(store, { invocationId: 'inv-discard', submissionKey: 'discard-key' });
    const discarded = await store.discard(discardable.id, {
      expectedVersion: discardable.version,
      now: NOW + 8,
    });
    assert.equal(discarded.status, 'discarded');
    assert.equal(await store.discard(discardable.id, { expectedVersion: discardable.version, now: NOW + 9 }), null);
  });

  it('moves timed-out holds to needs_attention without deleting the draft', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });
    const fullDraft = draft('超时后仍需完整保留的稿件');
    const held = await createHeld(store, {
      submissionKey: 'timeout-key',
      draft: fullDraft,
      reviewDeadlineAt: NOW + 100,
    });

    assert.equal(await store.expireDue(NOW + 99), 0);
    assert.equal(await store.expireDue(NOW + 100), 1);

    const retained = await store.get(held.id);
    assert.equal(retained.status, 'needs_attention');
    assert.equal(retained.attentionReason, 'timeout');
    assert.deepEqual(retained.draft, fullDraft);
  });
});
