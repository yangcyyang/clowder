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
    emitToUser(userId, event, data) {
      events.push({ userId, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

describe('Tasks Routes', () => {
  let taskStore;
  let threadStore;
  let socketManager;
  let messageStore;

  beforeEach(async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
    messageStore = {
      messages: [],
      async append(input) {
        const stored = { ...input, id: `msg-${this.messages.length + 1}`, threadId: input.threadId ?? 'default' };
        this.messages.push(stored);
        return stored;
      },
      async getById(id) {
        return this.messages.find((message) => message.id === id) ?? null;
      },
      async getByThread(threadId) {
        return this.messages.filter((message) => message.threadId === threadId);
      },
    };
  });

  async function createApp() {
    const { tasksRoutes } = await import('../dist/routes/tasks.js');
    const app = Fastify();
    await app.register(tasksRoutes, { taskStore, threadStore, messageStore, socketManager });
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
    assert.equal(events.length, 2);
    assert.equal(events[0].room, 'thread:thread-1');
    assert.equal(events[0].event, 'task_created');
    assert.equal(events[0].data.title, 'Test task');
    assert.equal(events[1].event, 'connector_message');
    assert.match(events[1].data.message.content, /已创建 task #1/);
  });

  test('POST with sourceMessageId leaves a visible conversion notice', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Convert me',
        why: '',
        createdBy: 'user',
        sourceMessageId: 'msg-source-1',
      },
    });

    const notice = messageStore.messages.at(-1);
    assert.equal(notice.userId, 'system');
    assert.equal(notice.source.meta.presentation, 'system_notice');
    assert.match(notice.content, /已从消息创建 task #1：Convert me/);
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

  test('GET lists all work tasks across threads when scope=all', async () => {
    const app = await createApp();

    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-2', title: 'Task B', why: '', createdBy: 'codex' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${createRes.json().id}`,
      payload: { status: 'in_review' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/tasks?scope=all&kind=work&status=in_review',
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].threadId, 'thread-2');
    assert.equal(body.tasks[0].title, 'Task B');
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

  // ---- POST /api/tasks/:id/thread ----

  test('POST task thread returns task context for the thread status card', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: '验证任务 Thread 状态卡',
        why: '用户需要一眼看到状态和交付证据',
        createdBy: 'opus',
        ownerCatId: 'codex',
      },
    });
    const taskId = createRes.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        status: 'in_review',
        evidence: {
          tests: 'node --test packages/api/test/tasks-route.test.js passed',
          review: '@专家-Claude review passed',
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/thread`,
      payload: { userId: 'user-1' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.threadId, body.task.taskThreadId);
    assert.equal(body.sourceMessage.id, body.task.sourceMessageId);
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.title, '验证任务 Thread 状态卡');
    assert.equal(body.task.status, 'in_review');
    assert.equal(body.task.ownerCatId, 'codex');
    assert.equal(body.task.evidence.tests, 'node --test packages/api/test/tasks-route.test.js passed');
    assert.equal(body.task.evidence.review, '@专家-Claude review passed');
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

    // task_created + create notice + task_updated + status notice
    const events = socketManager.getEvents();
    assert.equal(events.length, 4);
    assert.equal(events[2].event, 'task_updated');
    assert.match(events[3].data.message.content, /状态：待办 → 进行中/);
  });

  test('PATCH emits user task_attention when work task enters review', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Ready for review',
        why: '',
        createdBy: 'user',
        userId: 'user-1',
      },
    });
    const taskId = createRes.json().id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'in_review' },
    });

    assert.equal(response.statusCode, 200);
    const events = socketManager.getEvents();
    const attention = events.find((event) => event.event === 'task_attention');
    assert.equal(attention.userId, 'user-1');
    assert.equal(attention.data.id, taskId);
    assert.equal(attention.data.status, 'in_review');
  });

  test('PATCH does not emit task_attention when status is unchanged', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        threadId: 'thread-1',
        title: 'Already review',
        why: '',
        createdBy: 'user',
        userId: 'user-1',
      },
    });
    const taskId = createRes.json().id;

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'in_review' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { why: 'updated reason' },
    });

    const attentionEvents = socketManager.getEvents().filter((event) => event.event === 'task_attention');
    assert.equal(attentionEvents.length, 1);
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

  test('PATCH writes visible notices for claim and done', async () => {
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
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'done', eventCatId: 'codex' },
    });

    const notices = messageStore.messages.map((message) => message.content);
    assert.ok(notices.some((content) => /task #1 已由 codex 认领/.test(content)));
    assert.ok(notices.some((content) => /task #1 已完成：Task A/.test(content)));
  });

  test('PATCH failed status persists failure taxonomy and writes failed event data', async () => {
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
        status: 'failed',
        failureClass: 'test_failed',
        failureReason: 'queue-processor.test.js failed',
        eventCatId: 'codex',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'failed');
    assert.equal(body.failureClass, 'test_failed');
    assert.equal(body.failureReason, 'queue-processor.test.js failed');
    assert.deepEqual(
      body.events.map((event) => event.type),
      ['status_changed', 'failed'],
    );
    const failedEvent = body.events.at(-1);
    assert.equal(failedEvent.catId, 'codex');
    assert.equal(failedEvent.data.failureClass, 'test_failed');
    assert.equal(failedEvent.data.failureReason, 'queue-processor.test.js failed');
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

  test('GET task events by thread endpoint filters by event type', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: { catId: 'opus', type: 'handoff', data: { toCatId: 'codex' } },
    });
    await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: { catId: 'system', type: 'failed', data: { reason: 'manual audit' } },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events?type=handoff`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'handoff');
    assert.equal(response.json().events[0].data.toCatId, 'codex');
  });

  test('POST task events accepts artifact event payload and filters it', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: {
        catId: 'codex',
        type: 'artifact',
        data: {
          files: [{ path: 'packages/api/src/index.ts', added: 3, removed: 1 }],
          totalAdded: 3,
          totalRemoved: 1,
        },
      },
    });
    assert.equal(postRes.statusCode, 201);

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events?type=artifact`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'artifact');
    assert.equal(response.json().events[0].data.totalAdded, 3);
  });

  test('POST task events accepts usage event payload and filters it', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: {
        catId: 'codex',
        type: 'usage',
        data: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: 1000,
          cacheReadTokens: 600,
          cacheCreationTokens: 100,
          outputTokens: 500,
          totalTokens: 1500,
          costUsd: 0.00045,
          durationMs: 2345,
        },
      },
    });
    assert.equal(postRes.statusCode, 201);

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events?type=usage`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'usage');
    assert.equal(response.json().events[0].data.totalTokens, 1500);
    assert.equal(response.json().events[0].data.costUsd, 0.00045);
    assert.equal(response.json().events[0].data.cacheReadTokens, 600);
    assert.equal(response.json().events[0].data.cacheCreationTokens, 100);
    assert.equal(response.json().events[0].data.durationMs, 2345);
  });

  test('POST task events accepts tool_usage event payload and filters it', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'OpenCLI title check', why: '', createdBy: 'codex' },
    });
    const taskId = createRes.json().id;

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: {
        catId: 'codex',
        type: 'tool_usage',
        data: {
          toolName: 'opencli.browser.open',
          category: 'mcp',
          url: 'https://example.com',
          title: 'Example Domain',
          status: 'completed',
          invocationId: 'inv-opencli-title',
        },
      },
    });
    assert.equal(postRes.statusCode, 201);

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events?type=tool_usage`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'tool_usage');
    assert.equal(response.json().events[0].data.toolName, 'opencli.browser.open');
    assert.equal(response.json().events[0].data.title, 'Example Domain');
    assert.equal(response.json().events[0].data.invocationId, 'inv-opencli-title');
  });

  test('POST task events accepts fast lane completion payload and filters it', async () => {
    const app = await createApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId: 'thread-1', title: 'Task A', why: '', createdBy: 'opus' },
    });
    const taskId = createRes.json().id;

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/tasks/${taskId}/events`,
      payload: {
        catId: 'codex',
        type: 'fast_lane_completed',
        data: {
          workflowId: 'project-init',
          routeExecutionBypassed: true,
          durationMs: 12,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        },
      },
    });
    assert.equal(postRes.statusCode, 201);

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/tasks/${taskId}/events?type=fast_lane_completed`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().events.length, 1);
    assert.equal(response.json().events[0].type, 'fast_lane_completed');
    assert.equal(response.json().events[0].data.workflowId, 'project-init');
    assert.equal(response.json().events[0].data.routeExecutionBypassed, true);
    assert.equal(response.json().events[0].data.tokenUsage.totalTokens, 0);
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
    assert.equal(events.length, 3);
    assert.equal(events[2].event, 'task_updated');
    assert.equal(events[2].data.evidence.review, '@专家-Claude review passed');
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
