import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

/**
 * [thread-task-design] §2 root cause / batch-1 leftover: restorePersistedEntries()
 * restores F194-persisted queue entries after a restart with status:'queued', but
 * tryAutoExecute() only ever scans autoExecute:true (A2A) entries — plain user/connector
 * entries were durably journaled on enqueue (messages.ts) yet never got a dequeue kick on
 * restart, so they sat inert until a human happened to trigger "process next" in the UI.
 *
 * QueueProcessor.resumeRestoredEntries() is the fix: called once after restore, it drives
 * both autoExecute entries (via the existing tryAutoExecute) and plain entries (via the
 * existing processNext) — no new scheduler — with a reply-already-posted double-guard
 * mirroring StartupReconciler's requeue judgment (hasTargetReplyAfterUserMessage).
 */

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
      getByThread: mock.fn(async () => []),
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

async function waitForCondition(predicate, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('QueueProcessor.resumeRestoredEntries (restart auto-resume)', () => {
  let deps;
  let processor;

  beforeEach(() => {
    process.env.CAT_CAFE_AGENT_OUTPUT_GATE = '0';
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  it('tryAutoExecute alone still skips a restored plain user entry (pre-fix behavior, unchanged)', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user', targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.tryAutoExecute('t1');
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'tryAutoExecute must not run plain user entries');
    assert.equal(deps.queue.list('t1', 'u1')[0]?.status, 'queued', 'entry stays queued without the fix');
  });

  it('resumeRestoredEntries dispatches a restored plain user entry that tryAutoExecute alone would skip', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user', targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    // No reply from opus after msg-1 yet → not "already answered".
    deps.messageStore.getByThread = mock.fn(async () => [{ id: 'msg-1', catId: null, content: 'hi' }]);

    await processor.resumeRestoredEntries(['t1']);
    await waitForCondition(() => deps.router.routeExecution.mock.calls.length > 0);

    assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'resumeRestoredEntries must dispatch the entry');
  });

  it('drops a restored entry whose target cat already replied, instead of re-running it', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user', targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    // opus already answered msg-1 — the double-guard scenario (a stale/duplicated journal row).
    deps.messageStore.getByThread = mock.fn(async () => [
      { id: 'msg-1', catId: null, content: 'hi' },
      { id: 'msg-2', catId: 'opus', content: 'already answered this' },
    ]);

    await processor.resumeRestoredEntries(['t1']);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'already-answered entry must not be re-run');
    assert.equal(deps.queue.list('t1', 'u1').length, 0, 'already-answered entry must be evicted from the queue');
  });

  it('still dispatches autoExecute A2A entries via tryAutoExecute (unchanged behavior)', async () => {
    enqueueEntry(deps.queue, {
      userId: 'system',
      source: 'agent',
      targetCats: ['codex'],
      autoExecute: true,
      callerCatId: 'opus',
    });

    await processor.resumeRestoredEntries(['t1']);
    await waitForCondition(() => deps.router.routeExecution.mock.calls.length > 0);

    assert.equal(deps.router.routeExecution.mock.calls.length, 1);
  });

  it('is a no-op for a thread with no queued entries (no throw)', async () => {
    await assert.doesNotReject(() => processor.resumeRestoredEntries(['empty-thread']));
    assert.equal(deps.router.routeExecution.mock.calls.length, 0);
  });

  it('mixed thread: dispatches the free-slot user entry and leaves an already-answered sibling evicted', async () => {
    const entryA = enqueueEntry(deps.queue, { source: 'user', targetCats: ['opus'], content: 'first' });
    deps.queue.backfillMessageId('t1', 'u1', entryA.id, 'msg-a');
    const entryB = enqueueEntry(deps.queue, { source: 'user', targetCats: ['codex'], content: 'second' });
    deps.queue.backfillMessageId('t1', 'u1', entryB.id, 'msg-b');

    deps.messageStore.getByThread = mock.fn(async () => [
      { id: 'msg-a', catId: null, content: 'first' },
      { id: 'msg-b', catId: null, content: 'second' },
      { id: 'msg-b-reply', catId: 'codex', content: 'codex already replied to msg-b' },
    ]);

    await processor.resumeRestoredEntries(['t1']);
    await waitForCondition(() => deps.router.routeExecution.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));

    const remaining = deps.queue.list('t1', 'u1');
    assert.ok(
      remaining.every((entry) => entry.id !== entryB.id),
      'the already-answered entry (codex/msg-b) must be evicted',
    );
  });
});
