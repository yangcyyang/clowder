import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for reminder scheduler');
}

describe('AgentReminderScheduler', () => {
  it('bubbles due reminder into the thread and marks it fired', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'clowder-reminder-scheduler-'));
    const { AgentReminderStore } = await import('../dist/domains/cats/services/reminders/AgentReminderStore.js');
    const { startAgentReminderScheduler } = await import(
      '../dist/domains/cats/services/reminders/AgentReminderScheduler.js'
    );
    const store = new AgentReminderStore(join(tempDir, 'reminders.json'));
    const reminder = await store.schedule({
      catId: 'codex',
      threadId: 'thread-1',
      sourceMessageId: 'msg-1',
      message: '跟进这条消息',
      fireAt: Date.now() - 1000,
    });
    const messageStore = {
      append: mock.fn(async (input) => ({
        id: 'connector-msg-1',
        content: input.content,
        timestamp: Date.now(),
      })),
    };
    const threadStore = { get: mock.fn(async () => ({ id: 'thread-1', createdBy: 'user-1' })) };
    const invocationQueue = { enqueue: mock.fn(() => ({ outcome: 'enqueued' })) };
    const queueProcessor = { tryAutoExecute: mock.fn(async () => {}) };
    const socketManager = { broadcastToRoom: mock.fn() };
    const log = { warn: mock.fn() };

    const stop = startAgentReminderScheduler({
      store,
      messageStore,
      threadStore,
      invocationQueue,
      queueProcessor,
      socketManager,
      log,
      intervalMs: 10_000,
    });

    try {
      await waitFor(async () => {
        const [stored] = await store.list({ status: 'fired' });
        return stored?.id === reminder.id;
      });
    } finally {
      stop();
      await rm(tempDir, { recursive: true, force: true });
    }

    assert.equal(messageStore.append.mock.calls.length, 1);
    const appendArg = messageStore.append.mock.calls[0].arguments[0];
    assert.equal(appendArg.threadId, 'thread-1');
    assert.match(appendArg.content, /提醒到期/);
    assert.deepEqual(appendArg.mentions, ['codex']);

    assert.equal(socketManager.broadcastToRoom.mock.calls.length, 1);
    const [room, event, payload] = socketManager.broadcastToRoom.mock.calls[0].arguments;
    assert.equal(room, 'thread:thread-1');
    assert.equal(event, 'connector_message');
    assert.equal(payload.message.id, 'connector-msg-1');

    assert.equal(invocationQueue.enqueue.mock.calls.length, 1);
    const enqueueArg = invocationQueue.enqueue.mock.calls[0].arguments[0];
    assert.equal(enqueueArg.threadId, 'thread-1');
    assert.deepEqual(enqueueArg.targetCats, ['codex']);
    assert.equal(enqueueArg.idempotencyKey, `reminder:${reminder.id}`);
    assert.equal(queueProcessor.tryAutoExecute.mock.calls.length, 1);
  });
});
