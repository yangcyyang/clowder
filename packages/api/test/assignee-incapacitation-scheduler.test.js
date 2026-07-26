/**
 * AssigneeIncapacitationScheduler tests (批次4-B3 失能打标)
 *
 * Uses in-memory fakes (no real Redis), mirroring test/claimed-idle-scheduler.test.js's
 * style. Isolated-Redis persistence counterpart:
 * test/assignee-incapacitation-scheduler.redis.test.js.
 *
 * IMPORTANT: depends on the real `catRegistry` singleton populated by
 * test/helpers/setup-cat-registry.js. 'opus'/'gpt52' are registered cats.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const OWNER = 'opus';
const OTHER_OWNER = 'gpt52';

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
    const updated = { ...existing, events: [...(existing.events ?? []), ...(input.events ?? [])], updatedAt: Date.now() };
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
    subjectKey: null,
    title: '进行中的功能',
    ownerCatId: OWNER,
    status: 'doing',
    why: 'test',
    createdBy: OWNER,
    createdAt: now,
    updatedAt: now,
    userId: 'user-1',
    events: [],
    ...overrides,
  };
}

function createFakeMessageStore() {
  const messages = [];
  return { messages, async append(msg) { const stored = { id: `msg-${messages.length + 1}`, ...msg }; messages.push(stored); return stored; } };
}

function createFakeSocketManager() {
  const broadcasts = [];
  const userEmits = [];
  return {
    broadcasts,
    userEmits,
    broadcastToRoom(room, event, payload) { broadcasts.push({ room, event, payload }); },
    emitToUser(userId, event, data) { userEmits.push({ userId, event, data }); },
  };
}

function fakeTracker(signals = {}) {
  return { getSignal: (catId) => signals[catId] };
}

describe('AssigneeIncapacitationScheduler', () => {
  /** @type {typeof import('../dist/domains/cats/services/agents/invocation/AssigneeIncapacitationScheduler.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/agents/invocation/AssigneeIncapacitationScheduler.js');
    assert.ok(mod.AssigneeIncapacitationScheduler);
    assert.ok(mod.isAssigneeIncapacitationTaggingEnabled);
    assert.ok(mod.resolveIncapacitationThresholdMinutes);
  });

  describe('env/threshold resolvers', () => {
    test('enabled by default', () => assert.equal(mod.isAssigneeIncapacitationTaggingEnabled({}), true));
    test('disabled by "0"/"false"', () => {
      assert.equal(mod.isAssigneeIncapacitationTaggingEnabled({ CLOWDER_ASSIGNEE_INCAPACITATION_TAGGING: '0' }), false);
      assert.equal(mod.isAssigneeIncapacitationTaggingEnabled({ CLOWDER_ASSIGNEE_INCAPACITATION_TAGGING: 'false' }), false);
    });
    test('threshold default 30, fail-open on typos', () => {
      assert.equal(mod.resolveIncapacitationThresholdMinutes({}), 30);
      assert.equal(mod.resolveIncapacitationThresholdMinutes({ CLOWDER_ASSIGNEE_INCAPACITATION_MINUTES: 'nope' }), 30);
      assert.equal(mod.resolveIncapacitationThresholdMinutes({ CLOWDER_ASSIGNEE_INCAPACITATION_MINUTES: '45' }), 45);
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
      return new mod.AssigneeIncapacitationScheduler({
        taskStore: store,
        messageStore: overrides.messageStore ?? createFakeMessageStore(),
        socketManager: overrides.socketManager ?? createFakeSocketManager(),
        tracker: overrides.tracker ?? fakeTracker(),
        env: overrides.env ?? {},
        now: overrides.now ?? (() => nowRef),
      });
    }

    test('no signal observed for the cat (undefined) → completely inert (neither tag nor clear)', async () => {
      const task = makeTask();
      store.seed(task);
      const messageStore = createFakeMessageStore();
      // tracker returns undefined for every cat (default fakeTracker())
      await makeScheduler({ messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).length, 0);
    });

    test('incapacitated but under the 30min threshold → no tag yet', async () => {
      const task = makeTask();
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 10 * 60_000 } });
      const messageStore = createFakeMessageStore();
      await makeScheduler({ tracker, messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test('incapacitated past 30min → task tagged + 双通知 (owner task_attention + channel notice), no reassignment', async () => {
      const task = makeTask();
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 31 * 60_000 } });
      const messageStore = createFakeMessageStore();
      const socketManager = createFakeSocketManager();
      await makeScheduler({ tracker, messageStore, socketManager }).tick();

      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'assignee_incapacitated').length, 1);
      assert.equal(updated.ownerCatId, OWNER, '绝不自动转派');
      assert.equal(updated.status, 'doing', '打标不改变任务状态');

      // 双通知 ①
      assert.equal(socketManager.userEmits.length, 1);
      assert.equal(socketManager.userEmits[0].userId, 'user-1');
      assert.equal(socketManager.userEmits[0].event, 'task_attention');
      // 双通知 ②
      assert.equal(messageStore.messages.length, 1);
      assert.equal(messageStore.messages[0].extra?.systemKind, 'assignee_incapacitated');
      assert.match(messageStore.messages[0].content, new RegExp(`@${OWNER}`));
      assert.match(messageStore.messages[0].content, /额度耗尽/);
      assert.match(messageStore.messages[0].content, /不会自动转派/);
    });

    test('already tagged → second tick does not re-tag or re-notify', async () => {
      const task = makeTask({
        events: [{ ts: new Date(nowRef - 20 * 60_000).toISOString(), catId: 'system', type: 'assignee_incapacitated', data: { classification: 'quota_exhausted', since: nowRef - 40 * 60_000 } }],
      });
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 40 * 60_000 } });
      const messageStore = createFakeMessageStore();
      await makeScheduler({ tracker, messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'assignee_incapacitated').length, 1, '不得重复打标');
    });

    test('status=todo is also taggable ("in_progress/todo 票")', async () => {
      const task = makeTask({ status: 'todo' });
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'process_abnormal', since: nowRef - 40 * 60_000 } });
      await makeScheduler({ tracker }).tick();
      const updated = await store.get(task.id);
      assert.equal(updated.events.some((e) => e.type === 'assignee_incapacitated'), true);
    });

    for (const status of ['in_review', 'blocked', 'done', 'failed']) {
      test(`status=${status} is NOT taggable (only todo/doing)`, async () => {
        const task = makeTask({ status });
        store.seed(task);
        const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 40 * 60_000 } });
        await makeScheduler({ tracker }).tick();
        const updated = await store.get(task.id);
        assert.equal((updated.events ?? []).length, 0);
      });
    }

    test('owner not a registered cat → skipped entirely', async () => {
      const task = makeTask({ ownerCatId: 'not-a-real-cat-xyz' });
      store.seed(task);
      const tracker = fakeTracker({ 'not-a-real-cat-xyz': { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 40 * 60_000 } });
      await makeScheduler({ tracker }).tick();
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).length, 0);
    });

    test('no ownerCatId (unclaimed) → skipped entirely', async () => {
      const task = makeTask({ ownerCatId: null });
      store.seed(task);
      await makeScheduler().tick();
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).length, 0);
    });

    test('healthy signal + no existing tag → no-op (nothing to clear)', async () => {
      const task = makeTask();
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'healthy' } });
      const messageStore = createFakeMessageStore();
      await makeScheduler({ tracker, messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
    });

    test('healthy signal + existing tag → tag cleared, assignee_recovered event with durationMs, notice posted', async () => {
      const since = nowRef - 90 * 60_000;
      const task = makeTask({
        events: [{ ts: new Date(nowRef - 60 * 60_000).toISOString(), catId: 'system', type: 'assignee_incapacitated', data: { classification: 'permission_denied', since } }],
      });
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'healthy' } });
      const messageStore = createFakeMessageStore();
      const socketManager = createFakeSocketManager();
      await makeScheduler({ tracker, messageStore, socketManager }).tick();

      const updated = await store.get(task.id);
      const recoveredEvent = updated.events.find((e) => e.type === 'assignee_recovered');
      assert.ok(recoveredEvent, '恢复后必须留一条 assignee_recovered 事件记录真空期');
      assert.equal(recoveredEvent.data.classification, 'permission_denied');
      assert.equal(recoveredEvent.data.since, since);
      assert.equal(recoveredEvent.data.durationMs, nowRef - since);
      assert.equal(messageStore.messages.some((m) => m.extra?.systemKind === 'assignee_recovered'), true);
    });

    test('healthy signal + already-cleared (no current tag) → does not re-clear or re-notify', async () => {
      const since = nowRef - 90 * 60_000;
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 60 * 60_000).toISOString(), catId: 'system', type: 'assignee_incapacitated', data: { classification: 'permission_denied', since } },
          { ts: new Date(nowRef - 50 * 60_000).toISOString(), catId: 'system', type: 'assignee_recovered', data: { classification: 'permission_denied', since, durationMs: 10 * 60_000 } },
        ],
      });
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'healthy' } });
      const messageStore = createFakeMessageStore();
      await makeScheduler({ tracker, messageStore }).tick();
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal(updated.events.filter((e) => e.type === 'assignee_recovered').length, 1, '不得重复清标/重复留档');
    });

    test('re-incapacitation after a prior recovery re-tags correctly (repeat cycle)', async () => {
      const oldSince = nowRef - 200 * 60_000;
      const task = makeTask({
        events: [
          { ts: new Date(nowRef - 190 * 60_000).toISOString(), catId: 'system', type: 'assignee_incapacitated', data: { classification: 'quota_exhausted', since: oldSince } },
          { ts: new Date(nowRef - 180 * 60_000).toISOString(), catId: 'system', type: 'assignee_recovered', data: { classification: 'quota_exhausted', since: oldSince, durationMs: 10 * 60_000 } },
        ],
      });
      store.seed(task);
      const newSince = nowRef - 40 * 60_000;
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'process_abnormal', since: newSince } });
      await makeScheduler({ tracker }).tick();
      const updated = await store.get(task.id);
      const tagEvents = updated.events.filter((e) => e.type === 'assignee_incapacitated');
      assert.equal(tagEvents.length, 2, '新一轮失能应重新打标');
      assert.equal(tagEvents[1].data.since, newSince);
    });

    test('kill switch off → tick() is a complete no-op', async () => {
      const task = makeTask();
      store.seed(task);
      const tracker = fakeTracker({ [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 60 * 60_000 } });
      const messageStore = createFakeMessageStore();
      await makeScheduler({ tracker, messageStore, env: { CLOWDER_ASSIGNEE_INCAPACITATION_TAGGING: '0' } }).tick();
      assert.equal(messageStore.messages.length, 0);
      const updated = await store.get(task.id);
      assert.equal((updated.events ?? []).length, 0);
    });

    test('multiple cats/tasks evaluated independently in one tick', async () => {
      const taskA1 = makeTask({ id: 'a1', ownerCatId: OWNER, threadId: 'thread-a' });
      const taskA2 = makeTask({ id: 'a2', ownerCatId: OWNER, threadId: 'thread-a2' });
      const taskB1 = makeTask({ id: 'b1', ownerCatId: OTHER_OWNER, threadId: 'thread-b' });
      store.seed(taskA1);
      store.seed(taskA2);
      store.seed(taskB1);
      const tracker = fakeTracker({
        [OWNER]: { kind: 'incapacitated', classification: 'quota_exhausted', since: nowRef - 40 * 60_000 },
        [OTHER_OWNER]: { kind: 'healthy' },
      });
      await makeScheduler({ tracker }).tick();

      const a1 = await store.get('a1');
      const a2 = await store.get('a2');
      const b1 = await store.get('b1');
      assert.equal(a1.events.some((e) => e.type === 'assignee_incapacitated'), true, 'OWNER 的两张票都应打标');
      assert.equal(a2.events.some((e) => e.type === 'assignee_incapacitated'), true);
      assert.equal((b1.events ?? []).length, 0, 'OTHER_OWNER 健康且无既有标，不应有任何事件');
    });
  });
});
