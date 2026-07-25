/**
 * AutoRetryScheduler tests (batch 3-B, item 3 — whitelisted auto retry)
 *
 * Uses in-memory fakes (no real Redis), mirroring the style of
 * test/startup-reconciler.test.js and test/invocations-retry.test.js.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// ── Fake scan-capable InvocationRecordStore ──

class FakeScanInvocationRecordStore {
  records = new Map();

  seed(record) {
    this.records.set(record.id, { autoRetryCount: 0, ...record });
  }

  async get(id) {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  async update(id, input) {
    const record = this.records.get(id);
    if (!record) return null;
    if (input.expectedStatus !== undefined && record.status !== input.expectedStatus) {
      return null;
    }
    if (input.status !== undefined) record.status = input.status;
    if (input.phase !== undefined) record.phase = input.phase;
    if (input.error !== undefined) record.error = input.error;
    if (input.autoRetryCount !== undefined) record.autoRetryCount = input.autoRetryCount;
    if (input.terminalEvent !== undefined) record.terminalEvent = input.terminalEvent;
    if (input.usageByCat !== undefined) record.usageByCat = input.usageByCat;
    record.updatedAt = Date.now();
    return { ...record };
  }

  async scanByStatus(status) {
    const ids = [];
    for (const [id, record] of this.records) {
      if (record.status === status) ids.push(id);
    }
    return ids;
  }
}

function makeRecord(overrides = {}) {
  return {
    id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    userMessageId: 'msg-1',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'failed',
    phase: 'done',
    idempotencyKey: 'k',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createFakeMessageStore(content = 'hello retry') {
  return {
    async getById(id) {
      if (id === 'missing') return null;
      return { id, content };
    },
  };
}

function createFakeRouter(events) {
  return {
    async *routeExecution() {
      if (events) {
        yield* events;
        return;
      }
      yield { type: 'text', catId: 'opus', content: 'retried ok', timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
}

function createFakeSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    messages,
  };
}

function createFakeInvocationTracker(opts = {}) {
  return {
    isDeleting: () => opts.deleting ?? false,
    startAll: () => new AbortController(),
    completeSlot: () => {},
    completeAll: () => {},
  };
}

describe('AutoRetryScheduler', () => {
  /** @type {typeof import('../dist/domains/cats/services/agents/invocation/AutoRetryScheduler.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/agents/invocation/AutoRetryScheduler.js');
    assert.ok(mod.AutoRetryScheduler);
    assert.ok(mod.isAutoRetryEnabled);
    assert.equal(mod.MAX_AUTO_RETRIES, 2);
  });

  describe('isAutoRetryEnabled', () => {
    test('false when unset', () => {
      assert.equal(mod.isAutoRetryEnabled({}), false);
    });
    test('false for arbitrary truthy-looking non-matching strings', () => {
      assert.equal(mod.isAutoRetryEnabled({ CLOWDER_AUTO_RETRY: 'yes' }), false);
    });
    test('true for "true"', () => {
      assert.equal(mod.isAutoRetryEnabled({ CLOWDER_AUTO_RETRY: 'true' }), true);
    });
    test('true for "1"', () => {
      assert.equal(mod.isAutoRetryEnabled({ CLOWDER_AUTO_RETRY: '1' }), true);
    });
    test('case-insensitive', () => {
      assert.equal(mod.isAutoRetryEnabled({ CLOWDER_AUTO_RETRY: 'TRUE' }), true);
    });
  });

  describe('tick() decision logic', () => {
    let store;

    beforeEach(() => {
      store = new FakeScanInvocationRecordStore();
    });

    function makeScheduler(overrides = {}) {
      return new mod.AutoRetryScheduler({
        invocationRecordStore: store,
        messageStore: overrides.messageStore ?? createFakeMessageStore(),
        router: overrides.router ?? createFakeRouter(),
        socketManager: overrides.socketManager ?? createFakeSocketManager(),
        invocationTracker: overrides.invocationTracker ?? createFakeInvocationTracker(),
        env: { CLOWDER_AUTO_RETRY: 'true' },
        now: overrides.now ?? (() => Date.now()),
        ...overrides,
      });
    }

    test('disabled by default: tick() does not touch any record', async () => {
      store.seed(
        makeRecord({
          id: 'r1',
          terminalEvent: { kind: 'transient_network', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000,
        }),
      );
      const scheduler = new mod.AutoRetryScheduler({
        invocationRecordStore: store,
        messageStore: createFakeMessageStore(),
        router: createFakeRouter(),
        socketManager: createFakeSocketManager(),
        invocationTracker: createFakeInvocationTracker(),
        env: {}, // CLOWDER_AUTO_RETRY unset
      });

      await scheduler.tick();
      assert.equal((await store.get('r1')).status, 'failed');
      assert.equal((await store.get('r1')).autoRetryCount, 0);
    });

    test('whitelisted transient_network failure due for retry gets claimed and succeeds', async () => {
      store.seed(
        makeRecord({
          id: 'r2',
          terminalEvent: { kind: 'transient_network', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000, // past the 30s first-tier backoff
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();

      // Give the fire-and-forget execution a tick to complete.
      await new Promise((r) => setTimeout(r, 20));

      const record = await store.get('r2');
      assert.equal(record.status, 'succeeded');
      assert.equal(record.autoRetryCount, 1);
    });

    test('non-whitelisted quota failure is never auto-retried', async () => {
      store.seed(
        makeRecord({
          id: 'r3',
          terminalEvent: { kind: 'quota', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000,
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));

      const record = await store.get('r3');
      assert.equal(record.status, 'failed');
      assert.equal(record.autoRetryCount, 0);
    });

    test('aborted / agent_error / context_overflow are never auto-retried', async () => {
      for (const kind of ['aborted', 'agent_error', 'context_overflow']) {
        const id = `never-${kind}`;
        store.seed(
          makeRecord({
            id,
            terminalEvent: { kind, at: Date.now() - 200_000, source: 'x' },
            updatedAt: Date.now() - 200_000,
          }),
        );
      }
      const scheduler = makeScheduler();
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));

      for (const kind of ['aborted', 'agent_error', 'context_overflow']) {
        const record = await store.get(`never-${kind}`);
        assert.equal(record.status, 'failed', `${kind} must stay failed`);
        assert.equal(record.autoRetryCount, 0, `${kind} must not be claimed`);
      }
    });

    test('not yet due (within 30s backoff window) is skipped', async () => {
      store.seed(
        makeRecord({
          id: 'r4',
          terminalEvent: { kind: 'cli_crash', at: Date.now() - 5_000, source: 'x' },
          updatedAt: Date.now() - 5_000, // only 5s ago, backoff is 30s
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();

      const record = await store.get('r4');
      assert.equal(record.status, 'failed');
      assert.equal(record.autoRetryCount, 0);
    });

    test('second retry uses the 120s backoff tier, not 30s', async () => {
      store.seed(
        makeRecord({
          id: 'r5',
          autoRetryCount: 1,
          terminalEvent: { kind: 'cli_crash', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000, // 60s ago: past 30s tier but NOT past 120s tier
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();

      const record = await store.get('r5');
      assert.equal(record.status, 'failed', 'must not claim before the 120s second-tier backoff elapses');
      assert.equal(record.autoRetryCount, 1);
    });

    test('cap: autoRetryCount already at MAX_AUTO_RETRIES is never claimed again', async () => {
      store.seed(
        makeRecord({
          id: 'r6',
          autoRetryCount: 2,
          terminalEvent: { kind: 'cli_crash', at: Date.now() - 500_000, source: 'x' },
          updatedAt: Date.now() - 500_000,
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();

      const record = await store.get('r6');
      assert.equal(record.status, 'failed');
      assert.equal(record.autoRetryCount, 2);
    });

    test('userMessageId=null is never claimed (nothing to replay)', async () => {
      store.seed(
        makeRecord({
          id: 'r7',
          userMessageId: null,
          terminalEvent: { kind: 'transient_network', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000,
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();

      const record = await store.get('r7');
      assert.equal(record.status, 'failed');
    });

    test('falls back to classifying record.error when terminalEvent is absent (legacy record)', async () => {
      store.seed(
        makeRecord({
          id: 'r8',
          error: 'connect ECONNRESET',
          updatedAt: Date.now() - 60_000,
        }),
      );
      const scheduler = makeScheduler();
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 10));

      const record = await store.get('r8');
      assert.equal(record.status, 'succeeded', 'ECONNRESET text should classify as transient_network and be retried');
    });

    test('provider error during retry keeps the record failed with the fresh error', async () => {
      store.seed(
        makeRecord({
          id: 'r9',
          terminalEvent: { kind: 'cli_crash', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000,
        }),
      );
      const router = createFakeRouter([
        { type: 'error', catId: 'opus', error: 'still crashing', timestamp: Date.now() },
        { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() },
      ]);
      const scheduler = makeScheduler({ router });
      await scheduler.tick();
      await new Promise((r) => setTimeout(r, 20));

      const record = await store.get('r9');
      assert.equal(record.status, 'failed');
      assert.equal(record.error, 'still crashing');
      assert.equal(record.autoRetryCount, 1);
    });

    test('concurrent ticks on the same eligible record: only one claims (CAS)', async () => {
      store.seed(
        makeRecord({
          id: 'r10',
          terminalEvent: { kind: 'transient_network', at: Date.now() - 60_000, source: 'x' },
          updatedAt: Date.now() - 60_000,
        }),
      );
      const scheduler = makeScheduler();
      await Promise.all([scheduler.tick(), scheduler.tick()]);
      await new Promise((r) => setTimeout(r, 20));

      const record = await store.get('r10');
      // Whichever tick won, autoRetryCount must be exactly 1 (not 2) — the
      // second tick's CAS must have observed status !== 'failed' and backed off.
      assert.equal(record.autoRetryCount, 1);
    });

    test('memory-mode store (no scanByStatus) is a safe no-op', async () => {
      const memoryStore = {
        async get() {
          return null;
        },
        async update() {
          return null;
        },
      };
      const scheduler = new mod.AutoRetryScheduler({
        invocationRecordStore: memoryStore,
        messageStore: createFakeMessageStore(),
        router: createFakeRouter(),
        socketManager: createFakeSocketManager(),
        invocationTracker: createFakeInvocationTracker(),
        env: { CLOWDER_AUTO_RETRY: 'true' },
      });
      await assert.doesNotReject(() => scheduler.tick());
    });
  });
});
