/**
 * Task lifecycle callback routes (batch 2-C) integration tests
 *
 * Covers /api/callbacks/task-claim, task-create, task-update, task-unclaim,
 * task-list, resolve-message-thread — the dual-auth (invocation + agent-key)
 * surface backing cat_cafe_task_* / cat_cafe_reply_in_thread MCP tools.
 *
 * Uses Fastify injection + real stores, mirroring
 * packages/api/test/integration/task-callback.test.js and
 * packages/api/test/callback-routes-agent-key.test.js.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { AgentKeyRegistry } = await import('../../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
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

describe('Task lifecycle callback routes (batch 2-C)', () => {
  let registry;
  let agentKeyRegistry;
  let messageStore;
  let taskStore;
  let threadStore;
  let socketManager;

  beforeEach(() => {
    registry = new InvocationRegistry();
    agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86400000 });
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      agentKeyRegistry,
      messageStore,
      socketManager,
      taskStore,
      threadStore,
    });
    return app;
  }

  // ---- POST /api/callbacks/task-claim (taskId form) ----

  test('task-claim by taskId claims an unowned task', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');
    const task = taskStore.create({ threadId: 'thread-1', title: 'Claim me', why: '', createdBy: 'user' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id, why: 'taking this' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.ownerCatId, 'codex');
    assert.equal(body.task.status, 'doing');
  });

  test('task-claim by taskId rejects a task owned by another cat', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Owned',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().ownerCatId, 'opus');
  });

  test('task-claim requires exactly one of taskId/messageId', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });

  // ---- POST /api/callbacks/task-claim (messageId form) ----

  test('task-claim by messageId converts a plain message into a task and claims it', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'Main');
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', thread.id);
    const msg = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '帮我修一下登录超时的 bug',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { messageId: msg.id },
    });

    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.ownerCatId, 'codex');
    assert.equal(body.task.status, 'doing');
    assert.equal(body.task.sourceMessageId, msg.id);
    assert.ok(body.task.taskThreadId, 'should have created a discussion thread');
  });

  test('task-claim by messageId is idempotent for the same cat and rejects a different cat', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'Main');
    const msg = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '请修复这个 bug',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    const codex = await registry.create('user-1', 'codex', thread.id);
    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': codex.invocationId, 'x-callback-token': codex.callbackToken },
      payload: { messageId: msg.id },
    });
    assert.equal(first.statusCode, 201);
    const firstTaskId = first.json().task.id;

    // Same cat re-claiming the same message is idempotent (200, same task).
    const codexAgain = await registry.create('user-1', 'codex', thread.id);
    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': codexAgain.invocationId, 'x-callback-token': codexAgain.callbackToken },
      payload: { messageId: msg.id },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().task.id, firstTaskId);

    // A different cat trying to claim the same message-derived task is rejected.
    const opus = await registry.create('user-1', 'opus', thread.id);
    const third = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': opus.invocationId, 'x-callback-token': opus.callbackToken },
      payload: { messageId: msg.id },
    });
    assert.equal(third.statusCode, 409);
    assert.equal(third.json().ownerCatId, 'codex');
  });

  // ---- POST /api/callbacks/task-create ----

  test('task-create with subjectKey dedup returns existing_task instead of duplicating', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-create',
      headers,
      payload: { title: 'Track PR #42', subjectKey: 'pr:owner/repo#42' },
    });
    assert.equal(first.statusCode, 201);
    const firstTaskId = first.json().task.id;

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-create',
      headers,
      payload: { title: 'Track PR #42 again', subjectKey: 'pr:owner/repo#42' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().status, 'existing_task');
    assert.equal(second.json().task.id, firstTaskId);
    assert.match(second.json().hint, /task_claim/);
  });

  test('task-create without subjectKey creates a new task with a discussion thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-create',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'Update docs' },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.task.title, 'Update docs');
    assert.equal(body.task.kind, 'work');
    assert.ok(body.task.taskThreadId);
  });

  // ---- POST /api/callbacks/task-update ----

  test('task-update allows the documented status flow (doing -> in_review -> done)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const toReview = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-update',
      headers,
      payload: { taskId: task.id, status: 'in_review', why: 'tests pass' },
    });
    assert.equal(toReview.statusCode, 200, toReview.body);
    assert.equal(toReview.json().task.status, 'in_review');

    const toDone = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-update',
      headers,
      payload: { taskId: task.id, status: 'done' },
    });
    assert.equal(toDone.statusCode, 200, toDone.body);
    assert.equal(toDone.json().task.status, 'done');
  });

  test('task-update rejects jumping straight from doing to done', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-update',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id, status: 'done' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ILLEGAL_STATUS_TRANSITION');
  });

  test('task-update rejects any change once a task is done (terminal state)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'done',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-update',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id, status: 'doing' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ILLEGAL_STATUS_TRANSITION');
  });

  // ---- POST /api/callbacks/task-unclaim ----

  test('task-unclaim releases ownership and returns the task to todo', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-unclaim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id, why: 'blocked on external dep' },
    });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.task.ownerCatId, null);
    assert.equal(body.task.status, 'todo');
  });

  test('task-unclaim rejects a task owned by another cat', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-unclaim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id },
    });

    assert.equal(res.statusCode, 403);
  });

  test('task-unclaim rejects a completed task', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'T',
      why: '',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'done',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-unclaim',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { taskId: task.id },
    });

    assert.equal(res.statusCode, 409);
  });

  // ---- GET /api/callbacks/task-list ----

  test('task-list filters by threadId and status', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    taskStore.create({ threadId: 'thread-1', title: 'A', why: '', createdBy: 'user', status: 'blocked' });
    taskStore.create({ threadId: 'thread-1', title: 'B', why: '', createdBy: 'user', status: 'todo' });
    taskStore.create({ threadId: 'thread-2', title: 'C', why: '', createdBy: 'user', status: 'blocked' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/task-list?threadId=thread-1&status=blocked',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 200);
    const tasks = res.json().tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'A');
  });

  // ---- GET /api/callbacks/resolve-message-thread ----

  test('resolve-message-thread finds the task thread anchored to a claimed message', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'Main');
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', thread.id);
    const msg = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '修复登录 bug',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });
    const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };

    const claim = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers,
      payload: { messageId: msg.id },
    });
    assert.equal(claim.statusCode, 201);
    const taskThreadId = claim.json().task.taskThreadId;

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/resolve-message-thread?messageId=${msg.id}`,
      headers,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().threadId, taskThreadId);
    assert.equal(res.json().taskId, claim.json().task.id);
  });

  test('resolve-message-thread returns NO_ANCHORED_THREAD for a message with no task', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'Main');
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', thread.id);
    const msg = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'just a question, never converted',
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/resolve-message-thread?messageId=${msg.id}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'NO_ANCHORED_THREAD');
  });

  // ---- agent-key auth path (dual-auth headline feature) ----

  describe('agent-key auth', () => {
    let ownedThreadId;

    beforeEach(async () => {
      const thread = await threadStore.create('user-1', 'Agent Key Task Test');
      ownedThreadId = thread.id;
    });

    test('task-create with agent-key + owned threadId succeeds', async () => {
      const app = await createApp();
      const { secret } = await agentKeyRegistry.issue('bengal', 'user-1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-agent-key-secret': secret },
        payload: { title: 'Agent-key created task', threadId: ownedThreadId },
      });

      assert.equal(res.statusCode, 201, res.body);
      const body = res.json();
      assert.equal(body.task.threadId, ownedThreadId);
      assert.equal(body.task.createdBy, 'bengal');
    });

    test('task-create with agent-key requires threadId', async () => {
      const app = await createApp();
      const { secret } = await agentKeyRegistry.issue('bengal', 'user-1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-agent-key-secret': secret },
        payload: { title: 'No thread given' },
      });

      assert.equal(res.statusCode, 400);
    });

    test('task-create with agent-key + unowned threadId returns 403', async () => {
      const app = await createApp();
      const { secret } = await agentKeyRegistry.issue('bengal', 'user-1');
      const otherThread = await threadStore.create('someone-else', 'Other Thread');

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-agent-key-secret': secret },
        payload: { title: 'Should fail', threadId: otherThread.id },
      });

      assert.equal(res.statusCode, 403);
    });

    test('task-claim + task-list + task-unclaim round-trip with agent-key', async () => {
      const app = await createApp();
      const { secret } = await agentKeyRegistry.issue('bengal', 'user-1');
      const headers = { 'x-agent-key-secret': secret };
      const task = taskStore.create({ threadId: ownedThreadId, title: 'Agent-key claim', why: '', createdBy: 'user' });

      const claim = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers,
        payload: { taskId: task.id },
      });
      assert.equal(claim.statusCode, 200, claim.body);
      assert.equal(claim.json().task.ownerCatId, 'bengal');

      const list = await app.inject({
        method: 'GET',
        url: `/api/callbacks/task-list?threadId=${ownedThreadId}`,
        headers,
      });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(
        list.json().tasks.map((t) => t.id),
        [task.id],
      );

      const unclaim = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-unclaim',
        headers,
        payload: { taskId: task.id },
      });
      assert.equal(unclaim.statusCode, 200, unclaim.body);
      assert.equal(unclaim.json().task.ownerCatId, null);
    });
  });
});
