import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

async function createHarness({ injectNewMessage, threadId, outputMode = 'text', outputContent, fixedInvocationId }) {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
  const { FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js');
  const messageStore = new MessageStore();
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const freshnessGate = new FreshnessEgressGate({ messageStore, holdStore });
  const richBlock = {
    ...(outputMode === 'audio'
      ? {
          id: 'freshness-audio-1',
          kind: 'audio',
          v: 1,
          text: '这段旧稿语音不得在 verdict 前合成',
        }
      : {
          id: 'freshness-card-1',
          kind: 'card',
          v: 1,
          title: '旧上下文卡片',
          bodyMarkdown: '这个卡片必须经过 Freshness Gate',
        }),
  };
  const privateToolSentinel = 'SERIAL-PRIVATE-TOOL-INPUT';
  const socketBroadcasts = [];
  let invocationSequence = 0;
  const service = {
    async *invoke() {
      const invocationId = fixedInvocationId ?? `inner-${++invocationSequence}`;
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'invocation_created', invocationId }),
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
      } else if (outputMode === 'rich' || outputMode === 'audio') {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'rich_block', block: richBlock }),
          timestamp: Date.now(),
        };
        if (outputMode === 'audio') {
          yield { type: 'text', catId: 'opus', content: '携带语音块的旧回答', timestamp: Date.now() };
        }
      } else {
        yield {
          type: 'text',
          catId: 'opus',
          content: outputContent ?? '基于旧上下文形成的回答',
          timestamp: Date.now(),
        };
      }
      if (injectNewMessage) {
        messageStore.append({
          userId: 'user-1',
          catId: null,
          threadId,
          content: '生成期间到达的新要求',
          mentions: ['opus'],
          timestamp: Date.now(),
          deliveryStatus: 'queued',
        });
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { opus: service },
    invocationDeps: {
      registry: {
        async create() {
          const n = invocationSequence + 1;
          return { invocationId: `registry-${n}`, callbackToken: `token-${n}` };
        },
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/freshness-route-test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore,
    freshnessGate,
    socketManager: {
      broadcastToRoom(room, event, data) {
        socketBroadcasts.push({ room, event, data });
      },
    },
  };
  return { deps, messageStore, holdStore, richBlock, privateToolSentinel, socketBroadcasts };
}

describe('routeSerial Freshness Hold', () => {
  test('holds a stale stdout draft before text yield and formal append', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-stale';
    const { deps, messageStore } = await createHarness({ injectNewMessage: true, threadId });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '开始回答', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-1',
    })) {
      yielded.push(message);
    }

    assert.equal(yielded.filter((message) => message.type === 'text').length, 0, 'held text must stay private');
    assert.equal(
      messageStore.getRecent(20).filter((message) => message.catId === 'opus').length,
      0,
      'held output must perform zero formal append',
    );
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
    assert.ok(
      yielded.some((message) => {
        if (message.type !== 'system_info') return false;
        try {
          return JSON.parse(message.content).type === 'freshness_hold';
        } catch {
          return false;
        }
      }),
      `hold must be visible as structured control state: ${JSON.stringify({ yielded, persistenceContext })}`,
    );
  });

  test('publishes a fresh stdout draft once and releases one replace text event', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-current';
    const { deps, messageStore } = await createHarness({ injectNewMessage: false, threadId });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '开始回答', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-fresh',
    })) {
      yielded.push(message);
    }

    const text = yielded.filter((message) => message.type === 'text');
    assert.equal(text.length, 1, JSON.stringify({ yielded, persistenceContext }));
    assert.equal(text[0].textMode, 'replace');
    assert.equal(text[0].content, '基于旧上下文形成的回答');
    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 1);
    assert.equal(persistenceContext.egressByCat.opus.disposition, 'published');
  });

  test('does not release or fan out a successful stdout submission replay', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-submit-replay';
    const { deps, messageStore } = await createHarness({
      injectNewMessage: false,
      threadId,
      fixedInvocationId: 'fixed-inner-replay',
    });
    const firstContext = { failed: false, errors: [], egressByCat: {} };
    const replayContext = { failed: false, errors: [], egressByCat: {} };

    for await (const _message of routeSerial(deps, ['opus'], '开始回答', 'user-1', threadId, {
      persistenceContext: firstContext,
      parentInvocationId: 'fixed-parent-replay',
    })) {
      // drain first publication
    }
    const replayed = [];
    for await (const message of routeSerial(deps, ['opus'], '开始回答', 'user-1', threadId, {
      persistenceContext: replayContext,
      parentInvocationId: 'fixed-parent-replay',
    })) {
      replayed.push(message);
    }

    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 1);
    assert.equal(replayContext.egressByCat.opus.disposition, 'published');
    assert.equal(replayContext.egressByCat.opus.replayed, true);
    assert.equal(replayed.filter((message) => message.type === 'text').length, 0);
  });

  test('buffers ordinary tool detail until a fresh stdout verdict is published', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-tool-current';
    const { deps, messageStore, privateToolSentinel } = await createHarness({
      injectNewMessage: false,
      threadId,
      outputMode: 'tool',
    });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '调用工具', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-tool-current',
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

  test('drops ordinary tool detail when the final stdout verdict is held', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-tool-stale';
    const { deps, privateToolSentinel } = await createHarness({
      injectNewMessage: true,
      threadId,
      outputMode: 'tool',
    });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '调用工具', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-tool-stale',
    })) {
      yielded.push(message);
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
    assert.doesNotMatch(JSON.stringify(yielded), new RegExp(privateToolSentinel));
  });

  test('protected provider error never persists or exposes tool-only detail', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-tool-error';
    const { deps, messageStore, privateToolSentinel } = await createHarness({
      injectNewMessage: false,
      threadId,
      outputMode: 'error-tool',
    });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '调用工具', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-tool-error',
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

  test('does not publish routing hints derived from a held private draft', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-inline-hint';
    const { deps, messageStore, socketBroadcasts } = await createHarness({
      injectNewMessage: true,
      threadId,
      outputContent: '旧稿中间请 @codex 继续处理，但这段内容会被 Hold',
    });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };

    for await (const _message of routeSerial(deps, ['opus'], '开始回答', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-inline-hint',
    })) {
      // drain
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
    assert.equal(
      messageStore.getRecent(20).some((stored) => stored.userId === 'system' && stored.content.includes('@codex')),
      false,
    );
    assert.doesNotMatch(JSON.stringify(socketBroadcasts), /@codex/);
  });

  test('holds stale rich-block-only output before formal append and outbound handoff', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-rich-stale';
    const { deps, messageStore, holdStore, richBlock } = await createHarness({
      injectNewMessage: true,
      threadId,
      outputMode: 'rich',
    });
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '生成卡片', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-rich-stale',
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

  test('discarded rich-block-only output never enters PersistenceContext or the route stream', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const threadId = 'thread-freshness-rich-discarded';
    const { deps, richBlock } = await createHarness({
      injectNewMessage: false,
      threadId,
      outputMode: 'rich',
    });
    deps.freshnessGate = {
      async submit() {
        return { outcome: 'discarded', hold: { id: 'discarded-rich-serial' } };
      },
    };
    const persistenceContext = { failed: false, errors: [], egressByCat: {} };
    const yielded = [];

    for await (const message of routeSerial(deps, ['opus'], '生成卡片', 'user-1', threadId, {
      persistenceContext,
      parentInvocationId: 'parent-rich-discarded',
    })) {
      yielded.push(message);
    }

    assert.equal(persistenceContext.egressByCat.opus.disposition, 'discarded');
    assert.equal(persistenceContext.richBlocks, undefined, 'discarded rich blocks must not reach consumers');
    assert.doesNotMatch(
      JSON.stringify(yielded),
      new RegExp(richBlock.bodyMarkdown),
      'discarded rich payload must not enter the socket-consumable route stream',
    );
  });

  test('does not synthesize stale audio blocks before the freshness verdict', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { initVoiceBlockSynthesizer } = await import('../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js');
    const cacheDir = await mkdtemp(join(tmpdir(), 'freshness-held-tts-'));
    let synthesizeCalls = 0;
    initVoiceBlockSynthesizer(
      {
        getDefault() {
          return {
            id: 'freshness-test',
            model: 'test',
            async synthesize() {
              synthesizeCalls += 1;
              return {
                audio: Buffer.from('must-not-be-created'),
                format: 'wav',
                metadata: { provider: 'test', model: 'test', voice: 'test' },
              };
            },
          };
        },
      },
      cacheDir,
    );
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const threadId = 'thread-freshness-audio-stale';
      const { deps } = await createHarness({ injectNewMessage: true, threadId, outputMode: 'audio' });
      const persistenceContext = { failed: false, errors: [], egressByCat: {} };

      for await (const _message of routeSerial(deps, ['opus'], '生成语音', 'user-1', threadId, {
        persistenceContext,
        parentInvocationId: 'parent-audio-stale',
      })) {
        // drain
      }

      assert.equal(persistenceContext.egressByCat.opus.disposition, 'held');
      assert.equal(synthesizeCalls, 0, 'stale audio must not leave the gate through TTS');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
