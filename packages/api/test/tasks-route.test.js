/**
 * Tasks Route Tests (毛线球)
 * Uses lightweight Fastify injection (no real HTTP server).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

function createMockSocketManager() {
  const events = [];
  return {
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

describe('Tasks Routes', () => {
  let taskStore;
  let socketManager;

  beforeEach(async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const { tasksRoutes } = await import('../dist/routes/tasks.js');
    const app = Fastify();
    await app.register(tasksRoutes, { taskStore, socketManager });
    return app;
  }

  // ---- POST /api/tasks ----

  test('POST creates a task and returns 201', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: '重构 AgentRouter',
        why: '超过 200 行',
        createdBy: 'opus',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.ok(body.id);
    assert.equal(body.threadId, 'thread-1');
    assert.equal(body.title, '重构 AgentRouter');
    assert.equal(body.status, 'todo');
    assert.equal(body.createdBy, 'opus');
  });

  test('POST accepts task lineage fields', async () => {
    const app = await createApp();
    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Parent task',
        why: '',
        createdBy: 'opus',
      },
    });
    const parentId = parentRes.json().id;

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Child task',
        why: '',
        createdBy: 'opus',
        parentTaskId: parentId,
        retryOf: 'task-retry-source',
        branchOf: 'task-branch-source',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.parentTaskId, parentId);
    assert.equal(body.retryOf, 'task-retry-source');
    assert.equal(body.branchOf, 'task-branch-source');
  });

  test('POST broadcasts task_created event', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Test task',
        why: 'Testing',
        createdBy: 'user',
      },
    });

    const events = socketManager.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].room, 'thread:thread-1');
    assert.equal(events[0].event, 'task_created');
    assert.equal(events[0].data.title, 'Test task');
  });

  test('POST rejects missing required fields', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1' },
    });

    assert.equal(response.statusCode, 400);
  });

  test('POST rejects invalid createdBy', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Test',
        why: '',
        createdBy: 'invalid-cat',
      },
    });

    assert.equal(response.statusCode, 400);
  });

  // ---- GET /api/tasks?threadId ----

  test('GET lists tasks for a thread', async () => {
    const app = await createApp();

    // Create two tasks
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task B', why: '', createdBy: 'codex' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks?threadId=thread-1',
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.tasks.length, 2);
  });

  test('GET requires threadId parameter', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks',
    });

    assert.equal(response.statusCode, 400);
  });

  // ---- GET /api/tasks/:id ----

  test('GET by id returns task', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().title, 'Task A');
  });

  test('GET by id returns 404 for nonexistent', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks/nonexistent',
    });

    assert.equal(response.statusCode, 404);
  });

  // ---- PATCH /api/tasks/:id ----

  test('PATCH updates status and broadcasts', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'doing' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'doing');

    // Should have 2 events: task_created + task_updated
    const events = socketManager.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'task_updated');
  });

  test('PATCH writes claimed, unclaimed, status_changed and completed task events', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const claimRes = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { ownerCatId: 'codex', status: 'doing', eventCatId: 'codex' },
    });
    assert.equal(claimRes.statusCode, 200);
    assert.deepEqual(
      claimRes.json().events.map((event) => event.type),
      ['claimed', 'status_changed'],
    );

    const doneRes = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'done', eventCatId: 'codex' },
    });
    assert.equal(doneRes.statusCode, 200);
    assert.deepEqual(
      doneRes.json().events.map((event) => event.type),
      ['claimed', 'status_changed', 'status_changed', 'completed'],
    );

    const unclaimRes = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { ownerCatId: null, eventCatId: 'codex' },
    });
    assert.equal(unclaimRes.statusCode, 200);
    assert.equal(unclaimRes.json().events.at(-1).type, 'unclaimed');
  });

  test('GET task events by thread endpoint returns embedded ledger', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { ownerCatId: 'codex', eventCatId: 'codex' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'claimed');
  });

  test('POST task events by thread endpoint appends manual ledger event', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: {
        catId: 'system',
        type: 'failed',
        data: { reason: 'manual audit' },
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'failed');
    assert.equal(response.json().events[0].data.reason, 'manual audit');
  });

  test('GET task by thread and lineage endpoint return association fields', async () => {
    const app = await createApp();
    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Parent', why: '', createdBy: 'opus' },
    });
    const parentId = parentRes.json().id;
    const childRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Child', why: '', createdBy: 'opus', parentTaskId: parentId },
    });
    const childId = childRes.json().id;

    const byThread = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${childId}`,
    });
    assert.equal(byThread.statusCode, 200);
    assert.equal(byThread.json().parentTaskId, parentId);

    const lineage = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${childId}/lineage`,
    });
    assert.equal(lineage.statusCode, 200);
    assert.equal(lineage.json().task.id, childId);
    assert.deepEqual(
      lineage.json().lineage.map((task) => task.id),
      [parentId],
    );
  });

  test('PATCH accepts in_review as a first-class status', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'in_review' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'in_review');
  });

  test('PATCH updates delivery evidence and broadcasts', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        evidence: {
          tests: 'node --test packages/api/test/tasks-route.test.js passed',
          build: 'pnpm --filter @cat-cafe/api build passed',
          review: '@专家-Claude review passed',
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.evidence.tests, 'node --test packages/api/test/tasks-route.test.js passed');
    assert.equal(body.evidence.build, 'pnpm --filter @cat-cafe/api build passed');
    assert.equal(body.evidence.review, '@专家-Claude review passed');
    assert.equal(typeof body.evidence.updatedAt, 'number');

    const events = socketManager.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'task_updated');
    assert.equal(events[1].data.evidence.review, '@专家-Claude review passed');
  });

  test('PATCH returns 404 for nonexistent task', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/nonexistent',
      payload: { status: 'done' },
    });

    assert.equal(response.statusCode, 404);
  });

  test('PATCH rejects invalid status value', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'invalid-status' },
    });

    assert.equal(response.statusCode, 400);
  });

  // ---- DELETE /api/tasks/:id ----

  test('DELETE removes task and returns 204', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
    });

    assert.equal(response.statusCode, 204);

    // Verify it's gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('DELETE returns 404 for nonexistent', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/nonexistent',
    });

    assert.equal(response.statusCode, 404);
  });
});
