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
    delete process.env.CLOWDER_THREAD_ADDRESS_ROUTING;
    delete process.env.CLOWDER_THREAD_ADDRESS_THREADS;
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

  test('a valid address keeps the human root in place and binds execution plus audit copy to the branch', async () => {
    const events = [];
    const routeCalls = [];
    const recordCreates = [];
    let addressInvocationCreated = false;
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const current = await threadStore.create('alice', '当前频道');
    const addressedSource = await threadStore.create('alice', '研发频道');
    const branch = await threadStore.create('alice', '登录修复 (分支)');
    const addressedRoot = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '登录修复任务',
      mentions: [],
      timestamp: Date.now(),
      threadId: addressedSource.id,
    });
    await messageStore.updateExtra(addressedRoot.id, {
      slockThread: { branchThreadId: branch.id, replyCount: 1 },
    });
    process.env.CLOWDER_THREAD_ADDRESS_THREADS = current.id;

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
          if (addressInvocationCreated) return { outcome: 'duplicate', invocationId: 'inv-address' };
          addressInvocationCreated = true;
          return { outcome: 'created', invocationId: 'inv-address' };
        },
        async update() {},
      },
      router: {
        async resolveTargetsAndIntent(_content, threadId) {
          assert.equal(threadId, branch.id);
          return {
            targetCats: ['opus'],
            hasMentions: true,
            intent: { intent: 'execute', explicit: true, promptTags: [] },
          };
        },
        async *routeExecution(...args) {
          routeCalls.push(args);
          yield { type: 'text', catId: 'opus', content: '跨线程处理中', timestamp: Date.now() };
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
        threadId: current.id,
        content: `@opus 继续修复 #任意标签:${addressedRoot.id}`,
        idempotencyKey: '19419419-4194-4194-8194-194194194195',
      },
    });
    assert.equal(response.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(recordCreates[0].threadId, branch.id);
    assert.equal(routeCalls[0][2], branch.id);
    assert.notEqual(routeCalls[0][3], response.json().userMessageId);
    const currentMessages = await messageStore.getByThread(current.id, 100);
    assert.equal(currentMessages.length, 1);
    assert.equal(currentMessages[0].id, response.json().userMessageId);
    const branchMessages = await messageStore.getByThread(branch.id, 100);
    assert.equal(branchMessages.length, 1);
    assert.deepEqual(branchMessages[0].extra.crossPost, { sourceThreadId: current.id });
    const agentEvents = events.filter((event) => event.event === 'agent');
    assert.ok(agentEvents.length > 0, 'cross-thread execution must emit an observable agent event');
    assert.ok(agentEvents.every((event) => event.threadId === branch.id));
    assert.ok(
      agentEvents.every((event) => event.message.extra?.crossPost?.sourceThreadId === current.id),
      'every explicit-route egress event keeps source-thread audit lineage',
    );
    assert.equal(
      (await taskStore.listByThread(current.id)).length,
      0,
      'an explicit address must not create another task',
    );

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: current.id,
        content: `@opus 继续修复 #任意标签:${addressedRoot.id}`,
        idempotencyKey: '19419419-4194-4194-8194-194194194195',
      },
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().userMessageId, response.json().userMessageId);
    assert.equal(routeCalls.length, 1);

    const resolveLink = await app.inject({
      method: 'GET',
      url: `/api/thread-address/resolve?rootMessageId=${addressedRoot.id}&sourceThreadId=${current.id}`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(resolveLink.statusCode, 200);
    assert.equal(resolveLink.json().threadId, branch.id);
    const deniedLink = await app.inject({
      method: 'GET',
      url: `/api/thread-address/resolve?rootMessageId=${addressedRoot.id}&sourceThreadId=${current.id}`,
      headers: { 'x-cat-cafe-user': 'bob' },
    });
    assert.equal(deniedLink.statusCode, 404);
    assert.equal(deniedLink.json().error, '线程地址不可用');

    const sourceOnlyReply = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '只属于当前频道的回复目标',
      mentions: [],
      timestamp: Date.now(),
      threadId: current.id,
    });
    const wrongThreadReply = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: current.id,
        replyTo: sourceOnlyReply.id,
        content: `@opus 继续修复 #任意标签:${addressedRoot.id}`,
        idempotencyKey: '19419419-4194-4194-8194-194194194196',
      },
    });
    assert.equal(wrongThreadReply.statusCode, 400);
    assert.equal(wrongThreadReply.json().code, 'THREAD_ADDRESS_INVALID');
    assert.equal(recordCreates.length, 2, 'invalid replyTo must not create another invocation');

    delete process.env.CLOWDER_THREAD_ADDRESS_THREADS;
    const disabledLink = await app.inject({
      method: 'GET',
      url: `/api/thread-address/resolve?rootMessageId=${addressedRoot.id}&sourceThreadId=${current.id}`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    assert.equal(disabledLink.statusCode, 404, 'viewer resolver must stay off outside the rollout canary');
    await app.close();
  });

  test('an explicit address keeps cross-post audit on a thrown terminal error', async () => {
    const events = [];
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const current = await threadStore.create('alice', '当前频道');
    const addressedSource = await threadStore.create('alice', '研发频道');
    const branch = await threadStore.create('alice', '异常分支');
    const addressedRoot = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '异常路径任务',
      mentions: [],
      timestamp: Date.now(),
      threadId: addressedSource.id,
      extra: { slockThread: { branchThreadId: branch.id, replyCount: 1 } },
    });
    process.env.CLOWDER_THREAD_ADDRESS_THREADS = current.id;

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      threadStore,
      socketManager: socketManager(events),
      invocationTracker: invocationTracker(),
      invocationRecordStore: {
        async create() {
          return { outcome: 'created', invocationId: 'inv-address-throw' };
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
          yield* [];
          throw new Error('explicit route failed');
        },
        async ackCollectedCursors() {},
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: current.id,
        content: `@opus 继续处理 #研发频道:${addressedRoot.id}`,
        idempotencyKey: '19419419-4194-4194-8194-194194194197',
      },
    });
    assert.equal(response.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const terminalErrors = events.filter(
      (event) => event.event === 'agent' && event.message.type === 'error' && event.message.isFinal,
    );
    assert.equal(terminalErrors.length, 1);
    assert.equal(terminalErrors[0].threadId, branch.id);
    assert.deepEqual(terminalErrors[0].message.extra?.crossPost, {
      sourceThreadId: current.id,
      sourceInvocationId: 'inv-address-throw',
    });
    assert.equal((await messageStore.getByThread(current.id, 100)).length, 1);
    assert.equal((await messageStore.getByThread(branch.id, 100)).length, 1);
    await app.close();
  });

  test('invalid and multiple addresses fail closed before persistence or invocation', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const current = await threadStore.create('alice', '当前频道');
    const foreignSource = await threadStore.create('bob', '别人的频道');
    const foreignBranch = await threadStore.create('bob', '别人的分支');
    const foreignRoot = await messageStore.append({
      userId: 'bob',
      catId: null,
      content: '别人的任务',
      mentions: [],
      timestamp: Date.now(),
      threadId: foreignSource.id,
      extra: { slockThread: { branchThreadId: foreignBranch.id, replyCount: 1 } },
    });
    process.env.CLOWDER_THREAD_ADDRESS_THREADS = current.id;
    let routeCount = 0;
    let invocationCount = 0;
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      threadStore,
      socketManager: socketManager([]),
      invocationRecordStore: {
        async create() {
          invocationCount += 1;
          return { outcome: 'created', invocationId: 'must-not-run' };
        },
        async update() {},
      },
      router: {
        async resolveTargetsAndIntent() {
          routeCount += 1;
          return {
            targetCats: ['opus'],
            hasMentions: true,
            intent: { intent: 'execute', explicit: true, promptTags: [] },
          };
        },
      },
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: current.id, content: '#大厅:not-a-full-id 请处理' },
    });
    const multiple = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: {
        threadId: current.id,
        content: '#大厅:0001784400000000-000001-ab12cd34 #研发:0001784400000000-000002-ab12cd35 请处理',
      },
    });
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: current.id, content: `#别人的频道:${foreignRoot.id} 请处理` },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(multiple.statusCode, 400);
    assert.equal(unauthorized.statusCode, 400);
    assert.equal(malformed.json().code, 'THREAD_ADDRESS_INVALID');
    assert.equal(malformed.json().error, multiple.json().error);
    assert.equal(malformed.json().error, unauthorized.json().error);
    assert.equal(routeCount, 0);
    assert.equal(invocationCount, 0);
    assert.equal((await messageStore.getByThread(current.id, 100)).length, 0);
    await app.close();
  });
});
