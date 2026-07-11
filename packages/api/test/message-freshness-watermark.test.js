/**
 * Freshness Hold Task 1 — in-memory MessageStore RED tests.
 *
 * These tests define the append-watermark contract before production support
 * exists. Watermarks are opaque decimal strings; tests convert them to BigInt
 * only to assert monotonic storage behavior, never as application logic.
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

let MessageStore;

const audience = (catId) => ({ kind: 'cat', catId });

function assertWatermark(value, label = 'watermark') {
  assert.equal(typeof value, 'string', `${label} must be an opaque decimal string`);
  assert.match(value, /^\d+$/, `${label} must contain only decimal digits`);
  return BigInt(value);
}

async function capture(store, threadId, catId) {
  assert.equal(
    typeof store.captureFreshnessWatermark,
    'function',
    'Task 1 requires MessageStore.captureFreshnessWatermark()',
  );
  return Promise.resolve(store.captureFreshnessWatermark(threadId, audience(catId)));
}

describe('MessageStore freshness watermark', () => {
  before(async () => {
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  });

  test('orders substantive appends by revision when timestamps are identical', async () => {
    const store = new MessageStore();
    const threadId = 'freshness-same-timestamp';
    const timestamp = 1_725_000_000_000;

    const first = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'first',
      mentions: [],
      timestamp,
    });
    const second = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'second',
      mentions: [],
      timestamp,
    });

    const firstRevision = assertWatermark(first.appendWatermark, 'first appendWatermark');
    const secondRevision = assertWatermark(second.appendWatermark, 'second appendWatermark');
    assert.ok(secondRevision > firstRevision, 'append revision must advance independently of timestamp and MessageId');
    assert.equal(await capture(store, threadId, 'opus'), second.appendWatermark);
  });

  test('queued advances immediately, delivered does not advance again, and canceled is removed', async () => {
    const store = new MessageStore();
    const threadId = 'freshness-delivery-lifecycle';
    const initial = await capture(store, threadId, 'opus');

    const firstQueued = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'queued then delivered',
      mentions: ['opus'],
      timestamp: 100,
      deliveryStatus: 'queued',
    });
    const queuedWatermark = await capture(store, threadId, 'opus');
    assert.ok(assertWatermark(queuedWatermark) > assertWatermark(initial), 'queued append must advance immediately');
    assert.equal(queuedWatermark, firstQueued.appendWatermark);

    store.markDelivered(firstQueued.id, 10_000);
    assert.equal(
      await capture(store, threadId, 'opus'),
      queuedWatermark,
      'markDelivered must not allocate a second freshness revision',
    );

    const secondQueued = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'queued then canceled',
      mentions: ['opus'],
      timestamp: 50,
      deliveryStatus: 'queued',
    });
    assert.ok(
      assertWatermark(await capture(store, threadId, 'opus')) > assertWatermark(queuedWatermark),
      'a later queued append must advance even when its timestamp goes backwards',
    );

    store.markCanceled(secondQueued.id);
    assert.equal(
      await capture(store, threadId, 'opus'),
      queuedWatermark,
      'canceling the latest queued message must remove it from the active freshness index',
    );
  });

  test('status, system, and briefing messages are structurally exempt', async () => {
    const store = new MessageStore();
    const threadId = 'freshness-structural-exemptions';
    const baseline = await capture(store, threadId, 'opus');

    store.append({
      userId: 'user-1',
      catId: 'opus',
      threadId,
      content: 'still working',
      mentions: [],
      timestamp: 1,
      messageClass: 'status',
    });
    store.append({
      userId: 'system',
      catId: null,
      threadId,
      content: 'routing notice',
      mentions: [],
      timestamp: 2,
      extra: { systemKind: 'a2a_routing' },
    });
    store.append({
      userId: 'user-1',
      catId: 'opus',
      threadId,
      content: 'context briefing',
      mentions: [],
      timestamp: 3,
      origin: 'briefing',
    });

    assert.equal(
      await capture(store, threadId, 'opus'),
      baseline,
      'trusted structural fields must exempt noise without content guessing',
    );

    const substantive = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'new instruction',
      mentions: ['opus'],
      timestamp: 3,
    });
    assert.equal(await capture(store, threadId, 'opus'), substantive.appendWatermark);
  });

  test('whisper advances only recipient audiences while public messages advance all cats', async () => {
    const store = new MessageStore();
    const threadId = 'freshness-whisper-audience';
    const opusBaseline = await capture(store, threadId, 'opus');
    const codexBaseline = await capture(store, threadId, 'codex');

    const whisper = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'only opus may see this',
      mentions: ['opus'],
      timestamp: 10,
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    assert.equal(await capture(store, threadId, 'opus'), whisper.appendWatermark);
    assert.equal(
      await capture(store, threadId, 'codex'),
      codexBaseline,
      'an invisible whisper must not make another cat stale',
    );

    const publicMessage = store.append({
      userId: 'user-1',
      catId: null,
      threadId,
      content: 'public update',
      mentions: [],
      timestamp: 10,
    });

    assert.ok(assertWatermark(publicMessage.appendWatermark) > assertWatermark(whisper.appendWatermark));
    assert.equal(await capture(store, threadId, 'opus'), publicMessage.appendWatermark);
    assert.equal(await capture(store, threadId, 'codex'), publicMessage.appendWatermark);
    assert.equal(opusBaseline, codexBaseline, 'empty thread audiences start from the same baseline');
  });
});
