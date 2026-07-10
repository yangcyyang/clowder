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

  it('parses Codex CLI text output into summary segments', async () => {
    const { createAgentAbstractiveClient } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    const calls = [];

    async function* invokeAgent(prompt, options) {
      calls.push({ prompt, options });
      yield {
        type: 'text',
        content:
          '# Codex 摘要 worker 最小闭环\n\n确认先只让摘要器处理 canary thread，并通过异步 worker 执行，失败时不阻塞主聊天。\n\n## Durable Knowledge\n\n[decision!] 摘要 worker 先限制在 canary thread — 降低误开全量摘要的风险',
      };
      yield { type: 'done' };
    }

    const client = createAgentAbstractiveClient(invokeAgent, {
      info() {},
      error() {},
    });

    const result = await client(input);

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Summarize the following thread messages/);
    assert.match(calls[0].options.systemPrompt, /You are a thread summarizer/);
    assert.equal(result?.segments.length, 1);
    assert.equal(result?.segments[0].topicLabel, 'Codex 摘要 worker 最小闭环');
    assert.equal(result?.segments[0].fromMessageId, 'msg-1');
    assert.equal(result?.segments[0].toMessageId, 'msg-2');
    assert.equal(result?.segments[0].candidates?.[0].kind, 'decision');
    assert.equal(result?.segments[0].candidates?.[0].confidence, 'explicit');
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

  it('labels codex-cli provider model ids explicitly', async () => {
    const { getAbstractiveSummaryModelId } = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');

    assert.equal(
      getAbstractiveSummaryModelId({
        CAT_CAFE_SUMMARY_PROVIDER: 'codex-cli',
        CAT_CAFE_SUMMARY_CODEX_CAT_ID: 'gpt52',
        CAT_CAFE_SUMMARY_CODEX_MODEL: 'gpt-5.5',
      }),
      'codex-cli:gpt52:gpt-5.5',
    );
  });
});
