/**
 * Run Ledger Phase A tests.
 * The API must synthesize a read-only execution timeline without exposing prompts or secrets.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function buildFixture() {
  const { default: Fastify } = await import('fastify');
  const { runLedgerRoutes } = await import('../dist/routes/run-ledger.js');
  const { InvocationRecordStore } = await import(
    '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
  );
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

  const invocationRecordStore = new InvocationRecordStore();
  const messageStore = new MessageStore();
  const taskStore = new TaskStore();
  const app = Fastify();
  await app.register(runLedgerRoutes, { invocationRecordStore, messageStore, taskStore });
  await app.ready();

  return { app, invocationRecordStore, messageStore, taskStore };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('run ledger route', () => {
  test('returns a synthesized timeline for a succeeded invocation', async () => {
    const { app, invocationRecordStore, messageStore, taskStore } = await buildFixture();
    const userId = 'alice';
    const threadId = 'thread-ledger-1';
    const { invocationId } = invocationRecordStore.create({
      threadId,
      userId,
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'client-msg-1',
    });

    const userMessage = messageStore.append({
      threadId,
      userId,
      catId: null,
      content: 'Please run this private prompt with sk-ant-secret-value',
      mentions: ['codex'],
      timestamp: Date.now(),
    });
    invocationRecordStore.update(invocationId, { userMessageId: userMessage.id });
    invocationRecordStore.update(invocationId, { status: 'running', phase: 'runtime_starting' });

    await wait(5);
    const assistantTs = Date.now();
    const assistantMessage = messageStore.append({
      threadId,
      userId,
      catId: 'codex',
      content: 'Done. Secret should not echo: ANTHROPIC_API_KEY=sk-ant-secret-value',
      mentions: [],
      timestamp: assistantTs,
      toolEvents: [
        {
          id: 'tool-1',
          type: 'tool_result',
          label: 'apply_patch',
          detail: 'raw args include Authorization: Bearer secret',
          timestamp: assistantTs - 1,
        },
      ],
      metadata: {
        provider: 'openai',
        model: 'gpt-5',
        usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, costUsd: 0.01 },
      },
      extra: {
        stream: { invocationId },
        tracing: { traceId: 'trace-1', spanId: 'span-1' },
      },
    });
    await wait(5);
    invocationRecordStore.update(invocationId, {
      status: 'succeeded',
      phase: 'done',
      usageByCat: {
        codex: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, costUsd: 0.01 },
      },
    });

    taskStore.create({
      threadId,
      title: 'Implement ledger',
      why: 'phase-a-test',
      createdBy: 'user',
      sourceMessageId: userMessage.id,
      events: [
        {
          ts: new Date().toISOString(),
          catId: 'codex',
          invocationId,
          type: 'usage',
          data: { inputTokens: 12, outputTokens: 4, prompt: 'raw prompt must not leak' },
        },
        {
          ts: new Date().toISOString(),
          catId: 'codex',
          invocationId,
          type: 'artifact',
          data: { files: [{ path: 'packages/api/src/routes/run-ledger.ts', added: 10, removed: 0 }] },
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: `/api/run-ledger/${invocationId}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.summary.invocationId, invocationId);
    assert.equal(body.summary.threadId, threadId);
    assert.equal(body.summary.userMessageId, userMessage.id);
    assert.equal(body.summary.assistantMessageId, assistantMessage.id);
    assert.deepEqual(body.summary.targetCats, ['codex']);
    assert.equal(body.summary.status, 'succeeded');
    assert.equal(body.summary.usage.inputTokens, 12);
    assert.equal(body.summary.usage.outputTokens, 4);
    assert.equal(body.summary.toolCallCount, 1);
    assert.equal(body.summary.artifactCount, 1);
    assert.equal(body.summary.traceId, 'trace-1');
    assert.deepEqual(body.sources, { invocationRecord: true, messages: 2, taskEvents: 2, trace: true });

    const eventTypes = body.events.map((event) => event.type);
    assert.equal(eventTypes.filter((type) => type === 'message_persisted').length, 1);
    assert.ok(eventTypes.indexOf('created') < eventTypes.indexOf('running'));
    assert.ok(eventTypes.indexOf('running') < eventTypes.indexOf('message_persisted'));
    assert.ok(eventTypes.includes('tool_completed'));
    assert.ok(eventTypes.indexOf('message_persisted') < eventTypes.indexOf('succeeded'));
    assert.ok(eventTypes.includes('usage_recorded'));
    assert.ok(eventTypes.includes('artifact_delta'));

    assert.equal(res.body.includes('Please run this private prompt'), false);
    assert.equal(res.body.includes('raw prompt must not leak'), false);
    assert.equal(res.body.includes('sk-ant-secret-value'), false);
    assert.equal(res.body.includes('Authorization: Bearer secret'), false);

    await app.close();
  });

  test('returns degraded instead of failing when trace data is missing', async () => {
    const { app, invocationRecordStore, messageStore } = await buildFixture();
    const { invocationId } = invocationRecordStore.create({
      threadId: 'thread-ledger-2',
      userId: 'alice',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'client-msg-2',
    });
    const userMessage = messageStore.append({
      threadId: 'thread-ledger-2',
      userId: 'alice',
      catId: null,
      content: 'start',
      mentions: ['codex'],
      timestamp: 1710000010000,
    });
    invocationRecordStore.update(invocationId, { userMessageId: userMessage.id });
    invocationRecordStore.update(invocationId, { status: 'running' });
    invocationRecordStore.update(invocationId, { status: 'failed', phase: 'done', error: 'API_KEY=sk-ant-leaked timeout' });

    const res = await app.inject({ method: 'GET', url: `/api/run-ledger/${invocationId}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.summary.status, 'failed');
    assert.match(body.summary.errorSummary, /\[redacted-secret\]/);
    assert.equal(body.sources.trace, false);
    assert.ok(body.degraded);
    assert.ok(body.degraded.missingSources.includes('trace'));
    assert.equal(res.body.includes('sk-ant-leaked'), false);

    await app.close();
  });

  test('returns 404 for an unknown invocation', async () => {
    const { app } = await buildFixture();

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger/missing-invocation' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), {
      error: 'Run ledger not found',
      code: 'RUN_LEDGER_NOT_FOUND',
    });

    await app.close();
  });
});
