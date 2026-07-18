/**
 * Task Callback Integration Tests
 * 验证 MCP update-task 回传端点与 TaskStore 的集成
 *
 * 使用 Fastify injection + 真实 InvocationRegistry + TaskStore
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
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
    emitToUser(userId, event, data) {
      events.push({ userId, event, data });
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

  test('MCP task-thread invocation reuses its admitted auto-task instead of creating a duplicate', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'c6b parent');
    const taskThread = await threadStore.create('user-1', 'auto task branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: '私密工作指令',
      why: 'work intake',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);
    const before = taskStore.listByKind('work');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: '再次执行原始自动任务', why: '模型误调用 create_task' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'existing_task');
    assert.equal(response.json().task.id, root.id);
    assert.equal(taskStore.listByKind('work').length, before.length);
    assert.equal(socketManager.getEvents().filter((event) => event.event === 'task_created').length, 0);
  });

  test('MCP task-thread reuse still rejects a disabled requested owner', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'disabled owner parent');
    const taskThread = await threadStore.create('user-1', 'auto task branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'auto task',
      why: 'work intake',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);
    const before = taskStore.listByKind('work').length;

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'must be rejected before reuse', ownerCatId: 'antigravity' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().kind, 'cat_disabled');
    assert.equal(taskStore.listByKind('work').length, before);
  });

  test('MCP manual task-thread invocation preserves legacy childless create behavior', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'manual parent');
    const taskThread = await threadStore.create('user-1', 'manual task branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'manual root',
      why: 'manual',
      createdBy: 'user',
      userId: 'user-1',
      subjectKey: null,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'legacy direct task' },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, 'ok');
    assert.equal(response.json().task.threadId, taskThread.id);
    assert.equal(response.json().task.parentTaskId, undefined);
  });

  test('MCP task-thread invocation may create an explicit child task', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'parent');
    const taskThread = await threadStore.create('user-1', 'root branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'root task',
      why: 'root',
      createdBy: 'user',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'explicit child', parentTaskId: root.id },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().task.parentTaskId, root.id);
    assert.equal(response.json().task.threadId, taskThread.id);
  });

  test('MCP task-thread invocation lists and updates the owning parent task', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'parent');
    const taskThread = await threadStore.create('user-1', 'root branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'root task',
      why: 'root',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const listed = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-tasks?threadId=${taskThread.id}`,
      headers,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().tasks.map((task) => task.id),
      [root.id],
    );

    const updated = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers,
      payload: { taskId: root.id, status: 'in_review' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().task.status, 'in_review');
  });

  test('MCP task-thread invocation may claim its unowned parent task', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'parent');
    const taskThread = await threadStore.create('user-1', 'root branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'unowned root',
      why: 'root',
      createdBy: 'user',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/claim-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: root.id },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().task.ownerCatId, 'opus');
    assert.equal(response.json().task.status, 'doing');
  });

  test('MCP create-task rejects a parentTaskId not bound to the current task thread', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'parent');
    const taskThread = await threadStore.create('user-1', 'root branch');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'root',
      why: 'root',
      createdBy: 'user',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const other = taskStore.create({
      threadId: parent.id,
      title: 'other',
      why: 'other',
      createdBy: 'user',
      userId: 'user-1',
    });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);
    const before = taskStore.listByKind('work').length;

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'invalid child', parentTaskId: other.id },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(taskStore.listByKind('work').length, before);
  });

  test('MCP task-thread mutations fail closed when multiple tasks claim the same task thread', async () => {
    const app = await createApp();
    const parent = await threadStore.create('user-1', 'parent');
    const taskThread = await threadStore.create('user-1', 'ambiguous branch');
    const taskIds = [];
    for (const title of ['root-a', 'root-b']) {
      const task = taskStore.create({
        threadId: parent.id,
        title,
        why: title,
        createdBy: 'user',
        userId: 'user-1',
        subjectKey: `work-intake:${parent.id}:${title}`,
      });
      taskStore.linkTaskThreadIfAbsent(task.id, { taskThreadId: taskThread.id });
      taskIds.push(task.id);
    }
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', taskThread.id);
    const before = taskStore.listByKind('work').length;

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'must not be created' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(taskStore.listByKind('work').length, before);
    assert.equal(response.json().taskIds.length, 2);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: taskIds[0], status: 'doing' },
    });
    assert.equal(updated.statusCode, 403);
  });

  test('MCP task-thread alias does not expose a foreign parent task', async () => {
    const app = await createApp();
    const actorThread = await threadStore.create('user-1', 'actor branch');
    const foreignParent = await threadStore.create('user-2', 'foreign parent');
    const foreignTask = taskStore.create({
      threadId: foreignParent.id,
      title: 'foreign root',
      why: 'foreign',
      createdBy: 'user',
      userId: 'user-2',
    });
    taskStore.linkTaskThreadIfAbsent(foreignTask.id, { taskThreadId: actorThread.id });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', actorThread.id);
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const listed = await app.inject({
      method: 'GET',
      url: `/api/callbacks/list-tasks?threadId=${actorThread.id}`,
      headers,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().tasks, []);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers,
      payload: { taskId: foreignTask.id, status: 'doing' },
    });
    assert.equal(updated.statusCode, 403);
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
