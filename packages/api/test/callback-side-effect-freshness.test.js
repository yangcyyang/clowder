import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const { FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

describe('protected callback side effects', () => {
  let app;
  let registry;
  let messageStore;
  let taskStore;
  let threadStore;
  let broadcasts;
  let uploadDir;
  let validateRepo;

  beforeEach(async () => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    broadcasts = [];
    uploadDir = await mkdtemp(join(tmpdir(), 'clowder-freshness-doc-'));
    process.env.UPLOAD_DIR = uploadDir;
    validateRepo = undefined;

    const freshnessGate = new FreshnessEgressGate({
      messageStore,
      holdStore: new FreshnessHoldStore({ maxReviews: 2 }),
    });
    const socketManager = {
      broadcastAgentMessage(message) {
        broadcasts.push({ event: 'agent_message', message });
      },
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
      emitToUser() {},
    };
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      taskStore,
      threadStore,
      socketManager,
      freshnessGate,
      ...(validateRepo ? { validateRepo } : {}),
    });
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.UPLOAD_DIR;
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function createProtectedInvocation(threadId) {
    const baseline = await messageStore.captureFreshnessWatermark(threadId, { kind: 'cat', catId: 'opus' });
    return registry.create('user-1', 'opus', threadId, undefined, undefined, { freshnessBaseline: baseline });
  }

  async function appendNewerUserInput(threadId) {
    await messageStore.append({
      userId: 'user-1',
      threadId,
      catId: null,
      content: 'newer user input',
      mentions: [],
    });
  }

  test('create-task: stale is inert, current executes once, replay is inert', async () => {
    const staleThreadId = 'task-stale';
    const staleAuth = await createProtectedInvocation(staleThreadId);
    await appendNewerUserInput(staleThreadId);
    const payload = { title: 'protected task', why: 'freshness' };
    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
      payload,
    });
    assert.equal(stale.json().status, 'freshness_retry_required');
    assert.equal(taskStore.listByThread(staleThreadId).length, 0);

    const currentThreadId = 'task-current';
    const currentAuth = await createProtectedInvocation(currentThreadId);
    const request = {
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': currentAuth.invocationId, 'x-callback-token': currentAuth.callbackToken },
      payload,
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    assert.equal(first.statusCode, 201);
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(taskStore.listByThread(currentThreadId).length, 1);
  });

  test('create-task: auto-task reuse is protected and replay is inert', async () => {
    const parent = threadStore.create('user-1', 'auto parent');
    const taskThread = threadStore.create('user-1', 'auto task thread');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'auto root',
      why: 'freshness',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const auth = await createProtectedInvocation(taskThread.id);
    const request = {
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { title: 'model duplicate create' },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'existing_task');
    assert.equal(first.json().task.id, root.id);
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(taskStore.listByKind('work').length, 1);
  });

  test('create-task: invalid parentTaskId remains a stable 409 across retries', async () => {
    const parent = threadStore.create('user-1', 'invalid parent');
    const taskThread = threadStore.create('user-1', 'invalid task thread');
    const root = taskStore.create({
      threadId: parent.id,
      title: 'auto root',
      why: 'freshness',
      createdBy: 'user',
      ownerCatId: 'opus',
      status: 'doing',
      userId: 'user-1',
      subjectKey: `work-intake:${parent.id}:root`,
    });
    taskStore.linkTaskThreadIfAbsent(root.id, { taskThreadId: taskThread.id });
    const auth = await createProtectedInvocation(taskThread.id);
    const request = {
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { title: 'invalid child', parentTaskId: 'task-wrong' },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    assert.equal(first.statusCode, 409);
    assert.equal(retry.statusCode, 409);
    assert.match(first.json().error, /parentTaskId/);
    assert.match(retry.json().error, /parentTaskId/);
    assert.equal(taskStore.listByKind('work').length, 1);
  });

  test('generate-document: stale is inert, current executes once, replay is inert', async () => {
    const payload = { markdown: '# Protected', format: 'md', baseName: 'protected' };
    const staleAuth = await createProtectedInvocation('doc-stale');
    await appendNewerUserInput('doc-stale');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/generate-document',
      headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
      payload,
    });
    assert.equal(stale.json().status, 'freshness_retry_required');
    assert.deepEqual(await readdir(uploadDir), []);

    const currentAuth = await createProtectedInvocation('doc-current');
    const request = {
      method: 'POST',
      url: '/api/callbacks/generate-document',
      headers: { 'x-invocation-id': currentAuth.invocationId, 'x-callback-token': currentAuth.callbackToken },
      payload,
    };
    const first = await app.inject(request);
    const filesAfterFirst = await readdir(uploadDir);
    const messagesAfterFirst = broadcasts.filter((entry) => entry.event === 'agent_message').length;
    const replay = await app.inject(request);
    assert.equal(first.json().status, 'ok');
    assert.equal(replay.json().status, 'duplicate');
    assert.deepEqual(await readdir(uploadDir), filesAfterFirst);
    assert.equal(broadcasts.filter((entry) => entry.event === 'agent_message').length, messagesAfterFirst);
  });

  test('shared callback boundary protects the remaining write-route family', async () => {
    const payload = { repoFullName: 'cat-cafe/clowder', prNumber: 193 };
    const staleAuth = await createProtectedInvocation('pr-stale');
    await appendNewerUserInput('pr-stale');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
      payload,
    });
    assert.equal(stale.json().status, 'freshness_retry_required');
    assert.equal(taskStore.listByThread('pr-stale').length, 0);

    const currentAuth = await createProtectedInvocation('pr-current');
    const request = {
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': currentAuth.invocationId, 'x-callback-token': currentAuth.callbackToken },
      payload,
    };
    assert.equal((await app.inject(request)).json().status, 'ok');
    assert.equal((await app.inject(request)).json().status, 'duplicate');
    assert.equal(taskStore.listByThread('pr-current').length, 1);
  });

  test('a failed business precondition does not consume the side-effect claim', async () => {
    let repoAccessible = false;
    validateRepo = async () => repoAccessible;
    await app.close();
    const freshnessGate = new FreshnessEgressGate({
      messageStore,
      holdStore: new FreshnessHoldStore({ maxReviews: 2 }),
    });
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      taskStore,
      threadStore,
      socketManager: {
        broadcastAgentMessage() {},
        broadcastToRoom() {},
        emitToUser() {},
      },
      freshnessGate,
      validateRepo,
    });

    const auth = await createProtectedInvocation('pr-retry');
    const request = {
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { repoFullName: 'cat-cafe/clowder', prNumber: 194 },
    };
    assert.equal((await app.inject(request)).statusCode, 422);
    repoAccessible = true;
    assert.equal((await app.inject(request)).json().status, 'ok');
    assert.equal(taskStore.listByThread('pr-retry').length, 1);
  });
});
