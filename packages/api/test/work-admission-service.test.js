import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { canViewMessage } = await import('../dist/domains/cats/services/stores/visibility.js');
const { deriveThreadReplySummary } = await import('../dist/routes/thread-reply-summary.js');
const { admitWorkMessage, isAutoTaskThreadRoutingEnabled } = await import('../dist/routes/work-admission-service.js');

describe('F194 work admission service', () => {
  test('rollout remains off by default and supports an explicit thread canary', () => {
    assert.equal(isAutoTaskThreadRoutingEnabled('thread-1', {}), false);
    assert.equal(isAutoTaskThreadRoutingEnabled('thread-1', { CLOWDER_AUTO_TASK_THREAD_THREADS: 'thread-1' }), true);
    assert.equal(isAutoTaskThreadRoutingEnabled('thread-2', { CLOWDER_AUTO_TASK_THREAD_ROUTING: 'true' }), true);
  });

  test('concurrent admission creates one claimed task/thread and one claim ledger', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const socketManager = { broadcastToRoom: (...args) => events.push(args) };
    const parent = await threadStore.create('alice', '大厅');
    const sourceMessage = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 修复登录超时',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const deps = { taskStore, threadStore, messageStore, socketManager };
    const input = {
      decision: {
        kind: 'create_from_message',
        taskTitle: '修复登录超时',
        ownerCatId: 'opus',
        reason: 'line_leading_mention_action',
      },
      sourceMessage,
      userId: 'alice',
      deps,
    };

    const [first, second] = await Promise.all([admitWorkMessage(input), admitWorkMessage(input)]);

    assert.equal(first.task.id, second.task.id);
    assert.equal(first.route.replyTargetThreadId, second.route.replyTargetThreadId);
    assert.equal(first.task.ownerCatId, 'opus');
    assert.equal(first.task.status, 'doing');
    assert.equal(first.task.events.filter((event) => event.type === 'claimed').length, 1);
    assert.equal(first.task.events.filter((event) => event.type === 'status_changed').length, 1);
    assert.equal(events.filter(([, name]) => name === 'task_created').length, 1);
    assert.equal(events.filter(([, name]) => name === 'thread_branched').length, 1);
    const tasks = await taskStore.listByThread(parent.id);
    assert.equal(tasks.length, 1);
  });

  test('unrevealed whisper admission keeps the source private without copying its body into task metadata', async () => {
    const taskStore = new TaskStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const events = [];
    const socketManager = { broadcastToRoom: (...args) => events.push(args) };
    const parent = await threadStore.create('alice', '大厅');
    const secret = 'SECRET_F194_NEVER_IN_TASK_TITLE';
    const sourceMessage = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: `@opus 修复 ${secret}`,
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    const result = await admitWorkMessage({
      decision: {
        kind: 'create_from_message',
        taskTitle: `修复 ${secret}`,
        ownerCatId: 'opus',
        reason: 'line_leading_mention_action',
      },
      sourceMessage,
      userId: 'alice',
      deps: { taskStore, threadStore, messageStore, socketManager },
    });

    assert.equal(result.task.title, '私密工作指令');
    assert.equal(result.task.title.includes(secret), false);
    const taskThread = await threadStore.get(result.route.replyTargetThreadId);
    assert.ok(taskThread);
    const taskThreadMessages = await messageStore.getByThread(result.route.replyTargetThreadId, 10);
    const copied = taskThreadMessages.find((message) => message.id === result.route.executionMessageId);
    assert.ok(copied);
    assert.equal(copied.content.includes(secret), true, 'recipient source copy must retain the original body');
    assert.equal(copied.visibility, 'whisper');
    assert.deepEqual(copied.whisperTo, ['opus']);

    const nonRecipient = { type: 'cat', catId: 'codex' };
    const recipient = { type: 'cat', catId: 'opus' };
    const folded = deriveThreadReplySummary(sourceMessage, taskThreadMessages, nonRecipient);
    const derivedSurfaces = {
      task: result.task,
      taskThread,
      folded,
      broadcasts: events,
    };
    assert.equal(JSON.stringify(derivedSurfaces).includes(secret), false);

    const parentMessages = await messageStore.getByThread(parent.id, 10);
    const secretBearingMessages = [...parentMessages, ...taskThreadMessages].filter((message) =>
      message.content.includes(secret),
    );
    assert.equal(
      secretBearingMessages.length,
      2,
      'only the parent source and protected task-thread copy may retain it',
    );
    for (const message of secretBearingMessages) {
      assert.equal(canViewMessage(message, nonRecipient), false);
      assert.equal(canViewMessage(message, recipient), true);
    }
  });
});
