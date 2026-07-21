/**
 * QueueProcessor cooldown-gate tests — 理智线 T6 (task #388)
 * V0 scope: layer-1 entry gate only (entry dispatchable = NONE of its targetCats
 * are cooling). Fine-grained per-target splitting for parallel multi-mention is a
 * documented follow-up, not this ticket.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { CooldownStore } = await import('../dist/domains/cats/services/stores/ports/CooldownStore.js');

function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
      getByThreadAfter: mock.fn(async () => []),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue({
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  return result.entry;
}

describe('QueueProcessor cooldown gate', () => {
  let deps;
  let processor;
  let cooldownStore;

  beforeEach(() => {
    process.env.CAT_CAFE_AGENT_OUTPUT_GATE = '0';
    cooldownStore = new CooldownStore();
    deps = stubDeps({ cooldownStore });
    processor = new QueueProcessor(deps);
  });

  it('a cooling target keeps its entry queued (not dispatched) on auto-dequeue', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    cooldownStore.set({
      catId: 'opus',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });

    await processor.onInvocationComplete('t1', 'codex', 'succeeded');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      deps.router.routeExecution.mock.calls.length,
      0,
      'a cooling target must not be dispatched via routeExecution',
    );
    const stillQueued = deps.queue.list('t1', 'u1').find((e) => e.id === entry.id);
    assert.ok(stillQueued, 'entry must remain in the queue, not be consumed');
    assert.equal(stillQueued.status, 'queued');
  });

  it('posts a cooldown-pending notice exactly once, not on every re-scan', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    cooldownStore.set({
      catId: 'opus',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });

    await processor.onInvocationComplete('t1', 'codex', 'succeeded');
    await processor.onInvocationComplete('t1', 'codex', 'succeeded');
    await processor.onInvocationComplete('t1', 'codex', 'succeeded');

    const noticeCalls = deps.messageStore.append.mock.calls.filter(
      (c) => c.arguments[0]?.idempotencyKey === `cooldown-pending:${entry.id}`,
    );
    assert.equal(noticeCalls.length, 1, 'notice must be posted exactly once per entry, not once per scan');
    assert.match(noticeCalls[0].arguments[0].content, /冷却中/);
  });

  it('layer-1 gate checks ALL targetCats, not just index 0', async () => {
    // opus (index 0) is fine, but codex (index 1) is cooling — the whole entry must stay queued.
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus', 'codex'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    cooldownStore.set({
      catId: 'codex',
      until: Date.now() + 60_000,
      reason: 'usage_limit',
      source: 'openai',
      originalError: 'x',
    });

    await processor.onInvocationComplete('t1', 'gemini', 'succeeded');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      deps.router.routeExecution.mock.calls.length,
      0,
      'entry must stay queued even though targetCats[0] (opus) is not cooling — codex at index 1 is',
    );
  });

  it('a non-cooling entry in the same thread still dispatches normally', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['sonnet'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    // No cooldown set for 'sonnet'.

    await processor.onInvocationComplete('t1', 'codex', 'succeeded');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0 || deps.router.routeExecution.mock.calls.length > 0,
      'a non-cooling entry must still dispatch normally',
    );
  });

  it('once the cooldown expires (until in the past), the entry dispatches normally', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    cooldownStore.set({
      catId: 'opus',
      until: Date.now() - 1000, // already expired
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'x',
    });

    await processor.onInvocationComplete('t1', 'codex', 'succeeded');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0 || deps.router.routeExecution.mock.calls.length > 0,
      'an expired cooldown must not block dispatch — proves sweep-driven retry after expiry will succeed',
    );
  });

  it('without a cooldownStore configured, behavior is unchanged (backward compatible)', async () => {
    const bareDeps = stubDeps(); // no cooldownStore
    const bareProcessor = new QueueProcessor(bareDeps);
    const entry = enqueueEntry(bareDeps.queue, { targetCats: ['opus'] });
    bareDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await bareProcessor.onInvocationComplete('t1', 'codex', 'succeeded');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      bareDeps.invocationTracker.startAll.mock.calls.length > 0 || bareDeps.router.routeExecution.mock.calls.length > 0,
      'no cooldownStore configured must behave exactly like before T6',
    );
  });

  it('IDEMPOTENCY: sweep-triggered retry racing a natural onInvocationComplete dequeue does not double-dispatch', async () => {
    // Simulates the exact race 专家-Claude flagged: a cooldown expires right as some
    // OTHER cat's invocation completes and naturally triggers onInvocationComplete
    // for the same thread. Both call tryAutoExecute concurrently — the entry must
    // only actually start once (same slot-mutex guarantee already used elsewhere).
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    // No cooldown set — this test is about racing two dispatch triggers, not cooldown state itself.

    await Promise.all([
      processor.onInvocationComplete('t1', 'codex', 'succeeded'),
      processor.tryAutoExecute('t1'), // simulates the sweep's concurrent retry call
    ]);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      deps.router.routeExecution.mock.calls.length,
      1,
      'the entry must be actually invoked exactly once despite two concurrent dispatch triggers',
    );
  });
});
