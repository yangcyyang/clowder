// @ts-check
/**
 * 票B B3 — principal scope on /api/tasks routes.
 *
 * Bug: GET /api/tasks?scope=all, PATCH /api/tasks/:id, DELETE /api/tasks/:id
 * had no caller-scope verification — any principal could list every task or
 * mutate/delete tasks bound to another user's thread.
 *
 * Minimal safe check (documented boundary):
 *  - identity required (session cookie / X-Cat-Cafe-User), else 401.
 *  - task bound via task.userId → must match caller.
 *  - else task bound via parent thread.createdBy → must match caller.
 *  - tasks with NO binding at all (legacy, created without userId in a thread
 *    with no creator) remain accessible to any authenticated principal.
 *
 * SENTINELS: scope=all without principal → 401; cross-thread PATCH → 403;
 * cross-user DELETE → 403; owner PATCH → 200; scope=all filters foreign tasks.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const ALICE = { 'x-cat-cafe-user': 'alice' };
const BOB = { 'x-cat-cafe-user': 'bob' };

function createMockSocketManager() {
  return {
    broadcastToRoom() {},
    emitToUser() {},
  };
}

describe('B3 tasks principal scope', () => {
  let taskStore;
  let threadStore;
  let messageStore;

  beforeEach(async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    messageStore = {
      messages: [],
      async append(input) {
        const stored = { ...input, id: `msg-${this.messages.length + 1}` };
        this.messages.push(stored);
        return stored;
      },
      async getByThread() {
        return [];
      },
    };
  });

  async function createApp() {
    const { tasksRoutes } = await import('../dist/routes/tasks.js');
    const app = Fastify();
    await app.register(tasksRoutes, {
      taskStore,
      threadStore,
      messageStore,
      socketManager: createMockSocketManager(),
    });
    return app;
  }

  async function seedAliceThreadAndTask() {
    const thread = await threadStore.create('alice', 'alice thread');
    const task = await taskStore.create({
      threadId: thread.id,
      title: 'alice task',
      why: 'bound to alice thread',
      createdBy: 'user',
    });
    return { thread, task };
  }

  test('SENTINEL: GET scope=all without principal → 401', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/tasks?scope=all' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('SENTINEL: scope=all hides tasks bound to another user', async () => {
    const app = await createApp();
    await seedAliceThreadAndTask(); // bound to alice via thread.createdBy
    await taskStore.create({ threadId: 'nowhere', title: 'bob task', why: '', createdBy: 'user', userId: 'bob' });

    const asBob = await app.inject({ method: 'GET', url: '/api/tasks?scope=all', headers: BOB });
    assert.equal(asBob.statusCode, 200);
    const bobTasks = asBob.json().tasks;
    assert.equal(bobTasks.length, 1);
    assert.equal(bobTasks[0].title, 'bob task');

    const asAlice = await app.inject({ method: 'GET', url: '/api/tasks?scope=all', headers: ALICE });
    const aliceTitles = asAlice.json().tasks.map((t) => t.title);
    assert.ok(aliceTitles.includes('alice task'));
    assert.ok(!aliceTitles.includes('bob task'));
    await app.close();
  });

  test('SENTINEL: cross-thread PATCH rejected (403), owner PATCH allowed', async () => {
    const app = await createApp();
    const { task } = await seedAliceThreadAndTask();

    const asBob = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: BOB,
      payload: { status: 'done' },
    });
    assert.equal(asBob.statusCode, 403, `expected 403, got ${asBob.statusCode}: ${asBob.body}`);
    assert.equal((await taskStore.get(task.id)).status, 'todo', 'rejected PATCH must not mutate');

    const asAlice = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: ALICE,
      payload: { status: 'done' },
    });
    assert.equal(asAlice.statusCode, 200);
    assert.equal(asAlice.json().status, 'done');
    await app.close();
  });

  test('SENTINEL: cross-user DELETE rejected (403); unauthenticated PATCH/DELETE → 401', async () => {
    const app = await createApp();
    const { task } = await seedAliceThreadAndTask();

    const anonPatch = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { status: 'done' } });
    assert.equal(anonPatch.statusCode, 401);
    const anonDelete = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` });
    assert.equal(anonDelete.statusCode, 401);

    const bobDelete = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: BOB });
    assert.equal(bobDelete.statusCode, 403);
    assert.ok(await taskStore.get(task.id), 'rejected DELETE must not remove the task');

    const aliceDelete = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: ALICE });
    assert.equal(aliceDelete.statusCode, 204);
    assert.equal(await taskStore.get(task.id), null);
    await app.close();
  });

  test('PATCH without identity on unbound task → 401 (identity always required)', async () => {
    const app = await createApp();
    const task = await taskStore.create({ threadId: 'nowhere', title: 'unbound', why: '', createdBy: 'user' });

    const res = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { status: 'doing' } });
    assert.equal(res.statusCode, 401);

    const authed = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: BOB,
      payload: { status: 'doing' },
    });
    assert.equal(authed.statusCode, 200, 'unbound legacy tasks stay editable by any authenticated principal');
    await app.close();
  });
});
