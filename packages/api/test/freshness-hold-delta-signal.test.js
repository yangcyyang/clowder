/**
 * [thread-task-design] §5.3 point 3 / §5B.4: "claim/提交时如有未读新消息，先拦下让 agent
 * 看完再重试". claimCallbackSideEffect (callback-freshness-side-effect.ts) already returns
 * a 'stale' outcome carrying opaque baseline/observed watermarks when a protected callback
 * (e.g. claim-task) is attempted after a newer message landed in the thread. That alone is
 * enough to block a stale action, but it isn't actionable: the caller only learns "retry",
 * not *what* changed.
 *
 * describeFreshnessHoldDelta / withFreshnessHoldDelta read the concrete delta (unread count
 * + latest message id) off the same appendWatermark/msg:freshness mechanism MessageStore
 * already uses to compute staleness — turning the hold into a structured signal a caller
 * can act on (inject the unread messages, then retry) instead of a blind retry loop.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let MessageStore;
let describeFreshnessHoldDelta;
let withFreshnessHoldDelta;

const audience = (catId) => ({ kind: 'cat', catId });

describe('freshness hold delta signal', () => {
  before(async () => {
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ describeFreshnessHoldDelta, withFreshnessHoldDelta } = await import(
      '../dist/routes/callback-freshness-side-effect.js'
    ));
  });

  it('reports zero unread when nothing was appended after the baseline', async () => {
    const store = new MessageStore();
    const threadId = 't-no-delta';
    const baseline = store.captureFreshnessWatermark(threadId, audience('opus'));

    const result = await describeFreshnessHoldDelta({
      messageStore: store,
      catId: 'opus',
      threadId,
      baselineWatermark: baseline,
      observedWatermark: baseline,
    });

    assert.equal(result.unreadCount, 0);
    assert.equal(result.latestMessageId, undefined);
    assert.equal(result.truncated, false);
  });

  it('reports unread count and the latest message id for messages appended after the baseline', async () => {
    const store = new MessageStore();
    const threadId = 't-with-delta';
    const baseline = store.captureFreshnessWatermark(threadId, audience('opus'));

    store.append({ userId: 'user-1', threadId, catId: null, content: 'first unread', mentions: [] });
    const second = store.append({ userId: 'user-1', threadId, catId: null, content: 'second unread', mentions: [] });
    const observed = store.captureFreshnessWatermark(threadId, audience('opus'));

    const result = await describeFreshnessHoldDelta({
      messageStore: store,
      catId: 'opus',
      threadId,
      baselineWatermark: baseline,
      observedWatermark: observed,
    });

    assert.equal(result.unreadCount, 2);
    assert.equal(result.latestMessageId, second.id, 'latestMessageId must be the newest unread message');
    assert.equal(result.truncated, false);
  });

  it('marks truncated when more unread messages exist past the limit', async () => {
    const store = new MessageStore();
    const threadId = 't-truncated';
    const baseline = store.captureFreshnessWatermark(threadId, audience('opus'));
    for (let i = 0; i < 5; i++) {
      store.append({ userId: 'user-1', threadId, catId: null, content: `msg ${i}`, mentions: [] });
    }
    const observed = store.captureFreshnessWatermark(threadId, audience('opus'));

    const result = await describeFreshnessHoldDelta({
      messageStore: store,
      catId: 'opus',
      threadId,
      baselineWatermark: baseline,
      observedWatermark: observed,
      limit: 2,
    });

    assert.equal(result.unreadCount, 2, 'unreadCount is capped by limit');
    assert.equal(result.truncated, true, 'truncated must signal the count is a floor, not exact');
  });

  it('withFreshnessHoldDelta enriches a stale claimCallbackSideEffect response with the delta', async () => {
    const store = new MessageStore();
    const threadId = 't-wrapper';
    const baseline = store.captureFreshnessWatermark(threadId, audience('opus'));
    const unread = store.append({ userId: 'user-1', threadId, catId: null, content: 'unread', mentions: [] });
    const observed = store.captureFreshnessWatermark(threadId, audience('opus'));

    const stale = {
      outcome: 'stale',
      response: {
        status: 'freshness_retry_required',
        disposition: 'held',
        threadId,
        retryRequired: true,
        baselineWatermark: baseline,
        observedWatermark: observed,
      },
    };

    const enriched = await withFreshnessHoldDelta(stale, { messageStore: store, catId: 'opus' });

    assert.equal(enriched.status, 'freshness_retry_required', 'original response fields must be preserved');
    assert.equal(enriched.retryRequired, true);
    assert.equal(enriched.unreadCount, 1);
    assert.equal(enriched.latestMessageId, unread.id);
    assert.equal(enriched.truncated, false);
  });

  it('withFreshnessHoldDelta falls back to the bare response when watermarks are missing', async () => {
    const store = new MessageStore();
    const stale = {
      outcome: 'stale',
      response: { status: 'stale_ignored', disposition: 'held', threadId: 't-legacy' },
    };

    const result = await withFreshnessHoldDelta(stale, { messageStore: store, catId: 'opus' });

    assert.deepEqual(result, stale.response);
  });
});
