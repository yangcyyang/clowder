import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { messagesRoutes } = await import('../dist/routes/messages.js');

function socketManager(events) {
  return {
    broadcastToRoom(room, event, payload) {
      events.push({ room, event, payload });
    },
    broadcastAgentMessage(message, threadId) {
      events.push({ event: 'agent', threadId, message });
    },
    emitToUser() {},
  };
}

function invocationTracker() {
  return {
    has: () => false,
    isDeleting: () => false,
    tryStartThreadAll: () => new AbortController(),
    startAll: () => new AbortController(),
    completeAll() {},
  };
}

describe('F194 POST /api/messages work admission', () => {
  afterEach(() => {
    delete process.env.CLOWDER_AUTO_TASK_THREAD_ROUTING;
    delete process.env.CLOWDER_AUTO_TASK_THREAD_THREADS;
  });

  test('a direct single-owner instruction creates and routes through its task thread before execution', async () => {
    const events = [];
    const routeCalls = [];
    const recordCreates = [];
    let invocationCreated = false;
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const parent = await threadStore.create('alice', '大厅');
    process.env.CLOWDER_AUTO_TASK_THREAD_THREADS = parent.id;
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      taskStore,
      threadStore,
      socketManager: socketManager(events),
      invocationTracker: invocationTracker(),
      invocationRecordStore: {
        async create(input) {
          recordCreates.push(input);
          if (invocationCreated) return { outcome: 'duplicate', invocationId: 'inv-f194' };
          invocationCreated = true;
          return { outcome: 'created', invocationId: 'inv-f194' };
        },
        async update() {},
      },
      router: {
        async resolveTargetsAndIntent() {
          return {
            targetCats: ['opus'],
            hasMentions: true,
            intent: { intent: 'execute', explicit: true, promptTags: [] },
          };
        },
        async *routeExecution(...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: parent.id,
        content: '@opus 修复登录超时',
        idempotencyKey: '19419419-4194-4194-8194-194194194194',
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const tasks = await taskStore.listByThread(parent.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].ownerCatId, 'opus');
    assert.equal(tasks[0].status, 'doing');
    assert.ok(tasks[0].taskThreadId);
    assert.equal(recordCreates[0].threadId, tasks[0].taskThreadId);
    assert.equal(routeCalls[0][2], tasks[0].taskThreadId);
    assert.notEqual(routeCalls[0][3], response.json().userMessageId, 'execution uses the task-thread source copy');
    assert.ok(
      events.filter((event) => event.event === 'agent').every((event) => event.threadId === tasks[0].taskThreadId),
      'agent output must only broadcast to the task thread',
    );
    const rootMessages = await messageStore.getByThread(parent.id, 100);
    assert.equal(rootMessages.filter((message) => message.catId).length, 0);
    assert.deepEqual(rootMessages[0].extra.slockThread, { branchThreadId: tasks[0].taskThreadId, replyCount: 0 });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: parent.id,
        content: '@opus 修复登录超时',
        idempotencyKey: '19419419-4194-4194-8194-194194194194',
      },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().userMessageId, response.json().userMessageId);
    assert.equal((await taskStore.listByThread(parent.id)).length, 1);
    assert.equal(routeCalls.length, 1);
    await app.close();
  });

  test('discussion remains in the current thread and creates zero tasks', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const parent = await threadStore.create('alice', '大厅');
    process.env.CLOWDER_AUTO_TASK_THREAD_THREADS = parent.id;
    const routeCalls = [];
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      taskStore,
      threadStore,
      socketManager: socketManager([]),
      invocationTracker: invocationTracker(),
      invocationRecordStore: {
        async create() {
          return { outcome: 'created', invocationId: 'inv-discussion' };
        },
        async update() {},
      },
      router: {
        async resolveTargetsAndIntent() {
          return {
            targetCats: ['opus'],
            hasMentions: true,
            intent: { intent: 'execute', explicit: true, promptTags: [] },
          };
        },
        async *routeExecution(...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: parent.id, content: '@opus 我们先讨论登录超时怎么设计' },
    });
    assert.equal(response.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await taskStore.listByThread(parent.id)).length, 0);
    assert.equal(routeCalls[0][2], parent.id);
    await app.close();
  });

  test('an unrevealed whisper never copies its sentinel into task-derived surfaces', async () => {
    const events = [];
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const parent = await threadStore.create('alice', '大厅');
    const sentinel = 'WHISPER-SECRET-194';
    process.env.CLOWDER_AUTO_TASK_THREAD_THREADS = parent.id;
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      taskStore,
      threadStore,
      socketManager: socketManager(events),
      invocationTracker: invocationTracker(),
      invocationRecordStore: {
        async create() {
          return { outcome: 'created', invocationId: 'inv-whisper-f194' };
        },
        async update() {},
      },
      router: {
        async resolveTargetsAndIntent() {
          return {
            targetCats: ['opus'],
            hasMentions: true,
            intent: { intent: 'execute', explicit: true, promptTags: [] },
          };
        },
        async *routeExecution() {
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: parent.id,
        content: `@opus 修复 ${sentinel}`,
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const [task] = await taskStore.listByThread(parent.id);
    assert.ok(task);
    assert.equal(task.title, '私密工作指令');
    assert.equal(task.why.includes(sentinel), false);
    const taskThread = await threadStore.get(task.taskThreadId);
    assert.ok(taskThread);
    const derivedSurfaces = { task, taskThread, events };
    assert.equal(JSON.stringify(derivedSurfaces).includes(sentinel), false);

    const allMessages = [
      ...(await messageStore.getByThread(parent.id, 100)),
      ...(await messageStore.getByThread(task.taskThreadId, 100)),
    ];
    const sentinelMessages = allMessages.filter((message) => message.content.includes(sentinel));
    assert.equal(sentinelMessages.length, 2);
    for (const message of sentinelMessages) {
      assert.equal(message.visibility, 'whisper');
      assert.deepEqual(message.whisperTo, ['opus']);
    }
    await app.close();
  });

});
