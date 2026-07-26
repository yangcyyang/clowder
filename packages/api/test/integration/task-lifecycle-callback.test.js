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
      payload: { messageId: msg.id, title: '修复登录问题' },
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
      payload: { messageId: msg.id, title: '修复登录问题' },
    });
    assert.equal(first.statusCode, 201);
    const firstTaskId = first.json().task.id;

    // Same cat re-claiming the same message is idempotent (200, same task).
    const codexAgain = await registry.create('user-1', 'codex', thread.id);
    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': codexAgain.invocationId, 'x-callback-token': codexAgain.callbackToken },
      payload: { messageId: msg.id, title: '修复登录问题' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().task.id, firstTaskId);

    // A different cat trying to claim the same message-derived task is rejected.
    const opus = await registry.create('user-1', 'opus', thread.id);
    const third = await app.inject({
      method: 'POST',
      url: '/api/callbacks/task-claim',
      headers: { 'x-invocation-id': opus.invocationId, 'x-callback-token': opus.callbackToken },
      payload: { messageId: msg.id, title: '修复登录问题' },
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
      payload: { messageId: msg.id, title: '修复登录问题' },
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

  // ---- 批次4-B5 票面卫生四规则 (docs/research/raft-r9-ticket-hygiene.md) ----
  describe('B5 ticket hygiene (message-id claim foolproofing)', () => {
    function withEnv(overrides, fn) {
      const previous = {};
      for (const key of Object.keys(overrides)) previous[key] = process.env[key];
      Object.assign(process.env, overrides);
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          for (const key of Object.keys(overrides)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
          }
        });
    }

    // ---- B5.1 层级规则 (AC①) ----

    test('B5.1: a message inside a branch/discussion thread is rejected with a Chinese hint', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const branch = await threadStore.create('user-1', 'Branch', undefined, {
        relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-msg' },
      });
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '这个方案我觉得可以',
        mentions: [],
        timestamp: Date.now(),
        threadId: branch.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', branch.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '不该被建的票' },
      });

      assert.equal(res.statusCode, 403, res.body);
      const body = res.json();
      assert.equal(body.code, 'TASK_CLAIM_THREAD_NOT_TOP_LEVEL');
      assert.match(body.hint, /讨论上下文不入票/);
      assert.match(body.hint, /task_create/);
    });

    test('B5.1: a top-level channel message (no relation) is unaffected', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '帮我修一下这个 bug',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '修复 bug' },
      });

      assert.equal(res.statusCode, 201, res.body);
    });

    test('B5.1: CLOWDER_TICKET_HYGIENE_THREAD_HIERARCHY=false restores the old (unguarded) behavior', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_THREAD_HIERARCHY: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        const branch = await threadStore.create('user-1', 'Branch', undefined, {
          relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-msg' },
        });
        const msg = await messageStore.append({
          userId: 'user-1',
          catId: null,
          content: '这个方案我觉得可以',
          mentions: [],
          timestamp: Date.now(),
          threadId: branch.id,
        });
        const { invocationId, callbackToken } = await registry.create('user-1', 'codex', branch.id);

        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-claim',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { messageId: msg.id, title: '关闭开关后可以建票' },
        });

        assert.equal(res.statusCode, 201, res.body);
      });
    });

    // ---- B5.2 自噬禁止 (AC②) ----

    test('B5.2: a cat-authored message is rejected with a Chinese hint', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: 'opus',
        content: '我认为这段实现没问题，可以合并',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '不该被建的票' },
      });

      assert.equal(res.statusCode, 403, res.body);
      const body = res.json();
      assert.equal(body.code, 'TASK_CLAIM_CAT_AUTHORED_MESSAGE');
      assert.match(body.hint, /猫发的消息不入票/);
      assert.match(body.hint, /task_create/);
    });

    test('B5.2: CLOWDER_TICKET_HYGIENE_CAT_AUTHOR_BLOCK=false restores the old (unguarded) behavior', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_CAT_AUTHOR_BLOCK: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        const msg = await messageStore.append({
          userId: 'user-1',
          catId: 'opus',
          content: '我认为这段实现没问题，可以合并',
          mentions: [],
          timestamp: Date.now(),
          threadId: main.id,
        });
        const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-claim',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { messageId: msg.id, title: '关闭开关后可以建票' },
        });

        assert.equal(res.statusCode, 201, res.body);
      });
    });

    // ---- B5.4 标题强制 (AC④) ----

    test('B5.4: missing title is rejected', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '帮我修一下这个 bug',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id },
      });

      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().code, 'TASK_CLAIM_TITLE_REQUIRED');
    });

    test('B5.4: a 61-char title is rejected', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '帮我修一下这个 bug',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: 'x'.repeat(61) },
      });

      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().code, 'TASK_CLAIM_TITLE_TOO_LONG');
    });

    test('B5.4: a valid title becomes the task title; the original message text lands as the discussion thread first post', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const originalContent = '登录页面点了按钮之后卡住转圈圈，等了三分钟也没反应，麻烦看下';
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: originalContent,
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '修复登录卡死' },
      });

      assert.equal(res.statusCode, 201, res.body);
      const task = res.json().task;
      assert.equal(task.title, '修复登录卡死');
      assert.notEqual(task.title, originalContent);

      const threadMessages = await messageStore.getByThread(task.taskThreadId, 10);
      assert.ok(
        threadMessages.some((m) => m.content === originalContent),
        'original message text must be preserved as the discussion thread first post',
      );
    });

    test('B5.4: CLOWDER_TICKET_HYGIENE_REQUIRE_TITLE=false restores the old (content-derived title) behavior', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_REQUIRE_TITLE: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        const msg = await messageStore.append({
          userId: 'user-1',
          catId: null,
          content: '帮我修一下这个 bug',
          mentions: [],
          timestamp: Date.now(),
          threadId: main.id,
        });
        const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-claim',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { messageId: msg.id },
        });

        assert.equal(res.statusCode, 201, res.body);
        assert.equal(res.json().task.title, '帮我修一下这个 bug');
      });
    });

    // ---- B5.3 活跃票降级 (AC③) ----

    test('B5.3: an owned active task in the same thread downgrades the claim to a progress note (no duplicate ticket)', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const activeTask = taskStore.create({
        threadId: main.id,
        title: '正在修复登录问题',
        why: '',
        createdBy: 'user',
        ownerCatId: 'codex',
        status: 'doing',
      });
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '对了，顺便看看首页加载也有点慢',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '首页加载慢' },
      });

      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.created, false);
      assert.equal(body.downgraded, true);
      assert.equal(body.task.id, activeTask.id, 'must attach to the existing active task, not mint a new one');
      assert.match(body.hint, /已挂到/);
      assert.match(body.hint, /task_create/);

      // No duplicate ticket was created.
      const allTasks = await taskStore.listByThread(main.id);
      assert.equal(allTasks.length, 1);

      // The message content landed as a progress note in the active task's own discussion thread.
      const updatedTask = await taskStore.get(activeTask.id);
      assert.ok(updatedTask.taskThreadId, 'downgrade must ensure a discussion thread exists');
      const discussionMessages = await messageStore.getByThread(updatedTask.taskThreadId, 20);
      assert.ok(
        discussionMessages.some((m) => m.content === '对了，顺便看看首页加载也有点慢' && m.origin === 'progress'),
        'source message content must be attached as a progress-origin message',
      );
      assert.ok(
        updatedTask.events.some((e) => e.type === 'progress_note' && e.data?.sourceMessageId === msg.id),
        'a progress_note TaskEvent pointer must be recorded on the task',
      );

      // A visible notice card landed in the origin channel.
      const channelMessages = await messageStore.getByThread(main.id, 20);
      const notice = channelMessages.find((m) => m.extra?.systemKind === 'task_progress_attached');
      assert.ok(notice, 'a visible notice card must be posted to the channel');
      assert.match(notice.content, /已挂到/);
      assert.match(notice.content, /task_create/);
    });

    test('B5.3: explicit task_create still creates a new task even when the cat has an active task', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      taskStore.create({
        threadId: main.id,
        title: '正在修复登录问题',
        why: '',
        createdBy: 'user',
        ownerCatId: 'codex',
        status: 'doing',
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: '这是真正独立的新工作' },
      });

      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().task.title, '这是真正独立的新工作');
      const allTasks = await taskStore.listByThread(main.id);
      assert.equal(allTasks.length, 2, 'explicit task_create is an escape hatch and must not be downgraded');
    });

    test('B5.3: a DIFFERENT active task owner is unaffected (downgrade is scoped to the claiming cat)', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      taskStore.create({
        threadId: main.id,
        title: 'opus 在忙的票',
        why: '',
        createdBy: 'user',
        ownerCatId: 'opus',
        status: 'doing',
      });
      const msg = await messageStore.append({
        userId: 'user-1',
        catId: null,
        content: '帮我修一下这个 bug',
        mentions: [],
        timestamp: Date.now(),
        threadId: main.id,
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-claim',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { messageId: msg.id, title: '修复 bug' },
      });

      assert.equal(res.statusCode, 201, res.body, 'codex has no active task of its own, so a new ticket is created');
      assert.equal(res.json().created, true);
    });

    test('B5.3: CLOWDER_TICKET_HYGIENE_ACTIVE_TASK_DOWNGRADE=false restores the old (always new/reuse-by-message) behavior', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_ACTIVE_TASK_DOWNGRADE: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        taskStore.create({
          threadId: main.id,
          title: '正在修复登录问题',
          why: '',
          createdBy: 'user',
          ownerCatId: 'codex',
          status: 'doing',
        });
        const msg = await messageStore.append({
          userId: 'user-1',
          catId: null,
          content: '对了，顺便看看首页加载也有点慢',
          mentions: [],
          timestamp: Date.now(),
          threadId: main.id,
        });
        const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-claim',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { messageId: msg.id, title: '首页加载慢' },
        });

        assert.equal(res.statusCode, 201, res.body);
        assert.equal(res.json().created, true);
        const allTasks = await taskStore.listByThread(main.id);
        assert.equal(allTasks.length, 2, 'with the gate off, a second ticket is created instead of downgrading');
      });
    });
  });

  // ---- 批次4-B5.5 建票上浮到主频道 (docs/prd/batch4-codex-execution.md §3 B5.5) ----
  // Entry ① in the PRD's inventory: 猫侧显式建票 cat_cafe_task_create → /api/callbacks/task-create.
  describe('B5.5 建票上浮到主频道 (cat_cafe_task_create entry)', () => {
    function withEnv(overrides, fn) {
      const previous = {};
      for (const key of Object.keys(overrides)) previous[key] = process.env[key];
      Object.assign(process.env, overrides);
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          for (const key of Object.keys(overrides)) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
          }
        });
    }

    // ---- AC① ----
    test('AC①: cat_cafe_task_create from inside a branch thread anchors the task to the top-level channel, leaves a branch receipt, and records origin fields', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const branch = await threadStore.create('user-1', 'Branch', undefined, {
        relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-msg' },
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', branch.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: '分支里建的票' },
      });

      assert.equal(res.statusCode, 201, res.body);
      const task = res.json().task;
      assert.equal(task.threadId, main.id, 'task must be anchored to the top-level channel, not the branch');

      const hoistEvent = task.events?.find((e) => e.type === 'hoisted_to_channel');
      assert.ok(hoistEvent, 'a hoisted_to_channel event must be recorded');
      assert.equal(hoistEvent.data.originThreadId, branch.id);

      const branchMessages = await messageStore.getByThread(branch.id, 20);
      const notice = branchMessages.find((m) => m.extra?.systemKind === 'task_hoisted_to_channel');
      assert.ok(notice, 'a lightweight receipt must be posted back to the originating branch');
      assert.match(notice.content, /已在主频道创建任务/);

      const mainTasks = await taskStore.listByThread(main.id);
      assert.equal(mainTasks.length, 1, 'the task must actually live at the top-level channel');
    });

    // ---- AC② ----
    test('AC②: a task_create from a 3-level-deep nested branch resolves all the way up to the root channel', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const branch1 = await threadStore.create('user-1', 'Branch1', undefined, {
        relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-1' },
      });
      const branch2 = await threadStore.create('user-1', 'Branch2', undefined, {
        relation: { v: 1, kind: 'task_thread', parentThreadId: branch1.id, rootMessageId: 'root-2' },
      });
      const branch3 = await threadStore.create('user-1', 'Branch3', undefined, {
        relation: { v: 1, kind: 'message_thread', parentThreadId: branch2.id, rootMessageId: 'root-3' },
      });
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', branch3.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: '三层嵌套分支里建的票' },
      });

      assert.equal(res.statusCode, 201, res.body);
      assert.equal(
        res.json().task.threadId,
        main.id,
        'must resolve all the way to the root channel, not just one level up',
      );
    });

    // ---- AC④ ----
    test('AC④: a top-level channel invocation is unaffected (no hoist, no event)', async () => {
      const app = await createApp();
      const main = await threadStore.create('user-1', 'Main');
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', main.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: '顶层频道建的票' },
      });

      assert.equal(res.statusCode, 201, res.body);
      const task = res.json().task;
      assert.equal(task.threadId, main.id);
      assert.equal(task.events?.some((e) => e.type === 'hoisted_to_channel') ?? false, false);
    });

    test('AC④: a DM thread invocation is unaffected (no hoist)', async () => {
      const app = await createApp();
      const dm = await threadStore.create('user-1', 'DM with codex');
      await threadStore.updateIsDM(dm.id, true);
      const { invocationId, callbackToken } = await registry.create('user-1', 'codex', dm.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/task-create',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: { title: 'DM 里建的票' },
      });

      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().task.threadId, dm.id);
    });

    // ---- AC⑤ ----
    test('AC⑤: CLOWDER_TICKET_HYGIENE_HOIST_TO_CHANNEL=false restores the old (anchor-stays-on-branch) behavior', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_HOIST_TO_CHANNEL: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        const branch = await threadStore.create('user-1', 'Branch', undefined, {
          relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-msg' },
        });
        const { invocationId, callbackToken } = await registry.create('user-1', 'codex', branch.id);

        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-create',
          headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
          payload: { title: '关闭开关后建的票' },
        });

        assert.equal(res.statusCode, 201, res.body);
        const task = res.json().task;
        assert.equal(
          task.threadId,
          branch.id,
          'with the gate off, the task stays anchored to the branch it was created from',
        );

        const branchMessages = await messageStore.getByThread(branch.id, 20);
        assert.equal(
          branchMessages.some((m) => m.extra?.systemKind === 'task_hoisted_to_channel'),
          false,
          'no receipt when the gate is off',
        );
      });
    });

    // ---- B5.3 判定层一致性: 上浮后 findActiveOwnedTaskInThread 必须按同一层判定 ----
    test('B5.3 判定层一致性: an active task hoisted from a branch is still found (and downgrades) a same-cat message-id claim from that same branch, with B5.1 relaxed', async () => {
      await withEnv({ CLOWDER_TICKET_HYGIENE_THREAD_HIERARCHY: 'false' }, async () => {
        const app = await createApp();
        const main = await threadStore.create('user-1', 'Main');
        const branch = await threadStore.create('user-1', 'Branch', undefined, {
          relation: { v: 1, kind: 'inline_reply', parentThreadId: main.id, rootMessageId: 'root-msg' },
        });

        // codex creates an owned task from inside the branch — it gets hoisted to main.
        const invocation1 = await registry.create('user-1', 'codex', branch.id);
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-create',
          headers: { 'x-invocation-id': invocation1.invocationId, 'x-callback-token': invocation1.callbackToken },
          payload: { title: '正在处理的活跃票', ownerCatId: 'codex' },
        });
        assert.equal(createRes.statusCode, 201, createRes.body);
        const activeTask = createRes.json().task;
        assert.equal(activeTask.threadId, main.id, 'sanity check: the active task really did get hoisted to main');

        // A second message, still inside the SAME branch (B5.1 relaxed so this reaches B5.3).
        const msg2 = await messageStore.append({
          userId: 'user-1',
          catId: null,
          content: '顺便看看这个也修一下',
          mentions: [],
          timestamp: Date.now(),
          threadId: branch.id,
        });
        const invocation2 = await registry.create('user-1', 'codex', branch.id);
        const claimRes = await app.inject({
          method: 'POST',
          url: '/api/callbacks/task-claim',
          headers: { 'x-invocation-id': invocation2.invocationId, 'x-callback-token': invocation2.callbackToken },
          payload: { messageId: msg2.id, title: '顺便的这个' },
        });

        assert.equal(claimRes.statusCode, 200, claimRes.body);
        const claimBody = claimRes.json();
        assert.equal(claimBody.downgraded, true, 'must downgrade onto the already-hoisted active task, not mint a duplicate');
        assert.equal(claimBody.task.id, activeTask.id);

        const allMainTasks = await taskStore.listByThread(main.id);
        assert.equal(allMainTasks.length, 1, 'no duplicate ticket at the channel layer');
      });
    });
  });
});
