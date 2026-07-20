// @ts-check
/**
 * 票B B2 — AgentReminderScheduler false-fire fix.
 *
 * Bug: tick() called store.markFired UNCONDITIONALLY after the enqueue attempt.
 * When outcome is 'resetting' (the live false-fire path), nothing was queued
 * but the reminder was marked fired and never retried.
 *
 * LIVE SENTINELS:
 *  - fake queue returning {outcome:'resetting'} → markFired NOT called,
 *    reminder stays 'scheduled' (retried next tick).
 *  - outcome 'enqueued' → markFired called, tryAutoExecute called.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeReminder(overrides = {}) {
  return {
    id: 'rem-1',
    catId: 'opus',
    threadId: 'thread-1',
    message: '检查构建',
    fireAt: Date.now() - 1000,
    status: 'scheduled',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makeDeps({ enqueueOutcome }) {
  const calls = { markFired: [], tryAutoExecute: [], appended: [], warnings: [] };
  const reminders = [makeReminder()];
  const deps = {
    store: {
      async due() {
        return reminders.filter((r) => r.status === 'scheduled');
      },
      async markFired(id) {
        calls.markFired.push(id);
        const r = reminders.find((item) => item.id === id);
        if (r) r.status = 'fired';
        return r ?? null;
      },
    },
    messageStore: {
      async append(input) {
        calls.appended.push(input);
        return { id: 'msg-1', ...input };
      },
    },
    threadStore: {
      async get() {
        return { id: 'thread-1', createdBy: 'user-1' };
      },
    },
    invocationQueue: {
      guardCallbackMutation() {
        return { acquired: true, release: () => {} };
      },
      enqueue() {
        return { outcome: enqueueOutcome };
      },
    },
    queueProcessor: {
      async tryAutoExecute(threadId) {
        calls.tryAutoExecute.push(threadId);
      },
    },
    log: {
      warn(obj, msg) {
        calls.warnings.push({ obj, msg });
      },
      info() {},
      error() {},
      debug() {},
    },
    intervalMs: 60_000,
  };
  return { deps, calls, reminders };
}

async function tickOnce(deps) {
  const { startAgentReminderScheduler } = await import(
    '../dist/domains/cats/services/reminders/AgentReminderScheduler.js'
  );
  // startAgentReminderScheduler runs one tick immediately; stop the interval right away.
  const stop = startAgentReminderScheduler(deps);
  stop();
  // allow the immediate async tick to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('B2 AgentReminderScheduler false-fire', () => {
  it("outcome 'resetting' → markFired NOT called, reminder stays scheduled for retry", async () => {
    const { deps, calls, reminders } = makeDeps({ enqueueOutcome: 'resetting' });
    await tickOnce(deps);

    assert.equal(calls.markFired.length, 0, 'markFired must NOT be called when nothing was enqueued');
    assert.equal(reminders[0].status, 'scheduled', 'reminder must stay scheduled for the next tick');
    assert.equal(calls.tryAutoExecute.length, 0, 'tryAutoExecute must not run when nothing was enqueued');
    assert.ok(calls.warnings.length > 0, 'a warn should record the skipped fire');
  });

  it("outcome 'enqueued' → markFired called, tryAutoExecute called", async () => {
    const { deps, calls, reminders } = makeDeps({ enqueueOutcome: 'enqueued' });
    await tickOnce(deps);

    assert.deepEqual(calls.markFired, ['rem-1']);
    assert.equal(reminders[0].status, 'fired');
    assert.deepEqual(calls.tryAutoExecute, ['thread-1']);
    assert.equal(calls.appended.length, 1, 'thread message appended exactly once');
  });

  it("outcome 'resetting' does not double-append the thread message on the retry tick", async () => {
    const { deps, calls, reminders } = makeDeps({ enqueueOutcome: 'resetting' });
    await tickOnce(deps);
    // second tick (still resetting) — reminder is still due; message must not pile up per tick
    await tickOnce(deps);

    assert.equal(reminders[0].status, 'scheduled');
    assert.equal(calls.appended.length, 0, 'no thread message is appended until the enqueue actually succeeds');
  });
});
