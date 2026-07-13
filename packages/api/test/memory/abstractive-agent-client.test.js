import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Agent-backed abstractive summary client', () => {
  const input = {
    previousSummary: null,
    threadId: 'thread_codex_summary',
    messages: [
      {
        id: 'msg-1',
        content: '我们确认摘要器先只跑 canary thread。',
        catId: 'user',
        timestamp: Date.now() - 60_000,
      },
      {
        id: 'msg-2',
        content: '下一步用异步 worker，失败不影响主聊天。',
        catId: 'codex',
        timestamp: Date.now(),
      },
    ],
  };

  it('parses agent CLI text output into summary segments', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const calls = [];

    async function* invokeAgent(prompt, options) {
      calls.push({ prompt, options });
      yield {
        type: 'text',
        content:
          '# Codex 摘要 worker 最小闭环\n\n## 当前状态/任务 (Current status)\n摘要器正在 canary thread 验证。\n\n## 已确认决策/约束 (Decision/constraint)\n只通过异步 worker 执行，失败时不阻塞主聊天。\n\n## 下一步 (Next action)\n验证结构化摘要能被 delivery-only 消费。\n\n## 风险/锚点 (Risk/anchor)\n若摘要缺少细节，回看 msg-1..msg-2。\n\n## Durable Knowledge\n\n[decision!] 摘要 worker 先限制在 canary thread — 降低误开全量摘要的风险',
      };
      yield { type: 'done' };
    }

    const client = createAgentAbstractiveClient(
      invokeAgent,
      {
        info() {},
        error() {},
      },
      { providerId: 'pi-cli' },
    );

    const outcome = await client(input);

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Summarize the following thread messages/);
    assert.match(calls[0].prompt, /message_id=msg-1/);
    assert.match(calls[0].prompt, /message_id=msg-2/);
    assert.match(calls[0].options.systemPrompt, /You are a thread summarizer/);
    assert.match(calls[0].options.systemPrompt, /当前状态\/任务 \(Current status\)/);
    assert.match(calls[0].options.systemPrompt, /未从输入确认/);
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.result.segments.length, 1);
    assert.equal(outcome.result.segments[0].topicLabel, 'Codex 摘要 worker 最小闭环');
    assert.equal(outcome.result.segments[0].fromMessageId, 'msg-1');
    assert.equal(outcome.result.segments[0].toMessageId, 'msg-2');
    assert.equal(outcome.result.segments[0].candidates?.[0].kind, 'decision');
    assert.equal(outcome.result.segments[0].candidates?.[0].confidence, 'explicit');
  });

  it('fails open instead of storing a legacy prose summary without recall fields', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const errors = [];

    async function* invokeAgent() {
      yield {
        type: 'text',
        content: '# Legacy summary\n\nDiscussed the work and agreed to continue with the canary.',
      };
    }

    const client = createAgentAbstractiveClient(invokeAgent, {
      info() {},
      error(message) {
        errors.push(message);
      },
    });

    const outcome = await client(input);
    assert.equal(outcome.kind, 'invalid_format');
    assert.equal(outcome.attempts, 2);
    assert.equal(errors.length, 0, 'invalid format is logged only after the persistent third-run latch');
  });

  it('rejects canonical labels when a required field has no value', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    async function* invokeAgent() {
      yield {
        type: 'text',
        content:
          '# Incomplete\n\n## 当前状态/任务 (Current status)\n\n## 已确认决策/约束 (Decision/constraint)\n已确认 canary。\n\n## 下一步 (Next action)\n继续验证。\n\n## 风险/锚点 (Risk/anchor)\n回看 msg-1..msg-2。',
      };
    }

    const client = createAgentAbstractiveClient(invokeAgent, { info() {}, error() {} });
    const outcome = await client(input);
    assert.equal(outcome.kind, 'invalid_format');
    assert.equal(outcome.attempts, 2);
  });

  it('fails open when the agent reports an error', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const errors = [];

    async function* invokeAgent() {
      yield { type: 'error', error: 'Codex quota window is unavailable' };
    }

    const client = createAgentAbstractiveClient(invokeAgent, {
      info() {},
      error(message) {
        errors.push(message);
      },
    });

    const outcome = await client(input);

    assert.equal(outcome.kind, 'provider_error');
    assert.equal(outcome.attempts, 1);
    assert.match(errors.join('\n'), /agent error/);
  });

  it('repairs one invalid format and succeeds on the second attempt', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const prompts = [];

    async function* invokeAgent(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield { type: 'text', content: '# Missing fields\n\nOnly a legacy paragraph.' };
        return;
      }
      yield {
        type: 'text',
        content:
          '# Repaired\n\n## 当前状态/任务 (Current status)\n正在验证修复。\n\n## 已确认决策/约束 (Decision/constraint)\n仅 invalid format 重试。\n\n## 下一步 (Next action)\n持久化摘要。\n\n## 风险/锚点 (Risk/anchor)\n回看 msg-1..msg-2。',
      };
    }

    const client = createAgentAbstractiveClient(invokeAgent, { info() {}, error() {} });
    const outcome = await client(input);

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.attempts, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Format Repair/);
    assert.match(prompts[1], /Rejected Response/);
  });

  it('does not retry empty responses or timeouts', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    let emptyCalls = 0;
    async function* emptyAgent() {
      emptyCalls += 1;
      yield { type: 'done' };
    }
    const emptyClient = createAgentAbstractiveClient(emptyAgent, { info() {}, error() {} });
    const empty = await emptyClient(input);
    assert.equal(empty.kind, 'empty_response');
    assert.equal(empty.attempts, 1);
    assert.equal(emptyCalls, 1);

    let timeoutCalls = 0;
    async function* timeoutAgent(_prompt, options) {
      timeoutCalls += 1;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield { type: 'done' };
    }
    const timeoutClient = createAgentAbstractiveClient(timeoutAgent, { info() {}, error() {} }, { timeoutMs: 10 });
    const timeout = await timeoutClient(input);
    assert.equal(timeout.kind, 'timeout');
    assert.equal(timeout.attempts, 1);
    assert.equal(timeoutCalls, 1);
  });

  it('labels CLI provider model ids explicitly', async () => {
    const { getAbstractiveSummaryModelId, getSummaryProviderId } = await import(
      '../../dist/domains/memory/AbstractiveSummaryClient.js'
    );

    assert.equal(
      getAbstractiveSummaryModelId({
        CAT_CAFE_SUMMARY_PROVIDER: 'codex-cli',
        CAT_CAFE_SUMMARY_CODEX_CAT_ID: 'gpt52',
        CAT_CAFE_SUMMARY_CODEX_MODEL: 'gpt-5.5',
      }),
      'codex-cli:gpt52:gpt-5.5',
    );
    assert.equal(
      getAbstractiveSummaryModelId({
        CAT_CAFE_SUMMARY_PROVIDER: 'pi-cli',
        CAT_CAFE_SUMMARY_PI_CAT_ID: 'pi',
        CAT_CAFE_SUMMARY_PI_MODEL: 'mimo/mimo-v2.5-pro',
      }),
      'pi-cli:pi:mimo/mimo-v2.5-pro',
    );
    assert.equal(getSummaryProviderId({ CAT_CAFE_SUMMARY_PROVIDER: 'pi' }), 'pi-cli');
    assert.equal(getSummaryProviderId({ CAT_CAFE_SUMMARY_PROVIDER: 'pi-cli' }), 'pi-cli');
  });
});
