import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FreshnessEgressGate } from '../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import { FreshnessHoldStore } from '../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const USER_ID = 'user-freshness-gate';
const CAT_ID = 'opus';
const THREAD_ID = 'thread-freshness-gate';
const NOW = Date.now();

function createHarness(options = {}) {
  const messageStore = new MessageStore();
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const gate = new FreshnessEgressGate({
    messageStore,
    holdStore,
    maxDeltaMessages: options.maxDeltaMessages,
  });
  return { messageStore, holdStore, gate };
}

function audience() {
  return { kind: 'cat', catId: CAT_ID };
}

function draft(content = '基于旧上下文形成的完整稿件') {
  return {
    userId: USER_ID,
    catId: CAT_ID,
    threadId: THREAD_ID,
    content,
    mentions: [],
    timestamp: NOW,
    messageClass: 'substantive',
    origin: 'callback',
    replyTo: 'msg-parent',
    extra: {
      targetCats: ['codex'],
      stream: { invocationId: 'invocation-freshness-gate' },
    },
  };
}

function submission(baselineWatermark, overrides = {}) {
  return {
    invocationId: 'invocation-freshness-gate',
    submissionKey: 'callback-client-message',
    userId: USER_ID,
    catId: CAT_ID,
    threadId: THREAD_ID,
    baselineWatermark,
    draft: draft(),
    ...overrides,
  };
}

function reviewIdentity(overrides = {}) {
  return {
    invocationId: 'invocation-freshness-gate',
    userId: USER_ID,
    catId: CAT_ID,
    threadId: THREAD_ID,
    ...overrides,
  };
}

async function appendQueuedUserMessage(messageStore, content, timestamp = NOW + 1) {
  return messageStore.append({
    userId: USER_ID,
    catId: null,
    threadId: THREAD_ID,
    content,
    mentions: [CAT_ID],
    timestamp,
    messageClass: 'substantive',
    deliveryStatus: 'queued',
  });
}

async function formalCatMessages(messageStore) {
  const messages = await messageStore.getByThread(THREAD_ID, 100, USER_ID);
  return messages.filter((message) => message.catId === CAT_ID && message.messageClass !== 'status');
}

describe('FreshnessEgressGate', () => {
  it('atomically publishes exactly once when the captured baseline is current', async () => {
    const { messageStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());

    const result = await gate.submit(submission(baseline));

    assert.equal(result.outcome, 'published');
    assert.equal(result.message.content, draft().content);
    assert.equal(result.message.replyTo, 'msg-parent');
    assert.deepEqual(result.message.extra?.targetCats, ['codex']);
    assert.deepEqual(
      (await formalCatMessages(messageStore)).map((message) => message.id),
      [result.message.id],
    );
  });

  it('derives one protected publication key and reports a successful submit retry as replayed', async () => {
    const { messageStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    const input = submission(baseline, { submissionKey: 'successful-submit-retry' });

    const first = await gate.submit(input);
    const retry = await gate.submit(input);

    assert.equal(first.outcome, 'published');
    assert.equal(retry.outcome, 'published');
    assert.equal(retry.replayed, true);
    assert.equal(retry.message.id, first.message.id);
    assert.deepEqual(
      (await formalCatMessages(messageStore)).map((message) => message.id),
      [first.message.id],
    );
  });

  it('creates a route-protected view that shares stores but always enables the freshness gate', async () => {
    const messageStore = new MessageStore();
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const rolloutGate = new FreshnessEgressGate({ messageStore, holdStore, isEnabledFor: () => false });
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '动态路由选中后到达的新消息');

    const protectedGate = rolloutGate.forProtectedRoute();
    const result = await protectedGate.submit(submission(baseline, { submissionKey: 'route-protected-view' }));

    assert.notEqual(protectedGate, rolloutGate);
    assert.equal(rolloutGate.isEnabledFor(THREAD_ID, CAT_ID), false);
    assert.equal(protectedGate.isEnabledFor(THREAD_ID, CAT_ID), true);
    assert.equal(result.outcome, 'held');
    assert.equal((await formalCatMessages(messageStore)).length, 0);
  });

  it('holds a stale draft with its bounded delta and appends no formal cat message', async () => {
    const { messageStore, holdStore, gate } = createHarness({ maxDeltaMessages: 1 });
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    const firstNewMessage = await appendQueuedUserMessage(messageStore, '这是生成期间到达的新消息');
    await appendQueuedUserMessage(messageStore, '这条使 delta 超出上限', NOW + 2);

    const result = await gate.submit(submission(baseline));

    assert.equal(result.outcome, 'held');
    assert.equal(result.hold.status, 'held');
    assert.equal(result.hold.baselineWatermark, baseline);
    assert.equal(result.delta.truncated, true);
    assert.deepEqual(
      result.delta.messages.map((message) => message.id),
      [firstNewMessage.id],
    );
    assert.deepEqual(result.hold.deltaMessageIds, [firstNewMessage.id]);
    assert.deepEqual(result.hold.draft, draft());
    assert.deepEqual(await holdStore.get(result.hold.id), result.hold);
    assert.equal((await formalCatMessages(messageStore)).length, 0);
  });

  it('returns the same hold and delta when the same submission is retried', async () => {
    const { messageStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '让首次提交进入 hold');
    const input = submission(baseline);

    const first = await gate.submit(input);
    const retry = await gate.submit(input);

    assert.equal(first.outcome, 'held');
    assert.equal(retry.outcome, 'held');
    assert.equal(retry.hold.id, first.hold.id);
    assert.equal(retry.hold.version, first.hold.version);
    assert.deepEqual(
      retry.delta.messages.map((message) => message.id),
      first.delta.messages.map((message) => message.id),
    );
    assert.equal((await formalCatMessages(messageStore)).length, 0);
  });

  it('send_draft rechecks atomically from the held observed watermark before releasing', async () => {
    const { messageStore, holdStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    const trigger = await appendQueuedUserMessage(messageStore, '触发初始 hold');
    const held = await gate.submit(submission(baseline));
    assert.equal(held.outcome, 'held');

    const result = await gate.review({
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      now: NOW + 10,
    });

    assert.equal(result.outcome, 'published');
    assert.equal(result.message.content, draft().content);
    assert.equal(result.hold.status, 'released');
    assert.equal(result.hold.releasedMessageId, result.message.id);
    assert.deepEqual(await holdStore.get(held.hold.id), result.hold);
    assert.deepEqual(
      (await formalCatMessages(messageStore)).map((message) => message.id),
      [result.message.id],
    );

    const reviewReplay = await gate.review({
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      now: NOW + 11,
    });
    assert.equal(reviewReplay.outcome, 'published');
    assert.equal(reviewReplay.replayed, true);
    assert.equal(reviewReplay.message.id, result.message.id);

    await messageStore.markCanceled(trigger.id);
    const submitReplay = await gate.submit(submission(baseline));
    assert.equal(submitReplay.outcome, 'published');
    assert.equal(submitReplay.replayed, true);
    assert.equal(submitReplay.message.id, result.message.id);
    assert.equal((await formalCatMessages(messageStore)).length, 1);
  });

  it('reholds one review conflict and fails closed as needs_attention on the second', async () => {
    const { messageStore, holdStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '触发初始 hold');
    const initial = await gate.submit(submission(baseline));
    assert.equal(initial.outcome, 'held');

    const firstConflictMessage = await appendQueuedUserMessage(messageStore, '第一次 review 期间的新消息', NOW + 20);
    const replacementDraft = draft('根据首批新消息改写的稿件');
    const reheld = await gate.review({
      ...reviewIdentity(),
      holdId: initial.hold.id,
      expectedVersion: initial.hold.version,
      action: 'replace',
      replacementDraft,
      now: NOW + 21,
    });

    assert.equal(reheld.outcome, 'held');
    assert.equal(reheld.hold.status, 'held');
    assert.equal(reheld.hold.reviewCount, 1);
    assert.deepEqual(reheld.hold.draft, replacementDraft);
    assert.deepEqual(reheld.hold.deltaMessageIds, [firstConflictMessage.id]);

    const secondConflictMessage = await appendQueuedUserMessage(messageStore, '第二次 review 期间的新消息', NOW + 30);
    const exhausted = await gate.review({
      ...reviewIdentity(),
      holdId: initial.hold.id,
      expectedVersion: reheld.hold.version,
      action: 'send_draft',
      now: NOW + 31,
    });

    assert.equal(exhausted.outcome, 'needs_attention');
    assert.equal(exhausted.hold.status, 'needs_attention');
    assert.equal(exhausted.hold.reviewCount, 2);
    assert.equal(exhausted.hold.attentionReason, 'review_limit');
    assert.deepEqual(exhausted.hold.draft, replacementDraft);
    assert.deepEqual(exhausted.hold.deltaMessageIds, [secondConflictMessage.id]);
    assert.deepEqual(await holdStore.get(initial.hold.id), exhausted.hold);
    assert.equal((await formalCatMessages(messageStore)).length, 0);
  });

  it('discard resolves the hold without publishing its draft', async () => {
    const { messageStore, holdStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    const trigger = await appendQueuedUserMessage(messageStore, '触发待丢弃 hold');
    const held = await gate.submit(submission(baseline));
    assert.equal(held.outcome, 'held');

    const result = await gate.review({
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'discard',
      now: NOW + 40,
    });

    assert.equal(result.outcome, 'discarded');
    assert.equal(result.hold.status, 'discarded');
    assert.deepEqual(await holdStore.get(held.hold.id), result.hold);
    assert.equal((await formalCatMessages(messageStore)).length, 0);

    const reviewReplay = await gate.review({
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'discard',
      now: NOW + 41,
    });
    assert.equal(reviewReplay.outcome, 'discarded');

    await messageStore.markCanceled(trigger.id);
    const submitReplay = await gate.submit(submission(baseline));
    assert.equal(submitReplay.outcome, 'discarded');
  });

  it('recovers a reviewing orphan after crashing between queued append and hold release', async () => {
    const messageStore = new MessageStore();
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const release = holdStore.release.bind(holdStore);
    let crashBeforeRelease = true;
    holdStore.release = async (...args) => {
      if (crashBeforeRelease) {
        crashBeforeRelease = false;
        throw new Error('simulated crash before release');
      }
      return release(...args);
    };
    const gate = new FreshnessEgressGate({ messageStore, holdStore });
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    const trigger = await appendQueuedUserMessage(messageStore, '触发 orphan recovery', NOW + 60);
    const held = await gate.submit(submission(baseline, { submissionKey: 'orphan-before-release' }));
    assert.equal(held.outcome, 'held');
    const input = {
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      now: NOW + 61,
    };

    await assert.rejects(gate.review(input), /simulated crash before release/);
    assert.equal((await holdStore.get(held.hold.id)).status, 'reviewing');
    assert.equal((await formalCatMessages(messageStore)).length, 0);

    const privateDelta = await messageStore.getFreshnessDelta(THREAD_ID, audience(), trigger.appendWatermark);
    assert.deepEqual(privateDelta.messages, []);
    assert.equal(privateDelta.observedWatermark, trigger.appendWatermark);
    assert.equal(privateDelta.truncated, true);
    assert.equal(JSON.stringify(privateDelta).includes(draft().content), false);

    const recovered = await gate.review(input);
    assert.equal(recovered.outcome, 'published');
    assert.equal(recovered.message.deliveryStatus, 'delivered');
    assert.equal((await formalCatMessages(messageStore)).length, 1);

    const deliveredDelta = await messageStore.getFreshnessDelta(THREAD_ID, audience(), trigger.appendWatermark);
    assert.deepEqual(
      deliveredDelta.messages.map((message) => message.id),
      [recovered.message.id],
    );
  });

  it('finishes delivery after crashing between hold release and markDelivered', async () => {
    const messageStore = new MessageStore();
    const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    const markDelivered = messageStore.markDelivered.bind(messageStore);
    let crashBeforeDelivery = true;
    messageStore.markDelivered = async (...args) => {
      if (crashBeforeDelivery) {
        crashBeforeDelivery = false;
        throw new Error('simulated crash before delivery');
      }
      return markDelivered(...args);
    };
    const gate = new FreshnessEgressGate({ messageStore, holdStore });
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '触发 released queued recovery', NOW + 70);
    const held = await gate.submit(submission(baseline, { submissionKey: 'orphan-after-release' }));
    assert.equal(held.outcome, 'held');
    const input = {
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      now: NOW + 71,
    };

    await assert.rejects(gate.review(input), /simulated crash before delivery/);
    const released = await holdStore.get(held.hold.id);
    assert.equal(released.status, 'released');
    assert.equal((await messageStore.getById(released.releasedMessageId)).deliveryStatus, 'queued');
    assert.equal((await formalCatMessages(messageStore)).length, 0);

    const recovered = await gate.review(input);
    assert.equal(recovered.outcome, 'published');
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.message.deliveryStatus, 'delivered');
    assert.equal((await formalCatMessages(messageStore)).length, 1);
  });

  it('does not let a concurrent recovery loser cancel the winner idempotent message', async () => {
    const { messageStore, holdStore, gate } = createHarness();
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '触发 concurrent recovery', NOW + 80);
    const held = await gate.submit(submission(baseline, { submissionKey: 'concurrent-recovery' }));
    assert.equal(held.outcome, 'held');
    const reviewing = await holdStore.claimReview(held.hold.id, {
      expectedVersion: held.hold.version,
      now: NOW + 81,
    });
    assert.equal(reviewing.status, 'reviewing');
    let canceled = 0;
    const markCanceled = messageStore.markCanceled.bind(messageStore);
    messageStore.markCanceled = async (...args) => {
      canceled += 1;
      return markCanceled(...args);
    };
    const input = {
      ...reviewIdentity(),
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'send_draft',
      now: NOW + 82,
    };

    const results = await Promise.all([gate.review(input), gate.review(input)]);
    assert.deepEqual(
      results.map((result) => result.outcome),
      ['published', 'published'],
    );
    assert.equal(new Set(results.map((result) => result.message.id)).size, 1);
    assert.equal(results[0].message.deliveryStatus, 'delivered');
    assert.equal(results[1].message.deliveryStatus, 'delivered');
    assert.equal(canceled, 0);
    assert.equal((await formalCatMessages(messageStore)).length, 1);
  });

  it('keeps the reviewed draft private when hold release loses a deadline race', async () => {
    const messageStore = new MessageStore();
    const backingHoldStore = new FreshnessHoldStore({ maxReviews: 2 });
    const racingHoldStore = {
      createOrGet: (...args) => backingHoldStore.createOrGet(...args),
      get: (...args) => backingHoldStore.get(...args),
      getBySubmission: (...args) => backingHoldStore.getBySubmission(...args),
      claimReview: (...args) => backingHoldStore.claimReview(...args),
      rehold: (...args) => backingHoldStore.rehold(...args),
      discard: (...args) => backingHoldStore.discard(...args),
      expireDue: (...args) => backingHoldStore.expireDue(...args),
      async release(id, input) {
        await backingHoldStore.expireDue(Number.MAX_SAFE_INTEGER);
        return backingHoldStore.release(id, input);
      },
    };
    const gate = new FreshnessEgressGate({ messageStore, holdStore: racingHoldStore });
    const baseline = await messageStore.captureFreshnessWatermark(THREAD_ID, audience());
    await appendQueuedUserMessage(messageStore, '触发 deadline race hold');
    const held = await gate.submit(submission(baseline, { submissionKey: 'deadline-race' }));
    assert.equal(held.outcome, 'held');

    await assert.rejects(
      gate.review({
        ...reviewIdentity(),
        holdId: held.hold.id,
        expectedVersion: held.hold.version,
        action: 'send_draft',
        now: NOW + 50,
      }),
      /release version conflict/,
    );

    assert.equal((await formalCatMessages(messageStore)).length, 0);
    const allMessages = await messageStore.getRecent(100, USER_ID);
    const attempted = allMessages.find((message) => message.catId === CAT_ID);
    assert.ok(!attempted || attempted.deliveryStatus !== 'delivered');
  });
});
