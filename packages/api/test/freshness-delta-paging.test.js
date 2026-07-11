import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

let FreshnessEgressGate;
let FreshnessHoldStore;
let MessageStore;

const USER_ID = 'user-freshness-paging';
const CAT_ID = 'opus';
const AUDIENCE = { kind: 'cat', catId: CAT_ID };

function inbound(threadId, content, timestamp) {
  return {
    userId: USER_ID,
    catId: null,
    threadId,
    content,
    mentions: [CAT_ID],
    timestamp,
    messageClass: 'substantive',
    deliveryStatus: 'queued',
  };
}

describe('Freshness delta paging', () => {
  before(async () => {
    ({ FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'));
    ({ FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js'));
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  });

  test('a bounded delta advances only to the last returned message', async () => {
    const store = new MessageStore();
    const threadId = 'freshness-delta-memory-paging';
    const baseline = await store.captureFreshnessWatermark(threadId, AUDIENCE);
    const messages = [
      store.append(inbound(threadId, 'page one', 100)),
      store.append(inbound(threadId, 'page two', 101)),
      store.append(inbound(threadId, 'page three', 102)),
    ];

    const first = await store.getFreshnessDelta(threadId, AUDIENCE, baseline, undefined, 1);
    assert.deepEqual(
      first.messages.map((message) => message.id),
      [messages[0].id],
    );
    assert.equal(first.observedWatermark, messages[0].appendWatermark);
    assert.equal(first.truncated, true);

    const second = await store.getFreshnessDelta(threadId, AUDIENCE, first.observedWatermark, undefined, 1);
    assert.deepEqual(
      second.messages.map((message) => message.id),
      [messages[1].id],
    );
    assert.equal(second.observedWatermark, messages[1].appendWatermark);
    assert.equal(second.truncated, true);

    const third = await store.getFreshnessDelta(threadId, AUDIENCE, second.observedWatermark, undefined, 1);
    assert.deepEqual(
      third.messages.map((message) => message.id),
      [messages[2].id],
    );
    assert.equal(third.observedWatermark, messages[2].appendWatermark);
    assert.equal(third.truncated, false);
  });

  test('three bounded pages exhaust two reviews as needs_attention without publishing', async () => {
    const messageStore = new MessageStore();
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const gate = new FreshnessEgressGate({ messageStore, holdStore, maxDeltaMessages: 1 });
    const threadId = 'freshness-gate-memory-paging';
    const baseline = await messageStore.captureFreshnessWatermark(threadId, AUDIENCE);
    const messages = [
      messageStore.append(inbound(threadId, 'page one', 200)),
      messageStore.append(inbound(threadId, 'page two', 201)),
      messageStore.append(inbound(threadId, 'page three', 202)),
    ];
    const draft = {
      userId: USER_ID,
      catId: CAT_ID,
      threadId,
      content: 'draft created from the old context',
      mentions: [],
      timestamp: 203,
      messageClass: 'substantive',
      origin: 'callback',
    };

    const initial = await gate.submit({
      invocationId: 'freshness-paging-invocation',
      submissionKey: 'freshness-paging-submission',
      userId: USER_ID,
      catId: CAT_ID,
      threadId,
      baselineWatermark: baseline,
      draft,
      now: 1_000,
    });
    assert.equal(initial.outcome, 'held');
    assert.deepEqual(
      initial.delta.messages.map((message) => message.id),
      [messages[0].id],
    );
    assert.equal(initial.hold.observedWatermark, messages[0].appendWatermark);
    assert.equal(initial.delta.truncated, true);

    const firstReview = await gate.review({
      invocationId: 'freshness-paging-invocation',
      userId: USER_ID,
      catId: CAT_ID,
      threadId,
      holdId: initial.hold.id,
      expectedVersion: initial.hold.version,
      action: 'send_draft',
      now: 1_001,
    });
    assert.equal(firstReview.outcome, 'held');
    assert.equal(firstReview.hold.reviewCount, 1);
    assert.deepEqual(
      firstReview.delta.messages.map((message) => message.id),
      [messages[1].id],
    );
    assert.equal(firstReview.hold.observedWatermark, messages[1].appendWatermark);
    assert.equal(firstReview.delta.truncated, true);

    const secondReview = await gate.review({
      invocationId: 'freshness-paging-invocation',
      userId: USER_ID,
      catId: CAT_ID,
      threadId,
      holdId: initial.hold.id,
      expectedVersion: firstReview.hold.version,
      action: 'send_draft',
      now: 1_002,
    });
    assert.equal(secondReview.outcome, 'needs_attention');
    assert.equal(secondReview.hold.status, 'needs_attention');
    assert.equal(secondReview.hold.reviewCount, 2);
    assert.equal(secondReview.hold.attentionReason, 'review_limit');
    assert.deepEqual(
      secondReview.delta.messages.map((message) => message.id),
      [messages[2].id],
    );
    assert.equal(secondReview.hold.observedWatermark, messages[2].appendWatermark);
    assert.equal(secondReview.delta.truncated, false);

    const replay = await gate.review({
      invocationId: 'freshness-paging-invocation',
      userId: USER_ID,
      catId: CAT_ID,
      threadId,
      holdId: initial.hold.id,
      expectedVersion: secondReview.hold.version,
      action: 'send_draft',
      now: 1_003,
    });
    assert.equal(replay.outcome, 'needs_attention');
    assert.deepEqual(
      replay.delta.messages.map((message) => message.id),
      [messages[2].id],
    );

    const stored = await messageStore.getByThread(threadId, 100, USER_ID);
    assert.equal(stored.filter((message) => message.catId === CAT_ID).length, 0);
  });
});
