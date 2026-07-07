/**
 * Task Callback Integration Tests
 * 验证 MCP update-task 回传端点与 TaskStore 的集成
 *
 * 使用 Fastify injection + 真实 InvocationRegistry + TaskStore
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

function createMockSocketManager() {
  const events = [];
  return {
    broadcastAgentMessage(msg) {
      events.push({ type: 'agent', msg });
    },
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

describe('Task Callback Integration', () => {
  let registry;
  let messageStore;
  let taskStore;
  let threadStore;
  let socketManager;

  beforeEach(() => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      taskStore,
      threadStore,
    });
    return app;
  }

  test('MCP update-task succeeds for owned task', async () => {
    const app = await createApp();

    // Create invocation for opus
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    // Create a task owned by opus
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Test task',
      why: 'Testing',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        status: 'doing',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.status, 'doing');

    // Verify broadcast
    const events = socketManager.getEvents();
    const taskEvent = events.find((e) => e.event === 'task_updated');
    assert.ok(taskEvent, 'task_updated event should be broadcast');
    assert.equal(taskEvent.room, 'thread:thread-1');
  });

  test('MCP update-task rejects invalid credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId: 'bad-id',
        callbackToken: 'bad-token',
        taskId: 'some-task',
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('MCP update-task rejects task owned by another cat', async () => {
    const app = await createApp();

    // Invocation for codex
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');

    // Task owned by opus
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Opus task',
      why: 'Testing',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 403);
  });

  test('MCP update-task allows unowned task', async () => {
    const app = await createApp();

    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    // Task with no owner
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Unowned task',
      why: 'Anyone can update',
      createdBy: 'user',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        status: 'doing',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().task.status, 'doing');
  });

  test('MCP claim-task claims unowned task for invocation cat', async () => {
    const app = await createApp();

    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Claim me',
      why: 'Needs owner',
      createdBy: 'user',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/claim-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        why: 'Taking this now',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.ownerCatId, 'codex');
    assert.equal(body.task.status, 'doing');
    assert.equal(body.task.why, 'Taking this now');

    const taskEvent = socketManager.getEvents().find((e) => e.event === 'task_updated');
    assert.ok(taskEvent, 'task_updated event should be broadcast');
  });

  test('MCP claim-task rejects task owned by another cat', async () => {
    const app = await createApp();

    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Owned task',
      why: 'Already claimed',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/claim-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().ownerCatId, 'opus');
  });

  test('MCP update-task rejects cross-thread update', async () => {
    const app = await createApp();

    // Invocation in thread-A
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-A');

    // Task in thread-B
    const task = taskStore.create({
      threadId: 'thread-B',
      title: 'Task in another thread',
      why: 'Cross-thread test',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /different thread/);
  });

  // --- F160: cat_cafe_create_task ---

  test('MCP create-task succeeds with valid input', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      payload: {
        invocationId,
        callbackToken,
        title: 'Fix login bug',
        why: 'Users are getting 500 errors on login',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.title, 'Fix login bug');
    assert.equal(body.task.kind, 'work');
    assert.equal(body.task.threadId, 'thread-1');
    assert.equal(body.task.createdBy, 'opus');
    assert.equal(body.task.status, 'todo');
    assert.ok(body.task.taskThreadId, 'MCP-created work task should auto-create a discussion thread');
    assert.ok(body.task.sourceMessageId, 'MCP-created discussion thread should backfill sourceMessageId');

    const taskThreadMessages = await messageStore.getByThread(body.task.taskThreadId);
    assert.equal(taskThreadMessages.length, 1);
    assert.equal(taskThreadMessages[0].id, body.task.sourceMessageId);
    assert.match(taskThreadMessages[0].content, /📌 Task: Fix login bug/);

    const events = socketManager.getEvents();
    const createEvent = events.find((e) => e.event === 'task_created');
    assert.ok(createEvent, 'task_created event should be broadcast');
    assert.equal(createEvent.room, 'thread:thread-1');
    assert.equal(createEvent.data.taskThreadId, body.task.taskThreadId);
  });

  test('MCP create-task rejects invalid credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      payload: {
        invocationId: 'bad-id',
        callbackToken: 'bad-token',
        title: 'Some task',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('MCP create-task enforces kind=work even if kind field sent (AC-A4 regression guard)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      payload: {
        invocationId,
        callbackToken,
        title: 'PR #42',
        kind: 'pr_tracking',
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().task.kind, 'work', 'kind must be forced to work regardless of input');
  });

  test('MCP create-task with ownerCatId', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      payload: {
        invocationId,
        callbackToken,
        title: 'Review docs',
        why: 'Needs fresh eyes',
        ownerCatId: 'codex',
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().task.ownerCatId, 'codex');
  });

  test('MCP create-task rejects empty title', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      payload: {
        invocationId,
        callbackToken,
        title: '',
      },
    });

    assert.equal(response.statusCode, 400);
  });
});
