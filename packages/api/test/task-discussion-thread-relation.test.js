/**
 * [thread-task-design] §2 root cause 2 / §3 step 1.4: task-discussion threads
 * previously carried no `relation`, unlike manual branches (thread-branch.ts).
 * ensureTaskDiscussionThread must now stamp new task threads with the same
 * shape ({v, kind, parentThreadId, rootMessageId}) so the data model stays
 * consistent between manual and task-auto-admitted branches. Existing (already
 * persisted) task threads must NOT be retroactively migrated.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ensureTaskDiscussionThread } = await import('../dist/routes/task-discussion-thread.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

describe('F194 task discussion thread relation (root cause 2)', () => {
  test('newly created task thread carries a relation shaped like a manual branch', async () => {
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

    const discussion = await ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager });

    const taskThread = await threadStore.get(discussion.threadId);
    assert.ok(taskThread, 'task thread must exist');
    assert.deepEqual(taskThread.relation, {
      v: 1,
      kind: 'task_thread',
      parentThreadId: parent.id,
      rootMessageId: source.id,
    });
  });

  test('already-existing task thread (no relation) is not migrated on re-fetch', async () => {
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

    // Simulate a pre-existing task thread created before this fix — no relation.
    const legacyTaskThread = await threadStore.create('alice', '修复登录 (分支)', parent.projectPath);
    await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 修复登录',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: legacyTaskThread.id,
    });
    const task = await taskStore.upsertBySubject({
      threadId: parent.id,
      subjectKey: `work-intake:${parent.id}:${source.id}`,
      title: '修复登录',
      why: 'F194',
      createdBy: 'user',
      userId: 'alice',
      sourceMessageId: source.id,
      taskThreadId: legacyTaskThread.id,
    });

    const discussion = await ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager });

    assert.equal(discussion.threadId, legacyTaskThread.id, 'must reuse the existing thread, not create a new one');
    const refetched = await threadStore.get(legacyTaskThread.id);
    assert.equal(refetched.relation, undefined, 'pre-existing branch threads must not be retroactively migrated');
  });

  test('task without a resolvable sourceMessageId still gets a well-formed relation (no crash)', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom() {} };
    const parent = await threadStore.create('alice', '大厅');
    const task = await taskStore.upsertBySubject({
      threadId: parent.id,
      subjectKey: null,
      title: '手动创建的任务',
      why: '',
      createdBy: 'user',
      userId: 'alice',
      // no sourceMessageId — e.g. created via POST /api/tasks directly
    });

    const discussion = await ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager });
    const taskThread = await threadStore.get(discussion.threadId);

    assert.equal(taskThread.relation.v, 1);
    assert.equal(taskThread.relation.kind, 'task_thread');
    assert.equal(taskThread.relation.parentThreadId, parent.id);
    assert.equal(typeof taskThread.relation.rootMessageId, 'string');
    assert.ok(taskThread.relation.rootMessageId.length > 0);
  });
});
