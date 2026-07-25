import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { canViewMessage } = await import('../dist/domains/cats/services/stores/visibility.js');
const { deriveThreadReplySummary } = await import('../dist/routes/thread-reply-summary.js');
const { admitWorkMessage, isAutoTaskThreadRoutingEnabled, isAutoClaimWakeupEnabled } = await import(
  '../dist/routes/work-admission-service.js'
);

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

  // ── [thread-task-design] §2 root cause 3: no unique @mention → no owner →
  // must not be a silent 202. A visible system notice lands in the main thread. ──
  describe('unclaimed task notice (F194 root cause 3)', () => {
    test('create_from_message without an owner cat posts a visible "待认领" notice to the main thread', async () => {
      const taskStore = new TaskStore();
      const threadStore = new ThreadStore();
      const messageStore = new MessageStore();
      const events = [];
      const socketManager = {
        broadcastToRoom: (...args) => events.push(args),
      };
      const parent = await threadStore.create('alice', '大厅');
      const sourceMessage = await messageStore.append({
        userId: 'alice',
        catId: null,
        content: '帮我做个书籍分析',
        mentions: [],
        timestamp: Date.now(),
        threadId: parent.id,
      });

      const result = await admitWorkMessage({
        decision: {
          kind: 'create_from_message',
          taskTitle: '书籍分析',
          reason: 'explicit_action',
          // no ownerCatId — no unique @mention target
        },
        sourceMessage,
        userId: 'alice',
        deps: { taskStore, threadStore, messageStore, socketManager },
      });

      assert.equal(result.route.ownerCatId, undefined, 'sanity: this is the no-owner path');

      const parentMessages = await messageStore.getByThread(parent.id, 20);
      const notice = parentMessages.find((m) => m.extra?.systemKind === 'task_created_unclaimed');
      assert.ok(notice, 'a system notice must be appended to the main thread, not just the task thread');
      assert.equal(notice.userId, 'system');
      assert.equal(notice.catId, null);
      assert.match(notice.content, /待认领/);
      assert.match(notice.content, /书籍分析/);
      assert.match(notice.content, /#1/, 'notice must reference the task by its #N label');

      const connectorEvents = events.filter(([, name]) => name === 'connector_message');
      assert.equal(connectorEvents.length, 1, 'notice must also be broadcast over the socket like other system notices');
      const [room, , payload] = connectorEvents[0];
      assert.equal(room, `thread:${parent.id}`);
      assert.equal(payload.message.content, notice.content);
      assert.equal(payload.threadId, parent.id);
    });

    test('create_from_message WITH an owner cat does not post the unclaimed notice', async () => {
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

      await admitWorkMessage({
        decision: {
          kind: 'create_from_message',
          taskTitle: '修复登录超时',
          ownerCatId: 'opus',
          reason: 'line_leading_mention_action',
        },
        sourceMessage,
        userId: 'alice',
        deps: { taskStore, threadStore, messageStore, socketManager },
      });

      const parentMessages = await messageStore.getByThread(parent.id, 20);
      const notice = parentMessages.find((m) => m.extra?.systemKind === 'task_created_unclaimed');
      assert.equal(notice, undefined, 'an owned task must not get the unclaimed notice');
    });

    test('concurrent admission without an owner posts exactly one unclaimed notice', async () => {
      const taskStore = new TaskStore();
      const threadStore = new ThreadStore();
      const messageStore = new MessageStore();
      const events = [];
      const socketManager = { broadcastToRoom: (...args) => events.push(args) };
      const parent = await threadStore.create('alice', '大厅');
      const sourceMessage = await messageStore.append({
        userId: 'alice',
        catId: null,
        content: '帮我整理一下资料',
        mentions: [],
        timestamp: Date.now(),
        threadId: parent.id,
      });

      const input = {
        decision: { kind: 'create_from_message', taskTitle: '整理资料', reason: 'explicit_action' },
        sourceMessage,
        userId: 'alice',
        deps: { taskStore, threadStore, messageStore, socketManager },
      };

      await Promise.all([admitWorkMessage(input), admitWorkMessage(input)]);

      const parentMessages = await messageStore.getByThread(parent.id, 20);
      const notices = parentMessages.filter((m) => m.extra?.systemKind === 'task_created_unclaimed');
      assert.equal(notices.length, 1, 'concurrent duplicate admission must not double-post the notice');
    });
  });

  // ── F194 item 4 (batch 2-A): the owned-task counterpart — batch 1 only
  // covered the unowned case, leaving an owned auto-admitted task with zero
  // main-thread trace of its own creation (design doc §2 root cause 4). ──
  describe('owned task creation notice (F194 item 4)', () => {
    test('create_from_message WITH an owner cat posts a brief "已创建任务" one-liner to the main thread', async () => {
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

      await admitWorkMessage({
        decision: {
          kind: 'create_from_message',
          taskTitle: '修复登录超时',
          ownerCatId: 'opus',
          reason: 'line_leading_mention_action',
        },
        sourceMessage,
        userId: 'alice',
        deps: { taskStore, threadStore, messageStore, socketManager },
      });

      const parentMessages = await messageStore.getByThread(parent.id, 20);
      const notice = parentMessages.find((m) => m.extra?.systemKind === 'task_created');
      assert.ok(notice, 'an owned auto-admitted task must also leave a main-thread breadcrumb');
      assert.equal(notice.userId, 'system');
      assert.equal(notice.catId, null);
      assert.match(notice.content, /已创建任务/);
      assert.match(notice.content, /#1/);
      assert.match(notice.content, /opus/);

      const connectorEvents = events.filter(([, name]) => name === 'connector_message');
      assert.equal(connectorEvents.length, 1);
      const [room, , payload] = connectorEvents[0];
      assert.equal(room, `thread:${parent.id}`);
      assert.equal(payload.message.content, notice.content);
    });

    test('concurrent admission WITH an owner posts exactly one owned-creation notice', async () => {
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

      const input = {
        decision: {
          kind: 'create_from_message',
          taskTitle: '修复登录超时',
          ownerCatId: 'opus',
          reason: 'line_leading_mention_action',
        },
        sourceMessage,
        userId: 'alice',
        deps: { taskStore, threadStore, messageStore, socketManager },
      };

      await Promise.all([admitWorkMessage(input), admitWorkMessage(input)]);

      const parentMessages = await messageStore.getByThread(parent.id, 20);
      const notices = parentMessages.filter((m) => m.extra?.systemKind === 'task_created');
      assert.equal(notices.length, 1, 'concurrent duplicate admission must not double-post the owned notice either');
    });
  });

  describe('batch 3-A item 1: auto-claim wake-up for unowned tasks', () => {
    function fakeInvocationQueue() {
      const enqueued = [];
      const activeKeys = new Set();
      return {
        enqueued,
        hasActiveIdempotencyKey(_threadId, _userId, key) {
          return activeKeys.has(key);
        },
        enqueue(input) {
          if (activeKeys.has(input.idempotencyKey)) {
            return { outcome: 'enqueued', deduped: true };
          }
          activeKeys.add(input.idempotencyKey);
          const entry = { id: `entry-${enqueued.length + 1}`, ...input };
          enqueued.push(entry);
          return { outcome: 'enqueued', deduped: false, entry };
        },
        async persistEntry() {},
      };
    }

    function fakeQueueProcessor() {
      const calls = [];
      return {
        calls,
        async tryAutoExecute(threadId) {
          calls.push(threadId);
        },
      };
    }

    async function admitUnowned({ threadOptions, enableGate }) {
      const taskStore = new TaskStore();
      const threadStore = new ThreadStore();
      const messageStore = new MessageStore();
      const socketManager = { broadcastToRoom: () => {} };
      const parent = await threadStore.create('alice', '大厅');
      if (threadOptions?.participatingCats) {
        await threadStore.updateParticipatingCats(parent.id, threadOptions.participatingCats);
      }
      if (threadOptions?.preferredCats) {
        await threadStore.updatePreferredCats(parent.id, threadOptions.preferredCats);
      }
      const previousEnv = process.env.CLOWDER_AUTO_CLAIM_THREADS;
      // Exact-match allowlist gate: only the thread we just created (parent.id) is enabled
      // when enableGate is true — proves the gate is per-thread, not global.
      if (enableGate) process.env.CLOWDER_AUTO_CLAIM_THREADS = parent.id;
      else delete process.env.CLOWDER_AUTO_CLAIM_THREADS;
      try {
        const sourceMessage = await messageStore.append({
          userId: 'alice',
          catId: null,
          content: '帮我做个书籍分析',
          mentions: [],
          timestamp: Date.now(),
          threadId: parent.id,
        });
        const invocationQueue = fakeInvocationQueue();
        const queueProcessor = fakeQueueProcessor();
        const result = await admitWorkMessage({
          decision: { kind: 'create_from_message', taskTitle: '书籍分析', reason: 'as_task_explicit' },
          sourceMessage,
          userId: 'alice',
          deps: { taskStore, threadStore, messageStore, socketManager, invocationQueue, queueProcessor },
        });
        return { result, invocationQueue, queueProcessor, parent };
      } finally {
        if (previousEnv === undefined) delete process.env.CLOWDER_AUTO_CLAIM_THREADS;
        else process.env.CLOWDER_AUTO_CLAIM_THREADS = previousEnv;
      }
    }

    test('isAutoClaimWakeupEnabled defaults to off and respects an explicit thread allowlist', () => {
      assert.equal(isAutoClaimWakeupEnabled('thread-1', {}), false);
      assert.equal(isAutoClaimWakeupEnabled('thread-1', { CLOWDER_AUTO_CLAIM_THREADS: 'thread-2' }), false);
      assert.equal(
        isAutoClaimWakeupEnabled('thread-1', { CLOWDER_AUTO_CLAIM_THREADS: 'thread-2, thread-1' }),
        true,
      );
    });

    test('gate off (default): no wake-up entries even though invocationQueue is wired', async () => {
      const { invocationQueue, queueProcessor } = await admitUnowned({
        threadOptions: { participatingCats: ['opus', 'pi'] },
        enableGate: false,
      });
      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(queueProcessor.calls.length, 0);
    });

    test('gate on + participatingCats: enqueues one autoExecute entry per candidate and kicks tryAutoExecute', async () => {
      const { result, invocationQueue, queueProcessor, parent } = await admitUnowned({
        threadOptions: { participatingCats: ['opus', 'pi'] },
        enableGate: true,
      });

      assert.equal(invocationQueue.enqueued.length, 2);
      const targetCats = invocationQueue.enqueued.map((entry) => entry.targetCats[0]).sort();
      assert.deepEqual(targetCats, ['opus', 'pi']);
      for (const entry of invocationQueue.enqueued) {
        assert.equal(entry.autoExecute, true);
        assert.equal(entry.source, 'agent');
        assert.equal(entry.sourceCategory, 'auto_claim');
        assert.equal(entry.idempotencyKey, `auto-claim:${result.task.id}:${entry.targetCats[0]}`);
        assert.match(entry.content, /cat_cafe_task_claim/);
        assert.match(entry.content, new RegExp(result.task.id));
        assert.match(entry.content, /already_claimed/);
      }
      assert.deepEqual(queueProcessor.calls, [parent.id]);
    });

    test('gate on + only preferredCats (no participatingCats): falls back to preferredCats', async () => {
      const { invocationQueue } = await admitUnowned({
        threadOptions: { preferredCats: ['codex'] },
        enableGate: true,
      });
      assert.equal(invocationQueue.enqueued.length, 1);
      assert.equal(invocationQueue.enqueued[0].targetCats[0], 'codex');
    });

    test('gate on but no candidates on the thread: no wake-up entries', async () => {
      const { invocationQueue, queueProcessor } = await admitUnowned({
        threadOptions: {},
        enableGate: true,
      });
      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(queueProcessor.calls.length, 0);
    });

    test('candidate cap: more than 3 participatingCats still only wakes up 3', async () => {
      const { invocationQueue } = await admitUnowned({
        threadOptions: { participatingCats: ['opus', 'pi', 'codex', 'gemini'] },
        enableGate: true,
      });
      assert.equal(invocationQueue.enqueued.length, 3);
    });
  });
});
