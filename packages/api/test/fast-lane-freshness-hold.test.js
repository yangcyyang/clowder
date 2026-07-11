import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js');
const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

const previousFastLane = process.env.CAT_CAFE_FAST_LANE;

afterEach(() => {
  if (previousFastLane === undefined) delete process.env.CAT_CAFE_FAST_LANE;
  else process.env.CAT_CAFE_FAST_LANE = previousFastLane;
});

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function createHarness() {
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const freshnessGate = new FreshnessEgressGate({ messageStore, holdStore });
  const broadcasts = [];
  const roomBroadcasts = [];
  const updates = [];
  const taskEvents = [];
  const deps = {
    queue,
    invocationTracker: {
      startAll: () => new AbortController(),
      start: () => new AbortController(),
      complete() {},
      completeAll() {},
      has: () => false,
    },
    invocationRecordStore: {
      async create() {
        return { outcome: 'created', invocationId: 'fast-invocation' };
      },
      async update(id, patch) {
        updates.push({ id, patch });
      },
    },
    router: {
      async *routeExecution() {
        throw new Error('fast lane must not call routeExecution');
      },
      async ackCollectedCursors() {},
    },
    socketManager: {
      broadcastAgentMessage(message) {
        broadcasts.push(message);
      },
      broadcastToRoom(...args) {
        roomBroadcasts.push(args);
      },
      emitToUser() {},
    },
    taskStore: {
      async listByThread() {
        return [{ id: 'fast-task', threadId: 'fast-thread', taskThreadId: 'fast-thread', events: [...taskEvents] }];
      },
      async update(id, patch) {
        taskEvents.push(...(patch.events ?? []));
        return { id, threadId: 'fast-thread', taskThreadId: 'fast-thread', events: [...taskEvents] };
      },
    },
    messageStore,
    freshnessGate,
    log: { info() {}, warn() {}, error() {} },
    gitArtifactCollector: async () => ({ files: [], totalAdded: 0, totalRemoved: 0 }),
  };
  const processor = new QueueProcessor(deps);
  return { processor, queue, messageStore, holdStore, broadcasts, roomBroadcasts, taskEvents, updates };
}

describe('fast-lane Freshness Hold', () => {
  test('a message appended while the fast lane runs holds its completion before socket publication', async () => {
    process.env.CAT_CAFE_FAST_LANE = '1';
    const harness = createHarness();
    const current = harness.messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: 'fast-thread',
      content: '/project-init demo --root /tmp',
      mentions: ['opus'],
      timestamp: 1000,
    });
    const enqueued = harness.queue.enqueue({
      threadId: 'fast-thread',
      userId: 'user-1',
      content: '/project-init demo --root /tmp',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    harness.queue.backfillMessageId('fast-thread', 'user-1', enqueued.entry.id, current.id);

    harness.processor.fastLaneExecutor = {
      async executeProjectInit() {
        harness.messageStore.append({
          userId: 'user-1',
          catId: 'codex',
          threadId: 'fast-thread',
          content: '独立 B 猫在 fast-lane 期间追加的正式消息',
          mentions: [],
          timestamp: 1001,
          extra: { stream: { invocationId: 'independent-b' } },
        });
        return {
          status: 'succeeded',
          stdout: 'STALE PRIVATE FAST-LANE DRAFT',
          stderr: 'STALE PRIVATE FAST-LANE STDERR',
          durationMs: 1,
          files: [],
        };
      },
    };

    const started = await harness.processor.processNext('fast-thread', 'user-1');
    assert.equal(started.started, true);
    await waitFor(() => harness.updates.some(({ patch }) => patch.status === 'succeeded'));

    assert.equal(
      harness.broadcasts.some((message) => message.type === 'text' && /fast-lane|快车道/.test(message.content)),
      false,
    );
    const holdNotice = harness.broadcasts.find(
      (message) => message.type === 'system_info' && JSON.parse(message.content).type === 'freshness_hold',
    );
    assert.ok(holdNotice, 'held fast-lane completion must be observable without exposing its draft');
    const assistantMessages = harness.messageStore
      .getRecent(20)
      .filter((message) => message.catId === 'opus' && message.messageClass !== 'status');
    assert.equal(assistantMessages.length, 0);
    const observableTaskState = JSON.stringify({
      taskEvents: harness.taskEvents,
      roomBroadcasts: harness.roomBroadcasts,
    });
    assert.doesNotMatch(observableTaskState, /STALE PRIVATE FAST-LANE/);
  });
});
