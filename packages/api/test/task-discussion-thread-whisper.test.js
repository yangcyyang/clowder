/**
 * #404 whisper 钉：toTaskThreadMessage() 必须保留 visibility/whisperTo/revealedAt，
 * 否则任务卡（前端消费 sourceMessage）无法判断真实来源消息是不是 whisper，
 * 一条经 whisper 发送、被 F194 自动收纳成任务的指令就会"看起来是公开的"。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ensureTaskDiscussionThread, toTaskThreadMessage } = await import('../dist/routes/task-discussion-thread.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

describe('#404 whisper: toTaskThreadMessage preserves visibility metadata', () => {
  test('a whisper message keeps visibility + whisperTo through toTaskThreadMessage()', async () => {
    const messageStore = new MessageStore();
    const stored = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 悄悄改一下密钥轮换脚本',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    const copy = toTaskThreadMessage(stored);
    assert.equal(copy.visibility, 'whisper');
    assert.deepEqual(copy.whisperTo, ['opus']);
    assert.equal(copy.revealedAt, undefined);
  });

  test('a public message has no visibility field (undefined, not "public")', async () => {
    const messageStore = new MessageStore();
    const stored = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '帮我修复登录',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    const copy = toTaskThreadMessage(stored);
    assert.equal(copy.visibility, undefined);
    assert.equal(copy.whisperTo, undefined);
  });

  test('ensureTaskDiscussionThread (new task thread path): whisper source message → sourceMessage returned to caller carries whisper metadata', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom() {} };
    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 悄悄修复登录漏洞',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const task = await taskStore.upsertBySubject({
      threadId: parent.id,
      subjectKey: `work-intake:${parent.id}:${source.id}`,
      title: '修复登录漏洞',
      why: 'F194',
      createdBy: 'user',
      userId: 'alice',
      sourceMessageId: source.id,
    });

    const result = await ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager });

    assert.equal(result.sourceMessage.visibility, 'whisper');
    assert.deepEqual(result.sourceMessage.whisperTo, ['opus']);
  });

  test('ensureTaskDiscussionThread (existing task thread path): re-fetching an already-linked whisper task thread still preserves whisper metadata', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom() {} };
    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 悄悄修复登录漏洞',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const task = await taskStore.upsertBySubject({
      threadId: parent.id,
      subjectKey: `work-intake:${parent.id}:${source.id}`,
      title: '修复登录漏洞',
      why: 'F194',
      createdBy: 'user',
      userId: 'alice',
      sourceMessageId: source.id,
    });

    // First call creates the task thread + copies the whisper source message into it.
    const first = await ensureTaskDiscussionThread(task, { taskStore, threadStore, messageStore, socketManager });
    const relinkedTask = await taskStore.get(task.id);

    // Second call hits the "already has taskThreadId" read path (line 57-65) —
    // this is exactly the path that was stripping visibility before the fix.
    const second = await ensureTaskDiscussionThread(relinkedTask, {
      taskStore,
      threadStore,
      messageStore,
      socketManager,
    });

    assert.equal(second.threadId, first.threadId);
    assert.equal(second.sourceMessage.visibility, 'whisper', 'existing-thread read path must preserve visibility');
    assert.deepEqual(second.sourceMessage.whisperTo, ['opus']);
  });
});
