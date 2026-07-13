import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const input = {
  previousSummary: null,
  threadId: 'thread-api-summary',
  messages: [{ id: 'msg-1', content: '验证 API 摘要客户端。', catId: 'user', timestamp: Date.now() }],
};

function response(text, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    statusText: ok ? 'OK' : 'Unavailable',
    async json() {
      return { content: text == null ? [] : [{ type: 'text', text }] };
    },
  };
}

describe('Anthropic abstractive summary client outcomes', () => {
  it('returns provider_unavailable without making a request', async () => {
    const { createAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response('unused');
    };
    const client = createAbstractiveClient(async () => null, { info() {}, error() {} });
    const outcome = await client(input);
    assert.equal(outcome.kind, 'provider_unavailable');
    assert.equal(outcome.attempts, 0);
    assert.equal(calls, 0);
  });

  it('repairs invalid format once and returns a typed success', async () => {
    const { createAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return response('# Legacy\n\nMissing required sections.');
      return response(
        '# Repaired\n\n## 当前状态/任务 (Current status)\n验证中。\n\n## 已确认决策/约束 (Decision/constraint)\n仅格式错误重试。\n\n## 下一步 (Next action)\n保存摘要。\n\n## 风险/锚点 (Risk/anchor)\n回看 msg-1。',
      );
    };
    const client = createAbstractiveClient(
      async () => ({ mode: 'api_key', baseUrl: 'http://summary.test', apiKey: 'test-key' }),
      { info() {}, error() {} },
    );
    const outcome = await client(input);
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.attempts, 2);
    assert.equal(bodies.length, 2);
    assert.match(bodies[1].messages[0].content, /Format Repair/);
  });

  it('does not retry provider errors or empty responses', async () => {
    const { createAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response(null, false);
    };
    const profile = async () => ({ mode: 'api_key', baseUrl: 'http://summary.test', apiKey: 'test-key' });
    const client = createAbstractiveClient(profile, { info() {}, error() {} });
    const providerError = await client(input);
    assert.equal(providerError.kind, 'provider_error');
    assert.equal(providerError.attempts, 1);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response(null);
    };
    const empty = await client(input);
    assert.equal(empty.kind, 'empty_response');
    assert.equal(empty.attempts, 1);
    assert.equal(calls, 1);
  });
});
