/**
 * QueueProcessor daily cost budget gate wiring — batch 3-E, item 2.
 *
 * These tests exercise the `this.deps.budgetGate` seam added to executeEntry():
 * a blocked run must never reach router.routeExecution (no CLI spawn attempted),
 * must finalize the InvocationRecord as failed with an explicit budget_exhausted
 * terminalEvent (3-B Terminal Invariant), and must produce error text that the
 * existing classifyRunFailureForTask() classifier (batch 3-A) recognizes as
 * 'budget_exhausted' — so a linked task correctly moves to failed.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { classifyRunFailureForTask } = await import(
  '../dist/domains/cats/services/tasks/task-run-linkage.js'
);

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
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-budget-stub' })),
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
      getByThread: mock.fn(async () => []),
      markDelivered: mock.fn(async () => null),
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

/** Mirrors the same helper used in queue-processor-resume-restored-entries.test.js —
 *  routeExecution dispatch can land a tick after the triggering call resolves. */
async function waitForCondition(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('QueueProcessor daily cost budget gate wiring', () => {
  beforeEach(() => {
    process.env.CAT_CAFE_AGENT_OUTPUT_GATE = '0';
  });
  afterEach(() => {
    delete process.env.CAT_CAFE_AGENT_OUTPUT_GATE;
  });

  it('HARD CONSTRAINT: without a budgetGate dep configured, behavior is unchanged (backward compatible)', async () => {
    const deps = stubDeps(); // no budgetGate
    const processor = new QueueProcessor(deps);
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    await waitForCondition(() => deps.router.routeExecution.mock.calls.length > 0);

    assert.ok(result.started, 'entry must still dispatch normally when no budgetGate dep is wired');
    assert.equal(deps.router.routeExecution.mock.calls.length, 1);
  });

  it('an allowed budgetGate check does not block dispatch', async () => {
    const budgetGate = { check: mock.fn(async () => ({ allowed: true })) };
    const deps = stubDeps({ budgetGate });
    const processor = new QueueProcessor(deps);
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    await waitForCondition(() => deps.router.routeExecution.mock.calls.length > 0);

    assert.ok(result.started);
    assert.equal(deps.router.routeExecution.mock.calls.length, 1);
    assert.equal(budgetGate.check.mock.calls.length, 1);
    assert.deepEqual(budgetGate.check.mock.calls[0].arguments[0], ['opus']);
  });

  it('a blocked budgetGate check prevents any CLI spawn and finalizes the run as failed', async () => {
    const budgetGate = {
      check: mock.fn(async () => ({
        allowed: false,
        blocked: { catId: 'opus', spentUsd: 5.1234, capUsd: 5 },
      })),
    };
    const deps = stubDeps({ budgetGate });
    const processor = new QueueProcessor(deps);
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');

    assert.equal(
      deps.router.routeExecution.mock.calls.length,
      0,
      'a budget-blocked run must never reach routeExecution — no CLI process is spawned',
    );

    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const terminalUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(terminalUpdate, 'the invocation record must be finalized as failed');
    assert.equal(terminalUpdate.arguments[0], 'inv-budget-stub');

    const { error, terminalEvent } = terminalUpdate.arguments[1];
    assert.match(error, /Budget cap exceeded/);
    assert.match(error, /opus/);
    assert.ok(terminalEvent, '3-B Terminal Invariant: a terminal failed status must carry an explicit terminalEvent');
    assert.equal(terminalEvent.kind, 'budget_exhausted');
    assert.equal(terminalEvent.detail.catId, 'opus');
    assert.equal(terminalEvent.detail.capUsd, 5);

    // Batch 3-A wiring: the exact error text this gate produces must classify as
    // budget_exhausted under the existing task-run-linkage classifier, so a linked
    // task correctly moves to 'failed' (not 'blocked' — budget_exhausted is not in
    // BLOCKING_FAILURE_CLASSES) via the unmodified linkTaskRunOutcome() finally-block call.
    assert.equal(classifyRunFailureForTask(error), 'budget_exhausted');

    const errorBroadcast = deps.socketManager.broadcastAgentMessage.mock.calls.find(
      (c) => c.arguments[0]?.type === 'error',
    );
    assert.ok(errorBroadcast, 'an error message must be broadcast to the thread');
    assert.equal(errorBroadcast.arguments[0].origin, 'budget_gate');
  });

  it('checks ALL targetCats, not just index 0', async () => {
    const budgetGate = {
      check: mock.fn(async (targetCats) => {
        assert.deepEqual(targetCats, ['opus', 'codex']);
        return { allowed: false, blocked: { catId: 'codex', spentUsd: 1, capUsd: 0.5 } };
      }),
    };
    const deps = stubDeps({ budgetGate });
    const processor = new QueueProcessor(deps);
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus', 'codex'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');

    assert.equal(deps.router.routeExecution.mock.calls.length, 0);
    assert.equal(budgetGate.check.mock.calls.length, 1);
  });
});
