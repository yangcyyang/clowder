import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let tempDir;
let invokeSingleCat;

describe('invokeSingleCat Claude budget gate usage signal', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-budget-gate-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps() {
    let counter = 0;
    return {
      registry: {
        create: () => ({
          invocationId: `inv-budget-gate-${++counter}`,
          callbackToken: `tok-${counter}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => 'claude-old-session',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };
  }

  it('drops resume without emitting a channel bubble and records budget gate on usage', async () => {
    let receivedSessionId = 'not-called';
    const service = {
      async *invoke(_prompt, options) {
        receivedSessionId = options.sessionId;
        yield {
          type: 'done',
          catId: 'opus',
          metadata: {
            provider: 'anthropic',
            model: 'claude-test',
            usage: { inputTokens: 1200, outputTokens: 50 },
          },
          timestamp: Date.now(),
        };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'opus',
        service,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-budget-gate',
        isLastCat: true,
        contextBudget: {
          surface: 'thread',
          threadId: 'thread-budget-gate',
          toolPolicy: 'standard',
          toolPolicySource: 'agent-default',
          mode: 'serial',
          estimatedTokens: 12_000,
          historyMessages: 42,
          loadedBlocks: [],
          skippedBlocks: [],
          governanceTier: 'core',
          governanceEstimatedTokens: 0,
          governanceSourceInjected: false,
          usesFullHistory: false,
          maxPromptTokens: 200_000,
          maxContextTokens: 200_000,
          historyMode: 'summary-active',
          historyFullTokens: 180_000,
          historySummaryTokens: 2_000,
          historyBudgetRatio: 0.9,
        },
      }),
    );

    assert.equal(receivedSessionId, undefined, 'resume session should be dropped before service.invoke');
    assert.equal(
      msgs.some((msg) => msg.type === 'system_info' && String(msg.content).includes('Claude 预算闸门')),
      false,
      'budget gate must not emit a visible text system_info bubble',
    );

    const usageMsg = msgs.find((msg) => {
      if (msg.type !== 'system_info') return false;
      try {
        return JSON.parse(msg.content).type === 'invocation_usage';
      } catch {
        return false;
      }
    });
    assert.ok(usageMsg, 'invocation_usage system_info should be emitted');
    const parsed = JSON.parse(usageMsg.content);
    assert.equal(parsed.usage.budgetGateTriggered, true);
    assert.equal(parsed.usage.historyFullTokensBeforeGate, 180_000);
  });
});
