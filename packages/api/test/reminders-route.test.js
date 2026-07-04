import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Reminders Routes', () => {
  let app;
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'clowder-reminders-'));
    const { AgentReminderStore } = await import('../dist/domains/cats/services/reminders/AgentReminderStore.js');
    const { remindersRoutes } = await import('../dist/routes/reminders.js');
    app = Fastify({ logger: false });
    await app.register(remindersRoutes, {
      reminderStore: new AgentReminderStore(join(tempDir, 'reminders.json')),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores sourceMessageId and filters scheduled reminders by message anchor', async () => {
    const fireAt = Date.now() + 60_000;
    const create = await app.inject({
      method: 'POST',
      url: '/api/reminders',
      payload: {
        catId: 'codex',
        threadId: 'thread-1',
        sourceMessageId: 'msg-1',
        message: '跟进这条消息',
        fireAt,
      },
    });
    assert.equal(create.statusCode, 201);
    const created = JSON.parse(create.payload);
    assert.equal(created.sourceMessageId, 'msg-1');

    await app.inject({
      method: 'POST',
      url: '/api/reminders',
      payload: {
        catId: 'codex',
        threadId: 'thread-1',
        sourceMessageId: 'msg-2',
        message: '另一条消息',
        fireAt,
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/reminders?threadId=thread-1&sourceMessageId=msg-1&status=scheduled',
    });
    assert.equal(list.statusCode, 200);
    const body = JSON.parse(list.payload);
    assert.equal(body.reminders.length, 1);
    assert.equal(body.reminders[0].id, created.id);
  });

  it('returns the existing scheduled reminder for duplicate message anchors', async () => {
    const payload = {
      catId: 'codex',
      threadId: 'thread-1',
      sourceMessageId: 'msg-1',
      message: '跟进这条消息',
      fireAt: Date.now() + 60_000,
    };
    const first = await app.inject({ method: 'POST', url: '/api/reminders', payload });
    const second = await app.inject({
      method: 'POST',
      url: '/api/reminders',
      payload: { ...payload, message: '重复提交', fireAt: payload.fireAt + 60_000 },
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const firstBody = JSON.parse(first.payload);
    const secondBody = JSON.parse(second.payload);
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(secondBody.message, '跟进这条消息');

    const list = await app.inject({
      method: 'GET',
      url: '/api/reminders?threadId=thread-1&sourceMessageId=msg-1&status=scheduled',
    });
    assert.equal(JSON.parse(list.payload).reminders.length, 1);
  });

  it('cancels a message-anchored reminder', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/reminders',
      payload: {
        catId: 'codex',
        threadId: 'thread-1',
        sourceMessageId: 'msg-1',
        message: '跟进这条消息',
        fireAt: Date.now() + 60_000,
      },
    });
    const created = JSON.parse(create.payload);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/reminders/${created.id}/cancel`,
    });
    assert.equal(cancel.statusCode, 200);
    const canceled = JSON.parse(cancel.payload);
    assert.equal(canceled.status, 'canceled');

    const list = await app.inject({
      method: 'GET',
      url: '/api/reminders?threadId=thread-1&sourceMessageId=msg-1&status=scheduled',
    });
    assert.equal(JSON.parse(list.payload).reminders.length, 0);
  });
});
