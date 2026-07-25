/**
 * F194 §3 step 2/3 (batch 2-A): thread-first routing + "As Task" forced admission.
 *
 * docs/research/clowder-raft-thread-task-design.md §3 step 2:
 *   - Thread.routingPolicy.mode='thread-first' opts a channel in.
 *   - Inside an opted-in thread, EVERY @mention message (including plain
 *     questions classifyWorkAdmission would decline) routes its reply to the
 *     message's own anchored branch thread — routing no longer depends on
 *     the classifier's verdict ("judge retirement", item 2).
 *   - Default (routingPolicy unset) = current main-flow behavior, unchanged.
 *
 * §3 step 3: asTask=true forces admitWorkMessage regardless of thread-first
 * or the classifier, independent of routing.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
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

function invocationRecordStore() {
  const created = new Set();
  return {
    async create(input) {
      if (created.has(input.idempotencyKey)) {
        return { outcome: 'duplicate', invocationId: `dup-${input.idempotencyKey}` };
      }
      created.add(input.idempotencyKey);
      return { outcome: 'created', invocationId: `inv-${created.size}` };
    },
    async update() {},
  };
}

function router(routeCalls) {
  return {
    async resolveTargetsAndIntent(_content, _threadId, _opts) {
      const mentionMatch = _content.match(/@([a-z]+)/g) ?? [];
      const targetCats = mentionMatch.length > 0 ? [...new Set(mentionMatch.map((m) => m.slice(1)))] : ['opus'];
      return {
        targetCats,
        hasMentions: mentionMatch.length > 0,
        intent: { intent: 'execute', explicit: true, promptTags: [] },
      };
    },
    async *routeExecution(...args) {
      routeCalls.push(args);
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
}

async function buildApp({ taskStore, threadStore, messageStore, events, routeCalls }) {
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    messageStore,
    taskStore,
    threadStore,
    socketManager: socketManager(events),
    invocationTracker: invocationTracker(),
    invocationRecordStore: invocationRecordStore(),
    router: router(routeCalls),
  });
  return app;
}

describe('F194 §3 step 2: thread-first routing', () => {
  afterEach(() => {
    delete process.env.CLOWDER_AUTO_TASK_THREAD_ROUTING;
    delete process.env.CLOWDER_AUTO_TASK_THREAD_THREADS;
  });

  test('routingPolicy defaults to unset — thread-first is off', async () => {
    const { isThreadFirstRoutingEnabled } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );
    assert.equal(isThreadFirstRoutingEnabled(null), false);
    assert.equal(isThreadFirstRoutingEnabled(undefined), false);
    assert.equal(isThreadFirstRoutingEnabled({ routingPolicy: undefined }), false);
    assert.equal(isThreadFirstRoutingEnabled({ routingPolicy: { v: 1 } }), false);
    assert.equal(isThreadFirstRoutingEnabled({ routingPolicy: { v: 1, mode: 'thread-first' } }), true);
  });

  test('PATCH /api/threads/:id turns thread-first on/off per thread', async () => {
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', '频道 A');
    const app = Fastify();
    await app.register(threadsRoutes, { threadStore });

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { routingPolicy: { v: 1, mode: 'thread-first' } },
    });
    assert.equal(on.statusCode, 200);
    assert.equal(on.json().routingPolicy.mode, 'thread-first');

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { routingPolicy: null },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().routingPolicy, undefined);
    await app.close();
  });

  test('OFF (default): a plain @mention question stays in the main thread — current behavior unchanged', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 B');
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 这个功能为什么会报错？' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(routeCalls[0][2], channel.id, 'reply stays in the main thread when thread-first is off');
    assert.equal((await taskStore.listByThread(channel.id)).length, 0, 'no task auto-created outside the canary');
    assert.equal(
      events.filter((e) => e.event === 'thread_branched').length,
      0,
      'no branch thread created when thread-first is off',
    );
    await app.close();
  });

  test('ON: a plain question — which classifyWorkAdmission would decline — still routes the reply to an anchored branch; main thread keeps only the source message', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 C');
    await threadStore.updateRoutingPolicy(channel.id, { v: 1, mode: 'thread-first' });
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 这个功能为什么会报错？' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal((await taskStore.listByThread(channel.id)).length, 0, 'a plain question still creates no task card');

    const branchedEvent = events.find((e) => e.event === 'thread_branched');
    assert.ok(branchedEvent, 'thread_branched must fire even for a message the classifier would reject');
    const anchorThreadId = branchedEvent.payload.newThreadId;
    assert.notEqual(anchorThreadId, channel.id);

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][2], anchorThreadId, 'execution is routed to the anchor branch, not the main thread');

    const mainMessages = await messageStore.getByThread(channel.id, 100);
    assert.equal(mainMessages.length, 1, 'main thread keeps only the source message');
    assert.equal(mainMessages[0].extra.slockThread.branchThreadId, anchorThreadId);

    const branchMessages = await messageStore.getByThread(anchorThreadId, 100);
    assert.equal(branchMessages.length, 1);
    assert.equal(branchMessages[0].content, '@opus 这个功能为什么会报错？');

    const anchorThread = await threadStore.get(anchorThreadId);
    assert.equal(anchorThread.relation.kind, 'message_thread');
    assert.equal(anchorThread.relation.parentThreadId, channel.id);
    await app.close();
  });

  test('ON: an action-shaped @mention also gets a decorative task card, attached to the SAME anchor thread (no duplicate branch)', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 D');
    await threadStore.updateRoutingPolicy(channel.id, { v: 1, mode: 'thread-first' });
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 修复登录超时' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tasks = await taskStore.listByThread(channel.id);
    assert.equal(tasks.length, 1, 'the classifier still fires as a decorative task-card judgment');
    assert.equal(tasks[0].ownerCatId, 'opus');

    const branchedEvents = events.filter((e) => e.event === 'thread_branched');
    assert.equal(branchedEvents.length, 1, 'only one branch is ever created for this message');
    assert.equal(tasks[0].taskThreadId, branchedEvents[0].payload.newThreadId, 'the task reuses the routing anchor');

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][2], tasks[0].taskThreadId, 'execution still targets the (now task-linked) anchor thread');

    // Response must not short-circuit with the legacy "task_created, no invocation" 202 —
    // routing already happened above and is unaffected by ownership.
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  test('ON: a message without any @mention is unaffected (thread-first only applies to @mention messages)', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 E');
    await threadStore.updateRoutingPolicy(channel.id, { v: 1, mode: 'thread-first' });
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      taskStore,
      threadStore,
      socketManager: socketManager(events),
      invocationTracker: invocationTracker(),
      invocationRecordStore: invocationRecordStore(),
      router: {
        async resolveTargetsAndIntent() {
          return { targetCats: ['opus'], hasMentions: false, intent: { intent: 'chat', explicit: false, promptTags: [] } };
        },
        async *routeExecution(...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '随便聊聊，没有艾特谁' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(
      events.filter((e) => e.event === 'thread_branched').length,
      0,
      'no @mention → no anchor branch, even with thread-first on',
    );
    await app.close();
  });
});

describe('F194 §3 step 3: "As Task" forced admission', () => {
  afterEach(() => {
    delete process.env.CLOWDER_AUTO_TASK_THREAD_ROUTING;
    delete process.env.CLOWDER_AUTO_TASK_THREAD_THREADS;
  });

  test('asTask=true forces a task from a plain question outside any canary/thread-first opt-in', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 F');
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 这个功能为什么会报错？', asTask: true },
    });

    const tasks = await taskStore.listByThread(channel.id);
    assert.equal(tasks.length, 1, 'asTask bypasses classifyWorkAdmission entirely');
    assert.equal(tasks[0].ownerCatId, 'opus');
    // Owned → invocation proceeds (no 202 short-circuit) exactly like the classifier's owned path.
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][2], tasks[0].taskThreadId);
  });

  test('asTask=true inside a thread-first channel attaches the task to the routing anchor (no double branch, no short-circuit)', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 G');
    await threadStore.updateRoutingPolicy(channel.id, { v: 1, mode: 'thread-first' });
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 随便聊聊今天天气', asTask: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tasks = await taskStore.listByThread(channel.id);
    assert.equal(tasks.length, 1);
    const branchedEvents = events.filter((e) => e.event === 'thread_branched');
    assert.equal(branchedEvents.length, 1, 'one anchor branch, reused by the forced task');
    assert.equal(tasks[0].taskThreadId, branchedEvents[0].payload.newThreadId);
    assert.equal(routeCalls[0][2], tasks[0].taskThreadId);
  });

  test('asTask=false/absent leaves non-thread-first, non-canary behavior untouched (regression)', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 H');
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus 修复登录超时' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await taskStore.listByThread(channel.id)).length, 0, 'no canary, no asTask → no task, unchanged');
    assert.equal(routeCalls[0][2], channel.id);
  });
});

describe('thread-first 默认开的轻量豁免（CLOWDER_THREAD_FIRST_MIN_CHARS）', () => {
  let prevDefault;
  let prevMinChars;

  beforeEach(() => {
    prevDefault = process.env.CLOWDER_THREAD_FIRST_DEFAULT;
    prevMinChars = process.env.CLOWDER_THREAD_FIRST_MIN_CHARS;
    process.env.CLOWDER_THREAD_FIRST_DEFAULT = '1';
    delete process.env.CLOWDER_THREAD_FIRST_MIN_CHARS;
  });

  afterEach(() => {
    if (prevDefault === undefined) delete process.env.CLOWDER_THREAD_FIRST_DEFAULT;
    else process.env.CLOWDER_THREAD_FIRST_DEFAULT = prevDefault;
    if (prevMinChars === undefined) delete process.env.CLOWDER_THREAD_FIRST_MIN_CHARS;
    else process.env.CLOWDER_THREAD_FIRST_MIN_CHARS = prevMinChars;
  });

  async function postAndCollect(content) {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 L');
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
    return { events, routeCalls, channel };
  }

  test('短寒暄（去 @ 后 ≤24 字符）走主频道内联，不建分支', async () => {
    const { events, routeCalls, channel } = await postAndCollect('@opus hi');
    assert.equal(events.find((e) => e.event === 'thread_branched'), undefined, '短消息不应触发分支');
    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][2], channel.id, '执行留在主频道，运行状态条可见');
  });

  test('长消息仍然进分支（豁免只放行轻量消息）', async () => {
    const { events, routeCalls, channel } = await postAndCollect(
      '@opus 帮我梳理一下这个模块的错误处理链路，从入口到落库每一步都列出来，并指出可能吞错误的位置。',
    );
    const branched = events.find((e) => e.event === 'thread_branched');
    assert.ok(branched, '长消息必须仍走 thread-first');
    assert.equal(routeCalls[0][2], branched.payload.newThreadId);
    assert.notEqual(routeCalls[0][2], channel.id);
  });

  test('阈值置 0 = 关闭豁免，短消息也进分支', async () => {
    process.env.CLOWDER_THREAD_FIRST_MIN_CHARS = '0';
    const { events } = await postAndCollect('@opus hi');
    assert.ok(
      events.find((e) => e.event === 'thread_branched'),
      '阈值 0 时豁免关闭，一切照旧进 thread',
    );
  });

  test('thread 显式 routingPolicy 开启时豁免不适用，短消息照样进分支', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const routeCalls = [];
    const channel = await threadStore.create('alice', '频道 E');
    await threadStore.updateRoutingPolicy(channel.id, { v: 1, mode: 'thread-first' });
    const app = await buildApp({ taskStore, threadStore, messageStore, events, routeCalls });
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
      payload: { threadId: channel.id, content: '@opus hi' },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      events.find((e) => e.event === 'thread_branched'),
      '显式配置的 thread-first 不受轻量豁免影响',
    );
    await app.close();
  });
});
