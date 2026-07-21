/**
 * cooldown-sweep tests — 理智线 T6 (task #388)
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { sweepExpiredCooldowns } from '../dist/domains/cats/services/agents/invocation/cooldown-sweep.js';

function makeDeps(overrides = {}) {
  return {
    cooldownStore: { listActive: mock.fn(async () => []) },
    invocationQueue: { listThreadsWithQueuedEntryForCat: mock.fn(() => []) },
    queueProcessor: { tryAutoExecute: mock.fn(async () => {}) },
    log: { info: mock.fn(), warn: mock.fn() },
    ...overrides,
  };
}

describe('sweepExpiredCooldowns', () => {
  it('no active cooldowns → no-op', async () => {
    const deps = makeDeps();
    const result = await sweepExpiredCooldowns(deps);
    assert.deepEqual(result, { expiredCatCount: 0, retriedThreadCount: 0 });
    assert.equal(deps.queueProcessor.tryAutoExecute.mock.calls.length, 0);
  });

  it('active but not yet expired cooldowns → no retry', async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: { listActive: mock.fn(async () => [{ catId: 'opus', until: now + 60_000 }]) },
    });
    const result = await sweepExpiredCooldowns(deps, now);
    assert.equal(result.retriedThreadCount, 0);
    assert.equal(deps.queueProcessor.tryAutoExecute.mock.calls.length, 0);
  });

  it('an expired cooldown retries every thread with a queued entry for that cat', async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: { listActive: mock.fn(async () => [{ catId: 'opus', until: now - 1000 }]) },
      invocationQueue: {
        listThreadsWithQueuedEntryForCat: mock.fn((catId) => (catId === 'opus' ? ['t1', 't2'] : [])),
      },
    });
    const result = await sweepExpiredCooldowns(deps, now);
    assert.equal(result.expiredCatCount, 1);
    assert.equal(result.retriedThreadCount, 2);
    const retriedThreads = deps.queueProcessor.tryAutoExecute.mock.calls.map((c) => c.arguments[0]).sort();
    assert.deepEqual(retriedThreads, ['t1', 't2']);
  });

  it('multiple expired cats sharing a thread retry that thread only once', async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: {
        listActive: mock.fn(async () => [
          { catId: 'opus', until: now - 1000 },
          { catId: 'codex', until: now - 500 },
        ]),
      },
      invocationQueue: {
        listThreadsWithQueuedEntryForCat: mock.fn(() => ['t1']),
      },
    });
    const result = await sweepExpiredCooldowns(deps, now);
    assert.equal(result.retriedThreadCount, 1, 'thread t1 shared by both expired cats must only retry once');
  });

  it('a queue-lookup failure for one cat does not block retrying other expired cats', async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: {
        listActive: mock.fn(async () => [
          { catId: 'broken', until: now - 1000 },
          { catId: 'opus', until: now - 1000 },
        ]),
      },
      invocationQueue: {
        listThreadsWithQueuedEntryForCat: mock.fn((catId) => {
          if (catId === 'broken') throw new Error('boom');
          return ['t1'];
        }),
      },
    });
    const result = await sweepExpiredCooldowns(deps, now);
    assert.equal(result.retriedThreadCount, 1);
    assert.ok(deps.log.warn.mock.calls.length > 0);
  });

  it('a tryAutoExecute failure for one thread does not block retrying other threads', async () => {
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: { listActive: mock.fn(async () => [{ catId: 'opus', until: now - 1000 }]) },
      invocationQueue: { listThreadsWithQueuedEntryForCat: mock.fn(() => ['t1', 't2']) },
      queueProcessor: {
        tryAutoExecute: mock.fn(async (threadId) => {
          if (threadId === 't1') throw new Error('boom');
        }),
      },
    });
    const result = await sweepExpiredCooldowns(deps, now);
    assert.equal(result.retriedThreadCount, 2, 'both threads counted as retried even though t1 threw');
    assert.equal(deps.queueProcessor.tryAutoExecute.mock.calls.length, 2);
  });

  it('IDEMPOTENCY: calling the sweep twice for the same expired cooldown is safe (tryAutoExecute is itself idempotent)', async () => {
    // The sweep itself doesn't dedupe — it relies on tryAutoExecute's own slot-mutex
    // idempotency (same guarantee as QueueProcessor's natural onInvocationComplete
    // dequeue path). This test documents that contract: calling sweep N times just
    // calls tryAutoExecute N times, which is exactly what natural re-triggers already do.
    const now = 1_000_000;
    const deps = makeDeps({
      cooldownStore: { listActive: mock.fn(async () => [{ catId: 'opus', until: now - 1000 }]) },
      invocationQueue: { listThreadsWithQueuedEntryForCat: mock.fn(() => ['t1']) },
    });
    await sweepExpiredCooldowns(deps, now);
    await sweepExpiredCooldowns(deps, now);
    assert.equal(deps.queueProcessor.tryAutoExecute.mock.calls.length, 2, 'sweep calls tryAutoExecute each time');
    // Correctness of "no double dispatch" is enforced downstream in QueueProcessor's
    // own slot mutex — verified directly in queue-processor-cooldown.test.js.
  });
});
