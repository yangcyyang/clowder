import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Verify that ACP error messages are persisted as system messages
 * so they survive F5 (page refresh) — the error badge should render
 * identically on reload as during streaming.
 *
 * Root cause: errors were appended to textContent as `[错误] ...` and
 * persisted as regular cat messages (catId set). On reload, these render
 * as normal assistant bubbles, not as red error badges. The frontend's
 * isLegacyError detection requires `type: 'system'` + `Error:` prefix.
 */

function createErrorService(catId, errorMsg) {
  return {
    async *invoke() {
      yield { type: 'error', catId, error: errorMsg, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createTextThenErrorService(catId, text, errorMsg) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'error', catId, error: errorMsg, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createTextService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createThinkingOnlyService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: 'I am thinking but will not emit final text.' }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createToolOnlyService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        id: 'tool-1',
        label: 'opencode → write',
        detail: '{"filePath":"docs/example.md"}',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls) {
  let invocationSeq = 0;
  let messageSeq = 0;

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
        };
        appendCalls.push(msg);
        return stored;
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('route-serial error persistence (F5 reload)', () => {
  it('persists scheduler silent-receipt presentation on the existing assistant message type', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { gemini: createTextService('gemini', 'Codex 窗口已激活，当前时间 10:30。') },
      appendCalls,
    );

    for await (const _msg of routeSerial(deps, ['gemini'], 'primer', 'user1', 'thread1', {
      responsePresentation: 'silent_receipt',
    })) {
      // drain
    }

    const catAppend = appendCalls.find((message) => message.catId === 'gemini');
    assert.ok(catAppend, 'receipt remains auditable as the existing assistant message');
    assert.equal(catAppend.extra.scheduler.hiddenReceipt, true);
  });

  it('persists error-only response as system message with Error: prefix', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { gemini: createErrorService('gemini', 'stream_idle_stall: Gemini stopped responding') },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Should have one append: the system error message
    const errorAppend = appendCalls.find((m) => m.userId === 'system' && m.catId === null);
    assert.ok(errorAppend, 'should persist a system error message');
    assert.ok(
      errorAppend.content.startsWith('Error:'),
      `system error content should start with "Error:" for legacy detection, got: ${errorAppend.content.slice(0, 60)}`,
    );
    assert.ok(errorAppend.content.includes('stream_idle_stall'), 'system error should contain the original error text');

    // No cat message with [错误] prefix should exist
    const catAppend = appendCalls.find((m) => m.catId === 'gemini');
    assert.equal(catAppend, undefined, 'error-only should NOT persist as cat message');
  });

  it('persists provider diagnostics on the same concise error message for F5 reload', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: {
          async *invoke() {
            yield {
              type: 'error',
              catId: 'codex',
              error: 'Codex 额度超限，7/20 23:26 恢复',
              errorCode: 'usage_limit',
              metadata: {
                provider: 'openai',
                model: 'gpt-5-codex',
                diagnostics: {
                  rawError: "You've hit your usage limit. Try again at Jul 20th, 2026 11:26 PM",
                  resetAt: 1784561160000,
                  invocationId: 'inv-quota',
                  rawArchivePath: '/tmp/raw/inv-quota.ndjson',
                },
              },
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      appendCalls,
    );

    for await (const _msg of routeSerial(deps, ['codex'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const errorAppend = appendCalls.find((message) => message.userId === 'system' && message.catId === null);
    assert.ok(errorAppend, 'quota failure should remain one persisted system error message');
    assert.equal(errorAppend.content, 'Error: Codex 额度超限，7/20 23:26 恢复');
    assert.equal(errorAppend.metadata.diagnostics.errorCode, 'usage_limit');
    assert.equal(errorAppend.metadata.diagnostics.invocationId, 'inv-quota');
    assert.match(errorAppend.metadata.diagnostics.rawError, /usage limit/i);
  });

  it('persists text+error as separate cat message + system error', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        gemini: createTextThenErrorService(
          'gemini',
          'Here is my partial response',
          'model_capacity: Server overloaded',
        ),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Cat message should have the text content WITHOUT [错误] contamination
    const catAppend = appendCalls.find((m) => m.catId === 'gemini');
    assert.ok(catAppend, 'should persist cat text message');
    assert.ok(!catAppend.content.includes('[错误]'), 'cat message should NOT contain [错误] prefix');
    assert.ok(catAppend.content.includes('partial response'), 'cat message should contain the actual response text');

    // System error message should also be persisted
    const errorAppend = appendCalls.find((m) => m.userId === 'system' && m.catId === null);
    assert.ok(errorAppend, 'should persist a separate system error message');
    assert.ok(errorAppend.content.startsWith('Error:'), 'system error should start with Error: prefix');
    assert.ok(errorAppend.content.includes('model_capacity'), 'system error should contain the error code');
  });

  it('does not persist a recovered provider error after later same-cat text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        gemini: {
          async *invoke() {
            yield { type: 'error', catId: 'gemini', error: 'temporary tool transport error', timestamp: Date.now() };
            yield { type: 'text', catId: 'gemini', content: 'Recovered answer', timestamp: Date.now() };
            yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          },
        },
      },
      appendCalls,
    );

    for await (const _msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    assert.ok(appendCalls.some((message) => message.catId === 'gemini' && message.content === 'Recovered answer'));
    assert.equal(
      appendCalls.some((message) => message.userId === 'system' && message.content.startsWith('Error:')),
      false,
    );
  });

  it('streams error event to frontend regardless of persistence', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ gemini: createErrorService('gemini', 'init_failure: CLI crashed') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['gemini'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    // Error should still be yielded to frontend for real-time display
    const errorMsg = yielded.find((m) => m.type === 'error');
    assert.ok(errorMsg, 'error should be yielded to frontend');
    assert.ok(errorMsg.error.includes('init_failure'), 'yielded error should contain error text');
  });

  it('persists thinking-only completion as visible system notice, not a blank assistant bubble', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opencode: createThinkingOnlyService('opencode') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opencode'], 'hello', 'user1', 'thread1')) {
      // drain generator
    }

    const blankCatAppend = appendCalls.find((m) => m.catId === 'opencode' && m.content === '');
    assert.equal(blankCatAppend, undefined, 'thinking-only turns should not persist blank assistant bubbles');

    const noticeAppend = appendCalls.find(
      (m) => m.userId === 'system' && m.catId === null && m.source?.connector === 'silent-completion',
    );
    assert.ok(noticeAppend, 'should persist a visible silent-completion notice');
    assert.ok(
      noticeAppend.content.includes('没有返回可展示文本'),
      'notice should explain that no displayable text was produced',
    );
    assert.ok(
      noticeAppend.content.includes('请总结刚才读取/检查到的内容'),
      'notice should suggest a concrete follow-up prompt',
    );
  });

  it('persists tool-only completion as visible system notice, not a blank assistant bubble', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opencode: createToolOnlyService('opencode') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opencode'], 'hello', 'user1', 'thread1')) {
      // drain generator
    }

    const blankCatAppend = appendCalls.find((m) => m.catId === 'opencode' && m.content === '');
    assert.equal(blankCatAppend, undefined, 'tool-only turns should not persist blank assistant bubbles');

    const noticeAppend = appendCalls.find(
      (m) => m.userId === 'system' && m.catId === null && m.source?.connector === 'silent-completion',
    );
    assert.ok(noticeAppend, 'should persist a visible silent-completion notice');
    assert.ok(noticeAppend.content.includes('工具调用 1 次'), 'notice should include tool diagnostics');
  });
});
