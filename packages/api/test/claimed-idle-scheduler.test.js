/**
 * ClaimedIdleScheduler tests (认领闲置唤醒器)
 *
 * Uses in-memory fakes (no real Redis), mirroring the style of
 * test/auto-retry-scheduler.test.js.
 *
 * IMPORTANT: this suite depends on the real `catRegistry` singleton being
 * populated by test/helpers/setup-cat-registry.js (loaded via --import), the
 * same convention every other scheduler test in this package relies on.
 * 'opus' is one of the cats registered from cat-template.json.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const OWNER = 'opus';
const OTHER_OWNER = 'gpt52';

// ── Fakes ──

class FakeTaskStore {
  tasks = new Map();

  seed(task) {
    this.tasks.set(task.id, { events: [], kind: 'work', ...task });
  }

  async listByKind(kind) {
    return [...this.tasks.values()].filter((t) => (t.kind ?? 'work') === kind).map((t) => ({ ...t }));
  }

  async listByThread(threadId) {
    return [...this.tasks.values()]
      .filter((t) => t.threadId === threadId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({ ...t }));
  }

  async get(taskId) {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  /** Mirrors real TaskStore.update()'s event-append + updatedAt-bump semantics (the only two things ClaimedIdleScheduler relies on). */
  async update(taskId, input) {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.ownerCatId !== undefined ? { ownerCatId: input.ownerCatId } : {}),
      events: [...(existing.events ?? []), ...(input.events ?? [])],
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }
}

function makeTask(overrides = {}) {
  const now = Date.now();
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'work',
    threadId: 'thread-main',
    taskThreadId: 'thread-work',
    subjectKey: null,
    title: '实现某功能',
    ownerCatId: OWNER,
    status: 'doing',
    why: 'test',
    createdBy: 'user',
    createdAt: now,
    updatedAt: now,
    userId: 'user-1',
    events: [{ ts: new Date(now).toISOString(), catId: OWNER, type: 'claimed', data: { from: null, to: OWNER } }],
    ...overrides,
  };
}

function createFakeInvocationQueue(opts = {}) {
  const enqueued = [];
  const persisted = [];
  return {
    enqueued,
    persisted,
    hasQueuedOrProcessingForCat: opts.hasQueuedOrProcessingForCat ?? (() => false),
    hasActiveIdempotencyKey: opts.hasActiveIdempotencyKey ?? (() => false),
    enqueue(input) {
      const entry = {
        id: `entry-${enqueued.length + 1}`,
        status: 'queued',
        createdAt: Date.now(),
        mergedMessageIds: [],
        messageId: null,
        priority: 'normal',
        ...input,
      };
      enqueued.push(entry);
      return { outcome: 'enqueued', entry, queuePosition: enqueued.length };
    },
    async persistEntry(entry) {
      persisted.push(entry);
    },
  };
}

function createFakeInvocationTracker(activeKeys = new Set()) {
  return {
    activeKeys,
    has: (threadId, catId) => activeKeys.has(`${threadId}:${catId}`),
  };
}

function createFakeMessageStore() {
  const messages = [];
  return {
    messages,
    async append(msg) {
      const stored = { id: `msg-${messages.length + 1}`, ...msg };
      messages.push(stored);
      return stored;
    },
  };
}

function createFakeSocketManager() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToRoom(room, event, payload) {
      broadcasts.push({ room, event, payload });
    },
  };
}

function createFakeQueueProcessor() {
  const calls = [];
  return {
    calls,
    async tryAutoExecute(threadId) {
      calls.push(threadId);
    },
  };
}

describe('ClaimedIdleScheduler', () => {
  /** @type {typeof import('../dist/domains/cats/services/agents/invocation/ClaimedIdleScheduler.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/agents/invocation/ClaimedIdleScheduler.js');
    assert.ok(mod.ClaimedIdleScheduler);
    assert.ok(mod.isClaimedIdleWakeupEnabled);
    assert.ok(mod.resolveClaimedIdleThresholdMinutes);
    assert.equal(mod.MAX_CLAIMED_IDLE_NUDGES, 2);
  });

  describe('isClaimedIdleWakeupEnabled', () => {
    test('true when unset (default ON)', () => {
      assert.equal(mod.isClaimedIdleWakeupEnabled({}), true);
    });
    test('false for "0"', () => {
      assert.equal(mod.isClaimedIdleWakeupEnabled({ CLOWDER_CLAIMED_IDLE_WAKEUP: '0' }), false);
    });
    test('false for "false" (case-insensitive)', () => {
      assert.equal(mod.isClaimedIdleWakeupEnabled({ CLOWDER_CLAIMED_IDLE_WAKEUP: 'FALSE' }), false);
    });
    test('true for arbitrary other values', () => {
      assert.equal(mod.isClaimedIdleWakeupEnabled({ CLOWDER_CLAIMED_IDLE_WAKEUP: 'true' }), true);
      assert.equal(mod.isClaimedIdleWakeupEnabled({ CLOWDER_CLAIMED_IDLE_WAKEUP: 'yes' }), true);
    });
  });

  describe('resolveClaimedIdleThresholdMinutes', () => {
    test('default 15 when unset', () => {
      assert.equal(mod.resolveClaimedIdleThresholdMinutes({}), 15);
    });
    test('custom positive value', () => {
      assert.equal(mod.resolveClaimedIdleThresholdMinutes({ CLOWDER_CLAIMED_IDLE_MINUTES: '30' }), 30);
    });
    test('non-numeric falls back to default', () => {
      assert.equal(mod.resolveClaimedIdleThresholdMinutes({ CLOWDER_CLAIMED_IDLE_MINUTES: 'abc' }), 15);
    });
    test('zero/negative falls back to default', () => {
      assert.equal(mod.resolveClaimedIdleThresholdMinutes({ CLOWDER_CLAIMED_IDLE_MINUTES: '0' }), 15);
      assert.equal(mod.resolveClaimedIdleThresholdMinutes({ CLOWDER_CLAIMED_IDLE_MINUTES: '-5' }), 15);
    });
  });

  describe('tick() decision logic', () => {
    let store;
    let nowRef;

    beforeEach(() => {
      store = new FakeTaskStore();
      nowRef = Date.now();
    });

    function makeScheduler(overrides = {}) {
      return new mod.ClaimedIdleScheduler({
        taskStore: store,
        messageStore: overrides.messageStore ?? createFakeMessageStore(),
        socketManager: overrides.socketManager ?? createFakeSocketManager(),
        invocationQueue: overrides.invocationQueue ?? createFakeInvocationQueue(),
        invocationTracker: overrides.invocationTracker ?? createFakeInvocationTracker(),
        queueProcessor: overrides.queueProcessor ?? createFakeQueueProcessor(),
        env: overrides.env ?? {},
        now: overrides.now ?? (() => nowRef),
      });
    }

    // ── ① idle determination ──

    test('doing + no active execution + past idle threshold → nudge sent', async () => {
      const task = makeTask({
        updatedAt: nowRef - 20 * 60_000,
        events: [{ ts: new Date(nowRef - 20 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} }],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'idle_nudged').length, 1);
    });

    test('active invocation (InvocationTracker.has) → no nudge', async () => {
      const task = makeTask({ updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const tracker = createFakeInvocationTracker(new Set([`thread-work:${OWNER}`]));
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationTracker: tracker, invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
    });

    test('queued/processing entry for owner (InvocationQueue.hasQueuedOrProcessingForCat) → no nudge', async () => {
      const task = makeTask({ updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue({ hasQueuedOrProcessingForCat: () => true });
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
    });

    test('idle but under the threshold → no nudge', async () => {
      const task = makeTask({ updatedAt: nowRef - 5 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
    });

    for (const status of ['todo', 'in_review', 'done', 'blocked', 'failed']) {
      test(`status=${status} (not 'doing') → no action even if idle+owned`, async () => {
        const task = makeTask({ status, updatedAt: nowRef - 60 * 60_000 });
        store.seed(task);
        const invocationQueue = createFakeInvocationQueue();
        const scheduler = makeScheduler({ invocationQueue });
        await scheduler.tick();

        assert.equal(invocationQueue.enqueued.length, 0);
      });
    }

    test('no ownerCatId → no action', async () => {
      const task = makeTask({ ownerCatId: null, updatedAt: nowRef - 60 * 60_000, events: [] });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
    });

    test('owner not a registered cat → no action', async () => {
      const task = makeTask({ ownerCatId: 'not-a-real-cat-xyz', updatedAt: nowRef - 60 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
    });

    test('falls back to task.threadId when taskThreadId is absent', async () => {
      const task = makeTask({ taskThreadId: undefined, updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      assert.equal(invocationQueue.enqueued[0].threadId, 'thread-main');
    });

    // ── ② idempotency & guardrails ──

    test('idempotency: hasActiveIdempotencyKey already true → skipped, no ledger event added', async () => {
      const task = makeTask({ updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue({ hasActiveIdempotencyKey: () => true });
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).filter((e) => e.type === 'idle_nudged').length, 0);
    });

    test('second scan right after a nudge does not re-nudge (updatedAt was just bumped)', async () => {
      const task = makeTask({ updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();
      assert.equal(invocationQueue.enqueued.length, 1);

      await scheduler.tick(); // same `now`, task.updatedAt just bumped by the nudge
      assert.equal(invocationQueue.enqueued.length, 1, 'must not double-nudge on an immediate re-scan');
    });

    test('30-minute minimum interval enforced even when the 15-minute idle threshold alone would pass', async () => {
      // updatedAt was bumped 16 minutes ago by something unrelated (passes the 15min idle
      // threshold), but the last real nudge was only 20 minutes ago (fails the 30min floor).
      const task = makeTask({
        updatedAt: nowRef - 16 * 60_000,
        events: [
          { ts: new Date(nowRef - 60 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} },
          { ts: new Date(nowRef - 20 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 1 } },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0, 'must wait the full 30 minutes since the last nudge');
    });

    test('30-minute interval satisfied → second nudge fires with nudgeNumber 2', async () => {
      const task = makeTask({
        updatedAt: nowRef - 40 * 60_000,
        events: [
          { ts: new Date(nowRef - 60 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} },
          { ts: new Date(nowRef - 40 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 1 } },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      assert.equal(invocationQueue.enqueued[0].idempotencyKey, `claimed-idle:${task.id}:2`);
    });

    test('cap: 2 nudges already used, still idle → escalate instead of a 3rd nudge', async () => {
      const task = makeTask({
        updatedAt: nowRef - 60 * 60_000,
        events: [
          { ts: new Date(nowRef - 120 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} },
          { ts: new Date(nowRef - 100 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 1 } },
          { ts: new Date(nowRef - 60 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 2 } },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      const socketManager = createFakeSocketManager();
      const scheduler = makeScheduler({ invocationQueue, messageStore, socketManager });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0, 'must not spawn a cat once the cap is exhausted');
      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'task_idle_escalated').length, 1);
      assert.equal(messageStore.messages.length, 1);
      assert.match(messageStore.messages[0].content, /两次提醒无进展/);
      assert.equal(messageStore.messages[0].threadId, 'thread-main', 'escalation notice goes to the MAIN thread, not the work thread');
      assert.equal(messageStore.messages[0].extra?.systemKind, 'task_idle_escalated');
    });

    test('already escalated → completely inert on subsequent ticks', async () => {
      const task = makeTask({
        updatedAt: nowRef - 60 * 60_000,
        events: [
          { ts: new Date(nowRef - 120 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} },
          { ts: new Date(nowRef - 100 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 1 } },
          { ts: new Date(nowRef - 90 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 2 } },
          { ts: new Date(nowRef - 70 * 60_000).toISOString(), catId: 'system', type: 'task_idle_escalated', data: {} },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      const scheduler = makeScheduler({ invocationQueue, messageStore });
      const eventsBefore = task.events.length;

      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal(updated.events.length, eventsBefore, 'no new ledger events once escalated');
    });

    test('re-claim after escalation resets the nudge budget for the new claim cycle', async () => {
      const task = makeTask({
        ownerCatId: OTHER_OWNER,
        updatedAt: nowRef - 20 * 60_000,
        events: [
          { ts: new Date(nowRef - 300 * 60_000).toISOString(), catId: OWNER, type: 'claimed', data: {} },
          { ts: new Date(nowRef - 280 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 1 } },
          { ts: new Date(nowRef - 260 * 60_000).toISOString(), catId: 'system', type: 'idle_nudged', data: { nudgeNumber: 2 } },
          { ts: new Date(nowRef - 240 * 60_000).toISOString(), catId: 'system', type: 'task_idle_escalated', data: {} },
          { ts: new Date(nowRef - 200 * 60_000).toISOString(), catId: OWNER, type: 'unclaimed', data: {} },
          // fresh claim by a different cat, AFTER the old escalation
          { ts: new Date(nowRef - 20 * 60_000).toISOString(), catId: OTHER_OWNER, type: 'claimed', data: {} },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1, 'the new claim cycle must get a fresh nudge budget');
      assert.equal(invocationQueue.enqueued[0].idempotencyKey, `claimed-idle:${task.id}:1`);
      assert.equal(invocationQueue.enqueued[0].targetCats[0], OTHER_OWNER);
    });

    // ── ③ env off → zero action ──

    test('CLOWDER_CLAIMED_IDLE_WAKEUP=0 → tick() is a complete no-op', async () => {
      const task = makeTask({ updatedAt: nowRef - 60 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      const scheduler = makeScheduler({ invocationQueue, messageStore, env: { CLOWDER_CLAIMED_IDLE_WAKEUP: '0' } });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal(updated.events.length, task.events.length);
    });

    // ── ④ enqueued entry field correctness ──

    test('enqueued nudge entry carries the expected fields', async () => {
      const task = makeTask({ updatedAt: nowRef - 20 * 60_000 });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const queueProcessor = createFakeQueueProcessor();
      const scheduler = makeScheduler({ invocationQueue, queueProcessor });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      const entry = invocationQueue.enqueued[0];
      assert.deepEqual(entry.targetCats, [OWNER]);
      assert.equal(entry.threadId, 'thread-work');
      assert.equal(entry.sourceCategory, 'claimed_idle_nudge');
      assert.equal(entry.idempotencyKey, `claimed-idle:${task.id}:1`);
      assert.equal(entry.source, 'agent');
      assert.equal(entry.intent, 'execute');
      assert.equal(entry.autoExecute, true);
      assert.ok(entry.expiresAt > nowRef);
      assert.match(entry.content, /已闲置 \d+ 分钟/);
      assert.match(entry.content, /cat_cafe_task_update/);
      assert.match(entry.content, /cat_cafe_task_unclaim/);

      assert.equal(invocationQueue.persisted.length, 1);
      assert.equal(invocationQueue.persisted[0].id, entry.id);
      assert.deepEqual(queueProcessor.calls, ['thread-work']);
    });

    test('multiple idle tasks in one tick are each evaluated independently', async () => {
      const task1 = makeTask({ id: 'task-1', threadId: 'thread-a', taskThreadId: 'thread-a-work', updatedAt: nowRef - 20 * 60_000 });
      const task2 = makeTask({ id: 'task-2', threadId: 'thread-b', taskThreadId: 'thread-b-work', updatedAt: nowRef - 5 * 60_000 });
      store.seed(task1);
      store.seed(task2);
      const invocationQueue = createFakeInvocationQueue();
      const scheduler = makeScheduler({ invocationQueue });
      await scheduler.tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      assert.equal(invocationQueue.enqueued[0].threadId, 'thread-a-work');
    });
  });
});
