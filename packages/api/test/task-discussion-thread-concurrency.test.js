import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ensureTaskDiscussionThread } = await import('../dist/routes/task-discussion-thread.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

describe('F194 task discussion thread exactly-once link', () => {
  test('concurrent ensure calls converge on one durable task thread and one source copy', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom() {} };
    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 修复登录',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const task = await taskStore.upsertBySubject({
      threadId: parent.id,
      subjectKey: `work-intake:${parent.id}:${source.id}`,
      title: '修复登录',
      why: 'F194',
      createdBy: 'user',
      userId: 'alice',
      sourceMessageId: source.id,
    });

    const results = await Promise.all([
      ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager }),
      ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager }),
    ]);

    assert.equal(results[0].threadId, results[1].threadId);
    const linked = await taskStore.get(task.id);
    assert.equal(linked.taskThreadId, results[0].threadId);
    const copies = await messageStore.getByThread(results[0].threadId, 100);
    assert.equal(copies.length, 1);
    const activeThreads = (await threadStore.list('alice')).filter((thread) => !thread.deletedAt);
    assert.equal(activeThreads.length, 2, 'one parent + one task thread');
  });
});
