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
    extra: { targetCats: ['codex'] },
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
    await appendQueuedUserMessage(messageStore, '触发初始 hold');
    const held = await gate.submit(submission(baseline));
    assert.equal(held.outcome, 'held');

    const result = await gate.review({
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
    await appendQueuedUserMessage(messageStore, '触发待丢弃 hold');
    const held = await gate.submit(submission(baseline));
    assert.equal(held.outcome, 'held');

    const result = await gate.review({
      holdId: held.hold.id,
      expectedVersion: held.hold.version,
      action: 'discard',
      now: NOW + 40,
    });

    assert.equal(result.outcome, 'discarded');
    assert.equal(result.hold.status, 'discarded');
    assert.deepEqual(await holdStore.get(held.hold.id), result.hold);
    assert.equal((await formalCatMessages(messageStore)).length, 0);
  });
});
