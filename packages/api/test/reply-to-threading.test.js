/**
 * F121: replyTo threading — persist, validate, hydrate preview
 * RED → GREEN → REFACTOR
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('replyTo threading', () => {
  // ── StoredMessage persistence ──

  test('append() persists replyTo field', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Original message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const reply = store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'Reply to original',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
      replyTo: parent.id,
    });

    assert.equal(reply.replyTo, parent.id);
    const fetched = store.getById(reply.id);
    assert.equal(fetched?.replyTo, parent.id);
  });

  test('append() without replyTo leaves field undefined', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'No reply',
      mentions: [],
      timestamp: 1000,
    });

    assert.equal(msg.replyTo, undefined);
  });

  test('getByThread returns messages with replyTo intact', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Parent',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'Child',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
      replyTo: parent.id,
    });

    const messages = store.getByThread('thread-1');
    const child = messages.find((m) => m.content === 'Child');
    assert.equal(child?.replyTo, parent.id);
  });

  // ── replyPreview hydration helper ──

  test('hydrateReplyPreview returns sender + truncated content for existing parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: '这是一条很长的消息，需要被截断到八十个字符以内来显示预览内容，确保在引用气泡中不会太长影响阅读体验',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const preview = await hydrateReplyPreview(store, parent.id, { type: 'user' });
    assert.ok(preview);
    assert.equal(preview.senderCatId, 'opus');
    assert.ok(preview.content.length <= 80);
    assert.equal(preview.deleted, undefined);
  });

  test('hydrateReplyPreview returns deleted preview for soft-deleted parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Will be deleted',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    store.softDelete(parent.id, 'user-1');

    const preview = await hydrateReplyPreview(store, parent.id, { type: 'user' });
    assert.ok(preview);
    assert.equal(preview.deleted, true);
    assert.equal(preview.content, '');
  });

  test('hydrateReplyPreview returns null for nonexistent parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const preview = await hydrateReplyPreview(store, 'nonexistent-id', { type: 'user' });
    assert.equal(preview, null);
  });

  test('hydrateReplyPreview does not expose a queued freshness review publication', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();
    const privateDraft = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'PRIVATE_REPLY_PREVIEW_SENTINEL',
      mentions: [],
      timestamp: 1001,
      threadId: 'thread-1',
      deliveryStatus: 'queued',
      freshnessReviewPublication: true,
    });

    const preview = await hydrateReplyPreview(store, privateDraft.id, { type: 'user' });

    assert.equal(preview, null);
  });

  test('hydrateReplyPreview returns null senderCatId for user messages', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: null,
      content: 'User message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const preview = await hydrateReplyPreview(store, parent.id, { type: 'user' });
    assert.ok(preview);
    assert.equal(preview.senderCatId, null);
    assert.equal(preview.content, 'User message');
  });

  // ── whisper-hygiene: hydrateReplyPreview is the real security boundary for the
  // route-serial.ts a2aTriggerContent leak (whisper→hydrateReplyPreview→invocation
  // context of a possibly non-recipient cat). See whisper-hygiene-audit memory. ──

  test('whisper sentinel: non-recipient cat viewer gets no preview at all (fails closed, same as "not found")', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const whisper = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本',
      mentions: ['grok'],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['grok'],
    });

    const preview = await hydrateReplyPreview(store, whisper.id, { type: 'cat', catId: 'codex' });
    assert.equal(preview, null);
  });

  test('whisper sentinel (damaged relation): whisperTo missing on a whisper message → fail closed for any cat viewer', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const whisper = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      // whisperTo intentionally omitted — malformed/legacy relation.
    });

    const preview = await hydrateReplyPreview(store, whisper.id, { type: 'cat', catId: 'grok' });
    assert.equal(preview, null);
  });

  test('whisper sentinel: the actual recipient cat DOES get the real preview', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const whisper = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本',
      mentions: ['grok'],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['grok'],
    });

    const preview = await hydrateReplyPreview(store, whisper.id, { type: 'cat', catId: 'grok' });
    assert.ok(preview);
    assert.equal(preview.content, '悄悄改一下密钥轮换脚本');
    assert.equal(preview.visibility, 'whisper');
  });

  test('whisper sentinel: web owner viewer (type=user) always sees it — by design, not a leak', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const whisper = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本',
      mentions: ['grok'],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['grok'],
    });

    const preview = await hydrateReplyPreview(store, whisper.id, { type: 'user' });
    assert.ok(preview);
    assert.equal(preview.content, '悄悄改一下密钥轮换脚本');
  });

  test('public message: any cat viewer sees it (visibility filter is whisper-specific, not a general lockdown)', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const publicMsg = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '公开消息',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const preview = await hydrateReplyPreview(store, publicMsg.id, { type: 'cat', catId: 'codex' });
    assert.ok(preview);
    assert.equal(preview.content, '公开消息');
  });
});
