import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

function createCapturingService(catId, response) {
  const prompts = [];
  return {
    prompts,
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId, content: response, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

test('routeSerial content-free A2A injects the stored trigger once without 80/360-char preview truncation', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

  const threadId = 'thread-content-free-a2a-sentinel';
  const triggerBody = `${[
    'SENTINEL_HEAD',
    '甲乙🙂'.repeat(90),
    'SENTINEL_MIDDLE',
    '丙丁🚀'.repeat(90),
    'SENTINEL_TAIL',
  ].join('|')}\n@缅因猫 请按完整原文复核`;
  assert.ok(triggerBody.length > 500);

  const opus = createCapturingService('opus', triggerBody);
  const codex = createCapturingService('codex', '收到');
  const messageStore = new MessageStore();
  const previousCanary = process.env.CAT_CAFE_CONTENT_FREE_INBOX_THREADS;
  process.env.CAT_CAFE_CONTENT_FREE_INBOX_THREADS = threadId;

  try {
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: opus,
        codexService: codex,
        geminiService: createCapturingService('gemini', 'unused'),
        registry: new InvocationRegistry(),
        messageStore,
      }),
    );

    for await (const _message of router.route(
      'user-1',
      '@opus ROUTE_LEVEL_USER_SENTINEL must not replace the A2A trigger',
      threadId,
    )) {
      // Drain the complete serial worklist.
    }

    assert.equal(codex.prompts.length, 1, 'A2A target should be invoked once');
    const prompt = codex.prompts[0];
    assert.ok(prompt.includes('SENTINEL_HEAD'));
    assert.ok(prompt.includes('SENTINEL_MIDDLE'));
    assert.ok(prompt.includes('SENTINEL_TAIL'));
    assert.equal(prompt.split('SENTINEL_MIDDLE').length - 1, 1, 'stored trigger must be injected once');
    assert.ok(!prompt.includes('ROUTE_LEVEL_USER_SENTINEL'), 'route-level user text must not replace the A2A trigger');
    assert.ok(!prompt.includes('原文超限已截断'), 'normal >500-char trigger must remain complete');

    const storedTrigger = messageStore
      .getByThread(threadId)
      .find((message) => message.catId === 'opus' && message.content === triggerBody);
    assert.ok(storedTrigger, 'the A2A trigger must be persisted before the target invocation');
    assert.ok(prompt.includes(storedTrigger.id), 'full-content envelope must carry the exact trigger message ID');
  } finally {
    if (previousCanary === undefined) delete process.env.CAT_CAFE_CONTENT_FREE_INBOX_THREADS;
    else process.env.CAT_CAFE_CONTENT_FREE_INBOX_THREADS = previousCanary;
  }
});
