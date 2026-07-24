/**
 * ADR-024 W1-A: Cache telemetry wiring tests.
 *
 * Covers the full chain: Claude CLI NDJSON result/success event (cache_read_input_tokens /
 * cache_creation_input_tokens) → extractClaudeUsage() normalizes to TokenUsage
 * (cacheReadTokens / cacheCreationTokens) → done/error message metadata.usage →
 * InvocationRecord.usageByCat (routes/invocations.ts retry background handler,
 * same collection pattern used by messages.ts / callback-a2a-trigger.ts) →
 * exposed on GET /api/invocations/:id.
 *
 * This is a measurement-line addition (ADR-024 §W1-A). It does not change any
 * context-assembly logic — only telemetry plumbing for cache-hit visibility.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { extractClaudeUsage } from '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import { invocationsRoutes } from '../dist/routes/invocations.js';

// ─── Unit: Claude NDJSON usage event → normalized TokenUsage ──────────────────

describe('extractClaudeUsage — cache field extraction (ADR-024 W1-A)', () => {
  test('simulated result/success event with cache_read_input_tokens + cache_creation_input_tokens', () => {
    const event = {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 8400,
        cache_creation_input_tokens: 600,
        output_tokens: 340,
      },
      total_cost_usd: 0.0234,
      duration_ms: 5120,
      num_turns: 1,
    };

    const usage = extractClaudeUsage(event);

    assert.equal(usage.cacheReadTokens, 8400);
    assert.equal(usage.cacheCreationTokens, 600);
    // inputTokens is normalized to TOTAL input (new + cache_read + cache_creation)
    assert.equal(usage.inputTokens, 120 + 8400 + 600);
    assert.equal(usage.outputTokens, 340);
  });

  test('cache fields absent from the raw event → normalized usage omits them (no fabricated zeros)', () => {
    const event = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 500, output_tokens: 100 },
    };

    const usage = extractClaudeUsage(event);

    assert.equal(usage.inputTokens, 500);
    assert.equal('cacheReadTokens' in usage, false);
    assert.equal('cacheCreationTokens' in usage, false);
  });
});

// ─── Integration: usage collection → InvocationRecord.usageByCat → GET endpoint ──

/** Stub SocketManager: no-op, only needs to satisfy the plugin's option shape. */
function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

async function buildApp(invocationRecordStore, router) {
  const messageStore = new MessageStore();
  const invocationTracker = new InvocationTracker();
  const socketManager = createMockSocketManager();

  const app = Fastify();
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    messageStore,
    socketManager,
    router: router ?? { routeExecution: async function* () {} },
    invocationTracker,
  });
  await app.ready();
  return app;
}

describe('GET /api/invocations/:id — usageByCat cache fields (ADR-024 W1-A)', () => {
  it('exposes cacheReadTokens/cacheCreationTokens per cat when usageByCat is present', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const created = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-cache-1',
    });
    // State machine requires queued → running → succeeded (no direct queued → succeeded).
    invocationRecordStore.update(created.invocationId, { status: 'running' });
    invocationRecordStore.update(created.invocationId, {
      status: 'succeeded',
      usageByCat: {
        opus: {
          inputTokens: 9120,
          outputTokens: 340,
          cacheReadTokens: 8400,
          cacheCreationTokens: 600,
          costUsd: 0.0234,
        },
      },
    });

    const app = await buildApp(invocationRecordStore);
    const res = await app.inject({ method: 'GET', url: `/api/invocations/${created.invocationId}` });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.usageByCat, 'usageByCat should be present');
    assert.equal(body.usageByCat.opus.cacheReadTokens, 8400);
    assert.equal(body.usageByCat.opus.cacheCreationTokens, 600);
    assert.equal(body.usageByCat.opus.inputTokens, 9120);
  });

  it('omits usageByCat entirely when the invocation has not recorded usage yet', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const created = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-cache-2',
    });

    const app = await buildApp(invocationRecordStore);
    const res = await app.inject({ method: 'GET', url: `/api/invocations/${created.invocationId}` });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal('usageByCat' in body, false);
  });

  it('non-Claude provider usage without cache fields surfaces cleanly (no fabricated cache values)', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const created = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['kimi'],
      intent: 'execute',
      idempotencyKey: 'key-cache-3',
    });
    invocationRecordStore.update(created.invocationId, { status: 'running' });
    invocationRecordStore.update(created.invocationId, {
      status: 'succeeded',
      usageByCat: {
        kimi: { inputTokens: 2000, outputTokens: 400 },
      },
    });

    const app = await buildApp(invocationRecordStore);
    const res = await app.inject({ method: 'GET', url: `/api/invocations/${created.invocationId}` });

    const body = res.json();
    assert.equal(body.usageByCat.kimi.inputTokens, 2000);
    assert.equal('cacheReadTokens' in body.usageByCat.kimi, false);
    assert.equal('cacheCreationTokens' in body.usageByCat.kimi, false);
  });
});

describe('POST /api/invocations/:id/retry — cache usage flows from done event into usageByCat (ADR-024 W1-A)', () => {
  it('done event metadata.usage with cache fields ends up in InvocationRecord.usageByCat and on GET', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = new MessageStore();
    const invocationTracker = new InvocationTracker();
    const socketManager = createMockSocketManager();

    const storedMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@布偶猫 hello',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    const created = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-retry-cache-1',
    });
    invocationRecordStore.update(created.invocationId, { userMessageId: storedMsg.id, status: 'running' });
    invocationRecordStore.update(created.invocationId, { status: 'failed', error: 'CLI timeout' });

    // Mock router: simulates a Claude done event carrying the cache usage that
    // extractClaudeUsage() would have produced from a real result/success NDJSON frame.
    const router = {
      routeExecution: async function* () {
        yield {
          type: 'done',
          catId: 'opus',
          isFinal: true,
          timestamp: Date.now(),
          metadata: {
            provider: 'claude',
            model: 'claude-sonnet',
            usage: {
              inputTokens: 9120,
              outputTokens: 340,
              cacheReadTokens: 8400,
              cacheCreationTokens: 600,
              costUsd: 0.0234,
            },
          },
        };
      },
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute', explicit: false, promptTags: [] },
      }),
      ackCollectedCursors: async () => {},
    };

    const app = Fastify();
    await app.register(invocationsRoutes, {
      invocationRecordStore,
      messageStore,
      socketManager,
      router,
      invocationTracker,
    });
    await app.ready();

    const retryRes = await app.inject({ method: 'POST', url: `/api/invocations/${created.invocationId}/retry` });
    assert.equal(retryRes.statusCode, 202);

    // Background execution runs after the 202 reply; give it a tick.
    await new Promise((r) => setTimeout(r, 100));

    const record = invocationRecordStore.get(created.invocationId);
    assert.equal(record.status, 'succeeded');
    assert.ok(record.usageByCat?.opus, 'usageByCat.opus should be recorded');
    assert.equal(record.usageByCat.opus.cacheReadTokens, 8400);
    assert.equal(record.usageByCat.opus.cacheCreationTokens, 600);

    const getRes = await app.inject({ method: 'GET', url: `/api/invocations/${created.invocationId}` });
    const body = getRes.json();
    assert.equal(body.usageByCat.opus.cacheReadTokens, 8400);
    assert.equal(body.usageByCat.opus.cacheCreationTokens, 600);
  });
});
