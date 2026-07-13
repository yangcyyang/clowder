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

    const result = await client(input);

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Summarize the following thread messages/);
    assert.match(calls[0].prompt, /message_id=msg-1/);
    assert.match(calls[0].prompt, /message_id=msg-2/);
    assert.match(calls[0].options.systemPrompt, /You are a thread summarizer/);
    assert.match(calls[0].options.systemPrompt, /当前状态\/任务 \(Current status\)/);
    assert.match(calls[0].options.systemPrompt, /未从输入确认/);
    assert.equal(result?.segments.length, 1);
    assert.equal(result?.segments[0].topicLabel, 'Codex 摘要 worker 最小闭环');
    assert.equal(result?.segments[0].fromMessageId, 'msg-1');
    assert.equal(result?.segments[0].toMessageId, 'msg-2');
    assert.equal(result?.segments[0].candidates?.[0].kind, 'decision');
    assert.equal(result?.segments[0].candidates?.[0].confidence, 'explicit');
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

    assert.equal(await client(input), null);
    assert.match(errors.join('\n'), /missing required recall fields/);
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
    assert.equal(await client(input), null);
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

    const result = await client(input);

    assert.equal(result, null);
    assert.match(errors.join('\n'), /agent error/);
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
