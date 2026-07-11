import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

async function createHarness(injectNewMessage, outputMode = 'text') {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
  const { FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js');
  const messageStore = new MessageStore();
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const freshnessGate = new FreshnessEgressGate({ messageStore, holdStore });
  const richBlock = {
    id: 'parallel-freshness-card-1',
    kind: 'card',
    v: 1,
    title: '并行旧上下文卡片',
    bodyMarkdown: '这个卡片必须经过 Freshness Gate',
  };
  const privateToolSentinel = 'PARALLEL-PRIVATE-TOOL-INPUT';
  const service = {
    async *invoke() {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'parallel-inner-1' }),
        timestamp: Date.now(),
      };
      if (outputMode === 'tool' || outputMode === 'error-tool') {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'Write',
          toolInput: { content: privateToolSentinel },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolName: 'Write',
          content: `result:${privateToolSentinel}`,
          timestamp: Date.now(),
        };
      }
      if (outputMode === 'error-tool') {
        yield { type: 'error', catId: 'opus', error: 'provider failed after tool use', timestamp: Date.now() };
      } else if (outputMode === 'rich') {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
          timestamp: Date.now(),
        };
      } else {
        yield { type: 'text', catId: 'opus', content: '并行旧回答', timestamp: Date.now() };
      }
      if (injectNewMessage) {
        messageStore.append({
          userId: 'user-1',
          catId: null,
          threadId: 'thread-1',
          content: '并行生成期间的新消息',
          mentions: ['opus'],
          timestamp: Date.now(),
          deliveryStatus: 'queued',
        });
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  return {
    messageStore,
    holdStore,
    richBlock,
    privateToolSentinel,
    deps: {
      services: { opus: service },
      freshnessGate,
      messageStore,
      invocationDeps: {
        registry: {
          async create() {
            return { invocationId: 'parallel-registry-1', callbackToken: 'parallel-token-1' };
          },
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/freshness-parallel-test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      },
    },
  };
}

async function createCallbackHarness(disposition) {
  const harness = await createHarness(false);
  const { messageStore } = harness;
  const privateDraftSentinel = `PRIVATE-CALLBACK-DRAFT-PARALLEL-${disposition}`;
  let verdictResolved = false;
  harness.deps.services.opus = {
    async *invoke() {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'parallel-callback-inner-1' }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId: 'opus', content: '并行 stdout 回答', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId: 'opus',
        toolName: 'mcp:cat-cafe/cat_cafe_post_message',
        toolInput: { threadId: 'thread-1', content: privateDraftSentinel },
        timestamp: Date.now(),
      };

      if (disposition === 'published' || disposition === 'replayed') {
        const callbackMessage = await messageStore.append({
          userId: 'user-1',
          catId: 'opus',
          threadId: 'thread-1',
          content: 'callback 已发布回答',
          mentions: [],
          origin: 'callback',
          timestamp: Date.now(),
        });
        verdictResolved = true;
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: JSON.stringify({
            status: disposition === 'replayed' ? 'duplicate' : 'ok',
            disposition: 'published',
            threadId: 'thread-1',
            messageId: callbackMessage.id,
          }),
          timestamp: Date.now(),
        };
      } else if (disposition === 'held') {
        verdictResolved = true;
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: JSON.stringify({
            status: 'freshness_held',
            disposition: 'held',
            threadId: 'thread-1',
            holdId: 'callback-hold-1',
          }),
          timestamp: Date.now(),
        };
      } else if (disposition === 'discarded') {
        verdictResolved = true;
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: JSON.stringify({
            status: 'freshness_discarded',
            disposition: 'discarded',
            threadId: 'thread-1',
            holdId: 'callback-hold-2',
          }),
          timestamp: Date.now(),
        };
      } else {
        verdictResolved = true;
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  harness.privateDraftSentinel = privateDraftSentinel;
  harness.isVerdictResolved = () => verdictResolved;
  return harness;
}

describe('routeParallel Freshness Hold', () => {
  for (const callbackDisposition of ['published', 'replayed', 'held', 'discarded', 'failed']) {
    test(`treats callback ${callbackDisposition} with serial-compatible stdout fallback semantics`, async () => {
      const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
      const harness = await createCallbackHarness(callbackDisposition);
      const { deps, messageStore, holdStore, privateDraftSentinel } = harness;
      const persistenceContext = { failed: false, errors: [], egressByCat: {} };
      const yielded = [];
      const leakedBeforeVerdict = [];

      for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
        persistenceContext,
        parentInvocationId: `parallel-parent-callback-${callbackDisposition}`,
      })) {
        yielded.push(message);
        if (!harness.isVerdictResolved() && JSON.stringify(message).includes(privateDraftSentinel)) {
          leakedBeforeVerdict.push(message);
        }
      }

      assert.equal(leakedBeforeVerdict.length, 0, 'callback private draft must stay buffered until verdict');

      const formal = messageStore.getRecent(20).filter((message) => message.catId === 'opus');
      const stdoutText = yielded.filter((message) => message.type === 'text');
      if (callbackDisposition === 'published') {
        assert.equal(formal.length, 1, 'callback publication must remain the only formal message');
        assert.equal(formal[0].origin, 'callback');
        assert.equal(stdoutText.length, 0, 'confirmed callback publication must suppress stdout');
        assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
        assert.ok(
          yielded.some((message) => message.type === 'tool_use' && message.toolInput?.content === privateDraftSentinel),
          'published callback keeps tool detail after verdict',
        );
      } else if (callbackDisposition === 'replayed') {
        assert.equal(formal.length, 1, 'replay must keep the canonical callback publication only');
        assert.equal(stdoutText.length, 0);
        assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
        assert.equal(persistenceContext.egressByCat.opus.replayed, true);
        assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateDraftSentinel));
      } else if (callbackDisposition === 'held') {
        assert.equal(formal.length, 0, 'held callback must not fall back to stdout publication');
        assert.equal(stdoutText.length, 0, 'held callback must not leak buffered stdout');
        assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
        assert.equal(persistenceContext.egressByCat.opus.holdId, 'callback-hold-1');
        assert.equal(
          (await holdStore.listActive('user-1', 'thread-1')).length,
          0,
          'stdout must not create a second hold',
        );
        assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateDraftSentinel));
      } else if (callbackDisposition === 'discarded') {
        assert.equal(formal.length, 0, 'discarded callback must not fall back to stdout publication');
        assert.equal(stdoutText.length, 0, 'discarded callback must not leak buffered stdout');
        assert.equal(persistenceContext.egressByCat.opus.disposition, 'discarded');
        assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateDraftSentinel));
      } else {
        assert.equal(formal.length, 1, 'failed callback must allow one stdout fallback publication');
        assert.equal(formal[0].origin, 'stream');
        assert.equal(stdoutText.length, 1);
        assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
      }
    });
  }

  test('holds stale parallel output before yield and append', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore } = await createHarness(true);
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];
    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent',
    })) {
      yielded.push(message);
    }
    assert.equal(yielded.filter((message) => message.type === 'text').length, 0);
    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 0);
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
  });

  test('releases one replace event for fresh parallel output', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore } = await createHarness(false);
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];
    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-fresh',
    })) {
      yielded.push(message);
    }
    const text = yielded.filter((message) => message.type === 'text');
    assert.equal(text.length, 1);
    assert.equal(text[0].textMode, 'replace');
    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 1);
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
  });

  test('does not release or fan out a successful parallel submission replay', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore } = await createHarness(false);
    const firstContext = { failed: false, errors: [], egressByCat: {} };
    const replayContext = { failed: false, errors: [], egressByCat: {} };

    for await (const _message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext: firstContext,
      parentInvocationId: 'parallel-parent-replay',
    })) {
      // drain first publication
    }
    const replayed = [];
    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext: replayContext,
      parentInvocationId: 'parallel-parent-replay',
    })) {
      replayed.push(message);
    }

    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 1);
    assert.equal(replayContext.egressByCat.opus.disposition, 'published');
    assert.equal(replayContext.egressByCat.opus.replayed, true);
    assert.equal(replayed.filter((message) => message.type === 'text').length, 0);
  });

  test('buffers ordinary parallel tool detail until a fresh verdict is published', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore, privateToolSentinel } = await createHarness(false, 'tool');
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-tool-current',
    })) {
      if (JSON.stringify(message).includes(privateToolSentinel)) {
        assert.equal(
          messageStore.getRecent(20).some((stored) => stored.catId === 'opus'),
          true,
          'tool detail may surface only after the published message exists',
        );
      }
      yielded.push(message);
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
    assert.match(JSON.stringify(yielded), new RegExp(privateToolSentinel));
  });

  test('drops ordinary parallel tool detail when the final verdict is held', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, privateToolSentinel } = await createHarness(true, 'tool');
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-tool-stale',
    })) {
      yielded.push(message);
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
    assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateToolSentinel));
  });

  test('protected parallel provider error never persists or exposes tool-only detail', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore, privateToolSentinel } = await createHarness(false, 'error-tool');
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeParallel(deps, ['opus'], '开始', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-tool-error',
    })) {
      yielded.push(message);
    }

    assert.equal(
      messageStore.getRecent(20).some((stored) => stored.catId === 'opus'),
      false,
    );
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'discarded');
    assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateToolSentinel));
  });

  test('holds stale rich-block-only parallel output before append and outbound handoff', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, messageStore, holdStore, richBlock } = await createHarness(true, 'rich');
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeParallel(deps, ['opus'], '生成卡片', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-rich-stale',
    })) {
      yielded.push(message);
    }

    assert.equal(
      messageStore.getRecent(20).filter((message) => message.catId === 'opus').length,
      0,
      'held rich content must perform zero formal append',
    );
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
    assert.equal(persistenceContext.richBlocks, undefined, 'held rich blocks must not reach outbound delivery');
    assert.equal(
      yielded.filter((message) => {
        if (message.type !== 'system_info') return false;
        try {
          return JSON.parse(message.content).type === 'rich_block';
        } catch {
          return false;
        }
      }).length,
      0,
      'held rich blocks must remain private',
    );

    const hold = await holdStore.get(persistenceContext.egressByCat.opus.holdId);
    assert.deepEqual(
      hold?.draft.extra?.rich?.blocks,
      [richBlock],
      'hold must retain the complete rich payload for review',
    );
  });

  test('discarded rich-block-only parallel output never enters PersistenceContext or the route stream', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { deps, richBlock } = await createHarness(false, 'rich');
    deps.freshnessGate = {
      async submit() {
        return { outcome: 'discarded', hold: { id: 'discarded-rich-parallel' } };
      },
    };
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeParallel(deps, ['opus'], '生成卡片', 'user-1', 'thread-1', {
      persistenceContext,
      parentInvocationId: 'parallel-parent-rich-discarded',
    })) {
      yielded.push(message);
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'discarded');
    assert.equal(persistenceContext.richBlocks, undefined, 'discarded rich blocks must not reach consumers');
    assert.doesNotMatch(JSON.stringify(yielded), new RegExp(richBlock.bodyMarkdown));
  });
});
