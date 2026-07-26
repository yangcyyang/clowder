/**
 * ReviewReminderScheduler tests (批次4-B2 分轨超时提醒)
 *
 * Uses in-memory fakes (no real Redis), mirroring test/claimed-idle-scheduler.test.js's
 * style exactly (same author, same batch). The isolated-Redis persistence counterpart lives
 * in test/review-reminder-scheduler.redis.test.js (C1 lesson: default-on automation's
 * guardrail must be verified on the real storage path, not just in-memory).
 *
 * IMPORTANT: depends on the real `catRegistry` singleton populated by
 * test/helpers/setup-cat-registry.js. 'opus'/'gpt52' are registered cats from
 * cat-template.json.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const OWNER = 'opus';
const GATE_REVIEWER = 'gpt52';

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

  async update(taskId, input) {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
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
    title: '待验收功能',
    ownerCatId: OWNER,
    status: 'in_review',
    why: 'test',
    createdBy: OWNER,
    createdAt: now,
    updatedAt: now,
    userId: 'user-1',
    events: [{ ts: new Date(now).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } }],
    ...overrides,
  };
}

function createFakeInvocationQueue(opts = {}) {
  const enqueued = [];
  const persisted = [];
  return {
    enqueued,
    persisted,
    hasActiveIdempotencyKey: opts.hasActiveIdempotencyKey ?? (() => false),
    enqueue(input) {
      const entry = { id: `entry-${enqueued.length + 1}`, ...input };
      enqueued.push(entry);
      return { outcome: 'enqueued', entry, deduped: false, queuePosition: enqueued.length };
    },
    async persistEntry(entry) {
      persisted.push(entry);
    },
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
  return { broadcasts, broadcastToRoom: (room, event, payload) => broadcasts.push({ room, event, payload }) };
}

function createFakeQueueProcessor() {
  const calls = [];
  return { calls, async tryAutoExecute(threadId) { calls.push(threadId); } };
}

describe('ReviewReminderScheduler', () => {
  /** @type {typeof import('../dist/domains/cats/services/agents/invocation/ReviewReminderScheduler.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/agents/invocation/ReviewReminderScheduler.js');
    assert.ok(mod.ReviewReminderScheduler);
    assert.ok(mod.isReviewReminderSchedulerEnabled);
  });

  describe('threshold resolvers (fail-open on typos)', () => {
    test('defaults', () => {
      assert.equal(mod.resolveGateReminderHours({}), 24);
      assert.equal(mod.resolveHumanLevel1Hours({}), 48);
      assert.equal(mod.resolveHumanLevel2Hours({}), 96);
      assert.equal(mod.resolveHumanLevel3Days({}), 10);
    });
    test('custom positive values honored', () => {
      assert.equal(mod.resolveGateReminderHours({ CLOWDER_REVIEW_REMINDER_GATE_HOURS: '12' }), 12);
    });
    test('non-numeric/zero/negative falls back to default', () => {
      assert.equal(mod.resolveGateReminderHours({ CLOWDER_REVIEW_REMINDER_GATE_HOURS: 'abc' }), 24);
      assert.equal(mod.resolveHumanLevel1Hours({ CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL1_HOURS: '0' }), 48);
      assert.equal(mod.resolveHumanLevel3Days({ CLOWDER_REVIEW_REMINDER_HUMAN_LEVEL3_DAYS: '-3' }), 10);
    });
  });

  describe('isReviewReminderSchedulerEnabled', () => {
    test('true when unset (default ON)', () => assert.equal(mod.isReviewReminderSchedulerEnabled({}), true));
    test('false for "0"/"false"', () => {
      assert.equal(mod.isReviewReminderSchedulerEnabled({ CLOWDER_REVIEW_REMINDER_SCHEDULER: '0' }), false);
      assert.equal(mod.isReviewReminderSchedulerEnabled({ CLOWDER_REVIEW_REMINDER_SCHEDULER: 'false' }), false);
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
      return new mod.ReviewReminderScheduler({
        taskStore: store,
        messageStore: overrides.messageStore ?? createFakeMessageStore(),
        socketManager: overrides.socketManager ?? createFakeSocketManager(),
        invocationQueue: overrides.invocationQueue ?? createFakeInvocationQueue(),
        queueProcessor: overrides.queueProcessor ?? createFakeQueueProcessor(),
        env: overrides.env ?? {},
        now: overrides.now ?? (() => nowRef),
      });
    }

    // ── track selection ──

    test('status != in_review → completely skipped', async () => {
      for (const status of ['todo', 'doing', 'blocked', 'done', 'failed']) {
        store = new FakeTaskStore();
        const task = makeTask({ status, updatedAt: nowRef - 100 * 3600_000 });
        store.seed(task);
        const invocationQueue = createFakeInvocationQueue();
        const scheduler = makeScheduler({ invocationQueue });
        await scheduler.tick();
        assert.equal(invocationQueue.enqueued.length, 0, `status=${status} must not trigger any reminder`);
      }
    });

    // ── gate 轨 ──

    test('gate 轨: under 24h threshold → no reminder', async () => {
      const task = makeTask({
        reviewerId: GATE_REVIEWER,
        events: [{ ts: new Date(nowRef - 10 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      await makeScheduler({ invocationQueue }).tick();
      assert.equal(invocationQueue.enqueued.length, 0);
    });

    test('gate 轨: past 24h threshold → private reminder enqueued to the reviewer cat, once', async () => {
      const task = makeTask({
        reviewerId: GATE_REVIEWER,
        events: [{ ts: new Date(nowRef - 25 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const queueProcessor = createFakeQueueProcessor();
      await makeScheduler({ invocationQueue, queueProcessor }).tick();

      assert.equal(invocationQueue.enqueued.length, 1);
      const entry = invocationQueue.enqueued[0];
      assert.deepEqual(entry.targetCats, [GATE_REVIEWER]);
      assert.equal(entry.sourceCategory, 'gate_review_reminder');
      assert.equal(entry.idempotencyKey, `review-reminder:${task.id}:gate:1`);
      assert.deepEqual(queueProcessor.calls, ['thread-work']);

      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'review_reminder_sent').length, 1);
    });

    test('gate 轨: already reminded → second tick does not re-fire', async () => {
      const task = makeTask({
        reviewerId: GATE_REVIEWER,
        events: [
          { ts: new Date(nowRef - 30 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } },
          { ts: new Date(nowRef - 26 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'gate', level: 1 } },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      await makeScheduler({ invocationQueue }).tick();
      assert.equal(invocationQueue.enqueued.length, 0, 'gate 轨只有一级，已提醒过就不再触发');
    });

    test('gate 轨: no further escalation defined — even far past threshold, still just the one reminder', async () => {
      const task = makeTask({
        reviewerId: GATE_REVIEWER,
        events: [
          { ts: new Date(nowRef - 500 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } },
          { ts: new Date(nowRef - 400 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'gate', level: 1 } },
        ],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      await makeScheduler({ invocationQueue, messageStore }).tick();
      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(messageStore.messages.length, 0, 'gate 轨没有状态动作，不应该出现打回 doing 的通知');
      const updated = await store.get(task.id);
      assert.equal(updated.status, 'in_review', 'gate 轨从不自动打回状态');
    });

    // ── human 轨 ──

    test('human 轨 (reviewerId absent — legacy task): under 48h → nothing', async () => {
      const task = makeTask({ reviewerId: undefined, events: [{ ts: new Date(nowRef - 10 * 3600_000).toISOString(), catId: 'system', type: 'status_changed', data: { from: 'doing', to: 'in_review' } }] });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test("human 轨 (reviewerId='human'): past 48h → level-1 private reminder posted to the task's OWN discussion thread", async () => {
      const task = makeTask({
        reviewerId: 'human',
        events: [{ ts: new Date(nowRef - 50 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } }],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();

      assert.equal(messageStore.messages.length, 1);
      assert.equal(messageStore.messages[0].threadId, 'thread-work', 'level 1 私提醒应挂进任务自己的讨论 thread，不是主频道');
      assert.equal(messageStore.messages[0].extra?.systemKind, 'task_review_reminder');
      assert.match(messageStore.messages[0].content, /48 小时/);

      const updated = await store.get(task.id);
      const reminderEvent = updated.events.find((e) => e.type === 'review_reminder_sent');
      assert.ok(reminderEvent);
      assert.equal(reminderEvent.data.track, 'human');
      assert.equal(reminderEvent.data.level, 1);
    });

    test('human 轨: level-1 already sent, still under 96h → no re-fire, no level-2 yet', async () => {
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 60 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 55 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test('human 轨: past 96h → level-2 channel-visible reminder posted to the MAIN thread, mentioning the owner', async () => {
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 100 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 90 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();

      assert.equal(messageStore.messages.length, 1);
      assert.equal(messageStore.messages[0].threadId, 'thread-main', 'level 2 频道内可见应发到主 thread');
      assert.match(messageStore.messages[0].content, new RegExp(`@${OWNER}`));
      assert.match(messageStore.messages[0].content, /96 小时/);

      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'review_reminder_sent' && e.data.level === 2).length, 1);
    });

    test('human 轨: level-2 already sent → second tick within the same window does not re-fire', async () => {
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 100 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 90 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
          { ts: new Date(nowRef - 5 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 2 } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test('human 轨 level 3: past the terminal window (default 10 days) → state action, task reverted to doing', async () => {
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 11 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 10.5 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
          { ts: new Date(nowRef - 10.2 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 2 } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      const socketManager = createFakeSocketManager();
      await makeScheduler({ messageStore, socketManager }).tick();

      const updated = await store.get(task.id);
      assert.equal(updated.status, 'doing', '第三级必须是状态动作——强制打回 doing');
      assert.equal(updated.events.filter((e) => e.type === 'review_timeout_reverted').length, 1);
      assert.ok(messageStore.messages.some((m) => m.extra?.systemKind === 'task_review_timeout_reverted'));
      assert.ok(messageStore.messages.some((m) => /重新提交验收|明确弃票/.test(m.content)));
      assert.ok(socketManager.broadcasts.some((b) => b.event === 'task_updated'));
    });

    test('human 轨 level 3: idempotent — already reverted, second tick is inert (task no longer in_review)', async () => {
      const task = makeTask({
        status: 'doing', // already reverted by a prior tick
        events: [
          { ts: new Date(nowRef - 11 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 10 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_timeout_reverted', data: { track: 'human' } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0, 'status is no longer in_review — scheduler skips it entirely');
    });

    test('terminal marker present but status somehow still in_review (defensive) → scanner treats the cycle as closed, no double revert', async () => {
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 20 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 15 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_timeout_reverted', data: { track: 'human' } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test('re-entering in_review (rejected → resubmitted) gets a completely fresh reminder budget', async () => {
      const task = makeTask({
        events: [
          // old cycle: fully exhausted (reminders + revert)
          { ts: new Date(nowRef - 30 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
          { ts: new Date(nowRef - 29 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
          { ts: new Date(nowRef - 28 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 2 } },
          { ts: new Date(nowRef - 20 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_timeout_reverted', data: { track: 'human' } },
          // resubmitted — fresh cycle, only 10 hours old (under every threshold)
          { ts: new Date(nowRef - 10 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
        ],
      });
      store.seed(task);
      const messageStore = createFakeMessageStore();
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0, '新周期应该重新计时，不受旧周期已耗尽的提醒预算影响');
    });

    test('env off → tick() is a complete no-op for both tracks', async () => {
      const gateTask = makeTask({
        id: 'gate-task',
        reviewerId: GATE_REVIEWER,
        events: [{ ts: new Date(nowRef - 100 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
      });
      const humanTask = makeTask({
        id: 'human-task',
        events: [{ ts: new Date(nowRef - 300 * 24 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } }],
      });
      store.seed(gateTask);
      store.seed(humanTask);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      await makeScheduler({ invocationQueue, messageStore, env: { CLOWDER_REVIEW_REMINDER_SCHEDULER: '0' } }).tick();

      assert.equal(invocationQueue.enqueued.length, 0);
      assert.equal(messageStore.messages.length, 0);
    });

    test('idempotency guard: hasActiveIdempotencyKey already true → gate reminder skipped, no ledger event', async () => {
      const task = makeTask({
        reviewerId: GATE_REVIEWER,
        events: [{ ts: new Date(nowRef - 25 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
      });
      store.seed(task);
      const invocationQueue = createFakeInvocationQueue({ hasActiveIdempotencyKey: () => true });
      await makeScheduler({ invocationQueue }).tick();

      assert.equal(invocationQueue.enqueued.length, 0);
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).filter((e) => e.type === 'review_reminder_sent').length, 0);
    });

    test('multiple in_review tasks in one tick are each evaluated independently', async () => {
      const task1 = makeTask({
        id: 'task-1',
        reviewerId: GATE_REVIEWER,
        events: [{ ts: new Date(nowRef - 25 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
      });
      const task2 = makeTask({
        id: 'task-2',
        events: [{ ts: new Date(nowRef - 1 * 3600_000).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } }],
      });
      store.seed(task1);
      store.seed(task2);
      const invocationQueue = createFakeInvocationQueue();
      const messageStore = createFakeMessageStore();
      await makeScheduler({ invocationQueue, messageStore }).tick();

      assert.equal(invocationQueue.enqueued.length, 1, 'only task-1 (gate, past threshold) should fire');
      assert.equal(messageStore.messages.length, 0, 'task-2 is only 1h old — nowhere near level 1');
    });
  });
});
