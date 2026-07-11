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
    assert.deepEqual(await store.getBySubmission('inv-1', 'client-message-1'), first.hold);
    assert.equal(await store.getBySubmission('inv-1', 'missing'), null);
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

  it('scrubs resolved draft and delta while preserving release/discard tombstones', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });

    const releasePrefix = 'MEMORY-RELEASE-PRIVATE';
    const releasable = await createHeld(store, {
      invocationId: 'inv-private-release',
      submissionKey: 'private-release',
      draft: privateDraft(releasePrefix),
      deltaMessageIds: [`${releasePrefix}-DELTA`],
    });
    const claimed = await store.claimReview(releasable.id, {
      expectedVersion: releasable.version,
      now: NOW + 1,
    });
    const released = await store.release(releasable.id, {
      expectedVersion: claimed.version,
      messageId: 'released-message-id',
      committedWatermark: '13',
      now: NOW + 2,
    });

    assert.equal(released.status, 'released');
    assert.equal(released.releasedMessageId, 'released-message-id');
    assert.equal(released.committedWatermark, '13');
    assert.equal(released.invocationId, 'inv-private-release');
    assert.equal(released.submissionKey, 'private-release');
    assertPrivatePayloadScrubbed(released, releasePrefix);
    assertPrivatePayloadScrubbed(await store.get(releasable.id), releasePrefix);
    const releaseReplay = await store.createOrGet(
      createInput({
        invocationId: 'inv-private-release',
        submissionKey: 'private-release',
        draft: privateDraft(releasePrefix),
        deltaMessageIds: [`${releasePrefix}-DELTA`],
      }),
    );
    assert.equal(releaseReplay.outcome, 'existing');
    assert.equal(releaseReplay.hold.id, releasable.id);
    assertPrivatePayloadScrubbed(releaseReplay.hold, releasePrefix);

    const discardPrefix = 'MEMORY-DISCARD-PRIVATE';
    const discardable = await createHeld(store, {
      invocationId: 'inv-private-discard',
      submissionKey: 'private-discard',
      draft: privateDraft(discardPrefix),
      deltaMessageIds: [`${discardPrefix}-DELTA`],
    });
    const discarded = await store.discard(discardable.id, {
      expectedVersion: discardable.version,
      now: NOW + 3,
    });

    assert.equal(discarded.status, 'discarded');
    assert.equal(discarded.invocationId, 'inv-private-discard');
    assert.equal(discarded.submissionKey, 'private-discard');
    assertPrivatePayloadScrubbed(discarded, discardPrefix);
    assertPrivatePayloadScrubbed(await store.getBySubmission('inv-private-discard', 'private-discard'), discardPrefix);
    assert.equal(await store.discard(discardable.id, { expectedVersion: discarded.version, now: NOW + 4 }), null);
  });

  it('moves timed-out holds to needs_attention without deleting the draft', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });
    const fullDraft = privateDraft('MEMORY-ATTENTION-PRIVATE');
    const held = await createHeld(store, {
      submissionKey: 'timeout-key',
      draft: fullDraft,
      deltaMessageIds: ['MEMORY-ATTENTION-PRIVATE-DELTA'],
      reviewDeadlineAt: NOW + 100,
    });

    assert.equal(await store.expireDue(NOW + 99), 0);
    assert.equal(await store.expireDue(NOW + 100), 1);

    const retained = await store.get(held.id);
    assert.equal(retained.status, 'needs_attention');
    assert.equal(retained.attentionReason, 'timeout');
    assert.deepEqual(retained.draft, fullDraft);
    assert.deepEqual(retained.deltaMessageIds, ['MEMORY-ATTENTION-PRIVATE-DELTA']);
  });

  it('fails closed when a claimed review crosses its deadline before release or rehold', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });

    for (const transition of ['release', 'rehold']) {
      const held = await createHeld(store, {
        invocationId: `inv-late-${transition}`,
        submissionKey: `late-${transition}`,
        reviewDeadlineAt: NOW + 10,
      });
      const claimed = await store.claimReview(held.id, { expectedVersion: held.version, now: NOW + 9 });
      assert.ok(claimed);

      const result =
        transition === 'release'
          ? await store.release(held.id, {
              expectedVersion: claimed.version,
              messageId: `msg-${transition}`,
              committedWatermark: '15',
              now: NOW + 10,
            })
          : await store.rehold(held.id, {
              expectedVersion: claimed.version,
              observedWatermark: '15',
              deltaMessageIds: ['msg-15'],
              draft: draft('deadline 后不得重新进入待审'),
              now: NOW + 10,
            });

      assert.equal(result, null);
      const retained = await store.get(held.id);
      assert.equal(retained.status, 'needs_attention');
      assert.equal(retained.attentionReason, 'timeout');
      assert.deepEqual(retained.draft, draft());
    }
  });

  it('lists only active holds for the requested user and thread', async () => {
    const store = new FreshnessHoldStore({ maxReviews: 2 });
    const held = await createHeld(store, {
      invocationId: 'inv-active-held',
      submissionKey: 'active-held',
      createdAt: NOW + 1,
    });
    const reviewing = await createHeld(store, {
      invocationId: 'inv-active-reviewing',
      submissionKey: 'active-reviewing',
      createdAt: NOW + 2,
    });
    await store.claimReview(reviewing.id, { expectedVersion: reviewing.version, now: NOW + 3 });

    const needsAttention = await createHeld(store, {
      invocationId: 'inv-active-attention',
      submissionKey: 'active-attention',
      createdAt: NOW + 4,
      reviewDeadlineAt: NOW + 5,
    });
    await store.expireDue(NOW + 5);

    const releasable = await createHeld(store, {
      invocationId: 'inv-resolved-released',
      submissionKey: 'resolved-released',
      createdAt: NOW + 6,
    });
    const releaseClaim = await store.claimReview(releasable.id, {
      expectedVersion: releasable.version,
      now: NOW + 7,
    });
    await store.release(releasable.id, {
      expectedVersion: releaseClaim.version,
      messageId: 'released-message',
      committedWatermark: '16',
      now: NOW + 8,
    });

    const discarded = await createHeld(store, {
      invocationId: 'inv-resolved-discarded',
      submissionKey: 'resolved-discarded',
      createdAt: NOW + 9,
    });
    await store.discard(discarded.id, { expectedVersion: discarded.version, now: NOW + 10 });

    await createHeld(store, {
      invocationId: 'inv-other-user',
      submissionKey: 'other-user',
      userId: 'user-2',
      createdAt: NOW + 11,
    });
    await createHeld(store, {
      invocationId: 'inv-other-thread',
      submissionKey: 'other-thread',
      threadId: 'thread-2',
      createdAt: NOW + 12,
    });

    const active = await store.listActive('user-1', 'thread-1');
    assert.deepEqual(
      active.map((record) => [record.id, record.status]),
      [
        [needsAttention.id, 'needs_attention'],
        [reviewing.id, 'reviewing'],
        [held.id, 'held'],
      ],
    );
  });
});
