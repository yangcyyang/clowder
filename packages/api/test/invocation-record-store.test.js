/**
 * InvocationRecordStore Tests
 * 测试内存 InvocationRecord 存储
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('InvocationRecordStore', () => {
  test('create() returns created outcome with invocationId', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const result = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-1',
    });

    assert.equal(result.outcome, 'created');
    assert.ok(result.invocationId.length > 0);
    assert.equal(store.size, 1);
  });

  test('create() record has correct initial state', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'key-2',
    });

    const record = store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    assert.equal(record.phase, 'queued');
    assert.equal(record.userMessageId, null);
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.deepEqual(record.targetCats, ['opus', 'codex']);
    assert.equal(record.intent, 'ideate');
    assert.equal(record.idempotencyKey, 'key-2');
    assert.ok(record.createdAt > 0);
    assert.equal(record.createdAt, record.updatedAt);
  });

  test('create() preserves optional A2A caller and trigger fields', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'a2a-key',
      callerCatId: 'opus-45',
      a2aTriggerMessageId: 'msg-handoff-1',
    });

    const record = store.get(invocationId);
    assert.ok(record);
    assert.equal(record.callerCatId, 'opus-45');
    assert.equal(record.a2aTriggerMessageId, 'msg-handoff-1');
  });

  test('idempotency dedup returns duplicate on same key', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const first = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(first.outcome, 'created');

    const second = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.invocationId, first.invocationId);
    assert.equal(store.size, 1);
  });

  test('different threadId with same key does not dedup', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const first = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });
    const second = store.create({
      threadId: 'thread-2',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });

    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'created');
    assert.notEqual(first.invocationId, second.invocationId);
    assert.equal(store.size, 2);
  });

  test('get() returns null for non-existent id', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.equal(store.get('non-existent'), null);
  });

  test('update() changes status and updatedAt', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'upd-key',
    });

    const before = store.get(invocationId);
    assert.equal(before.status, 'queued');

    // Small delay to ensure updatedAt changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = store.update(invocationId, { status: 'running', phase: 'runtime_starting' });
    assert.equal(updated.status, 'running');
    assert.equal(updated.phase, 'runtime_starting');
    assert.ok(updated.updatedAt >= before.updatedAt);
  });

  test('update() backfills userMessageId', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'backfill-key',
    });

    assert.equal(store.get(invocationId).userMessageId, null);

    store.update(invocationId, { userMessageId: 'msg-123' });
    assert.equal(store.get(invocationId).userMessageId, 'msg-123');
  });

  test('update() stores an isolated userMessageIds batch audit trail', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-batch',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'batch-audit-key',
    });
    const sourceIds = ['msg-1', 'msg-2', 'msg-3', 'msg-4'];

    store.update(invocationId, { userMessageIds: sourceIds });
    sourceIds.push('mutated-after-update');

    assert.deepEqual(store.get(invocationId).userMessageIds, ['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  test('update() sets error on failed status', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'err-key',
    });

    store.update(invocationId, { status: 'running' });
    store.update(invocationId, { status: 'failed', error: 'CLI timeout' });
    const record = store.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI timeout');
  });

  test('F8: update() stores usageByCat and get() returns it', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'usage-key',
    });

    const usageByCat = {
      opus: { inputTokens: 1000, outputTokens: 500, costUsd: 0.03 },
      codex: { inputTokens: 200, outputTokens: 100 },
    };

    store.update(invocationId, { status: 'running' });
    store.update(invocationId, { status: 'succeeded', usageByCat });

    const record = store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'succeeded');
    assert.deepEqual(record.usageByCat, usageByCat);
    assert.equal(record.usageByCat.opus.inputTokens, 1000);
    assert.equal(record.usageByCat.codex.outputTokens, 100);
  });

  test('update() returns null for non-existent id', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    assert.equal(store.update('non-existent', { status: 'running' }), null);
  });

  test('getByIdempotencyKey() finds record by composite key', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const { invocationId } = store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'lookup-key',
    });

    const found = store.getByIdempotencyKey('thread-1', 'user-1', 'lookup-key');
    assert.ok(found);
    assert.equal(found.id, invocationId);
  });

  test('getByIdempotencyKey() returns null for wrong scope', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scoped-key',
    });

    assert.equal(store.getByIdempotencyKey('thread-2', 'user-1', 'scoped-key'), null);
    assert.equal(store.getByIdempotencyKey('thread-1', 'user-2', 'scoped-key'), null);
  });

  test('bounded capacity evicts oldest records', async () => {
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore({ maxRecords: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const result = store.create({
        threadId: 'thread-1',
        userId: 'user-1',
        targetCats: ['opus'],
        intent: 'execute',
        idempotencyKey: `cap-key-${i}`,
      });
      ids.push(result.invocationId);
    }

    assert.equal(store.size, 3);
    // Oldest records should be evicted
    assert.equal(store.get(ids[0]), null);
    assert.equal(store.get(ids[1]), null);
    // Newest should remain
    assert.ok(store.get(ids[2]));
    assert.ok(store.get(ids[3]));
    assert.ok(store.get(ids[4]));
  });
});
