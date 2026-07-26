/**
 * F194 item 4 (batch 2-A): shared task-lifecycle system notice primitive.
 * docs/research/clowder-raft-thread-task-design.md §2 root cause 4 / §3 step 1.3.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

const {
  appendTaskLifecycleNotice,
  taskLifecycleLabel,
  _resetTaskLifecycleNoticeDedupeForTests,
} = await import('../dist/routes/task-event-notices.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

function socketManager(events) {
  return { broadcastToRoom: (room, event, payload) => events.push({ room, event, payload }) };
}

function messageStoreStub() {
  const messages = [];
  return {
    messages,
    async append(input) {
      const stored = { ...input, id: `msg-${messages.length + 1}` };
      messages.push(stored);
      return stored;
    },
  };
}

describe('F194 task-event-notices (shared module)', () => {
  afterEach(() => {
    _resetTaskLifecycleNoticeDedupeForTests();
  });

  test('appendTaskLifecycleNotice appends + broadcasts with the task-system source shape and extra.systemKind', async () => {
    const events = [];
    const messageStore = messageStoreStub();
    const task = { id: 'task-1', threadId: 'thread-1' };

    const result = await appendTaskLifecycleNotice({
      task,
      content: '已创建任务 #1：修复登录超时（opus 执行中）',
      systemKind: 'task_created',
      eventType: 'task_created',
      dedupeKey: 'created',
      deps: { messageStore, socketManager: socketManager(events) },
    });

    assert.equal(result.posted, true);
    assert.equal(messageStore.messages.length, 1);
    const stored = messageStore.messages[0];
    assert.equal(stored.userId, 'system');
    assert.equal(stored.catId, null);
    assert.equal(stored.threadId, 'thread-1');
    assert.equal(stored.extra.systemKind, 'task_created');
    assert.equal(stored.source.connector, 'task-system');
    assert.equal(stored.source.meta.eventType, 'task_created');
    assert.equal(stored.source.meta.taskId, 'task-1');

    assert.equal(events.length, 1);
    assert.equal(events[0].room, 'thread:thread-1');
    assert.equal(events[0].event, 'connector_message');
    assert.equal(events[0].payload.message.content, stored.content);
  });

  test('same task + same dedupeKey within 5 minutes is suppressed (anti-spam)', async () => {
    const events = [];
    const messageStore = messageStoreStub();
    const task = { id: 'task-2', threadId: 'thread-1' };
    const deps = { messageStore, socketManager: socketManager(events) };

    const first = await appendTaskLifecycleNotice({
      task,
      content: 'task #2 状态：进行中 → 待验收。',
      systemKind: 'task_status_changed',
      eventType: 'task_status_changed',
      dedupeKey: 'status:in_review',
      deps,
    });
    const second = await appendTaskLifecycleNotice({
      task,
      content: 'task #2 状态：进行中 → 待验收。',
      systemKind: 'task_status_changed',
      eventType: 'task_status_changed',
      dedupeKey: 'status:in_review',
      deps,
    });

    assert.equal(first.posted, true);
    assert.equal(second.posted, false, 'duplicate same-task-same-status within 5 minutes must be suppressed');
    assert.equal(messageStore.messages.length, 1);
    assert.equal(events.length, 1);
  });

  test('a different dedupeKey (different status) for the SAME task is not suppressed', async () => {
    const events = [];
    const messageStore = messageStoreStub();
    const task = { id: 'task-3', threadId: 'thread-1' };
    const deps = { messageStore, socketManager: socketManager(events) };

    await appendTaskLifecycleNotice({
      task,
      content: 'doing',
      systemKind: 'task_status_changed',
      eventType: 'task_status_changed',
      dedupeKey: 'status:doing',
      deps,
    });
    const secondStatus = await appendTaskLifecycleNotice({
      task,
      content: 'in_review',
      systemKind: 'task_status_changed',
      eventType: 'task_status_changed',
      dedupeKey: 'status:in_review',
      deps,
    });

    assert.equal(secondStatus.posted, true, 'a genuinely different status transition is never deduped');
    assert.equal(messageStore.messages.length, 2);
  });

  test('a DIFFERENT task with the same dedupeKey is never cross-suppressed', async () => {
    const events = [];
    const messageStore = messageStoreStub();
    const deps = { messageStore, socketManager: socketManager(events) };

    const a = await appendTaskLifecycleNotice({
      task: { id: 'task-4a', threadId: 'thread-1' },
      content: 'created',
      systemKind: 'task_created',
      eventType: 'task_created',
      dedupeKey: 'created',
      deps,
    });
    const b = await appendTaskLifecycleNotice({
      task: { id: 'task-4b', threadId: 'thread-1' },
      content: 'created',
      systemKind: 'task_created',
      eventType: 'task_created',
      dedupeKey: 'created',
      deps,
    });

    assert.equal(a.posted, true);
    assert.equal(b.posted, true);
  });

  test('taskLifecycleLabel uses the same "#N" (1-based) convention', async () => {
    const taskStore = new TaskStore();
    const t1 = await taskStore.create({ threadId: 'thread-x', title: 'A', createdBy: 'user' });
    const t2 = await taskStore.create({ threadId: 'thread-x', title: 'B', createdBy: 'user' });

    assert.equal(await taskLifecycleLabel(taskStore, t1), '#1');
    assert.equal(await taskLifecycleLabel(taskStore, t2), '#2');
  });
});
