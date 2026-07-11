import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';

test('two-agent collision holds A, injects B, and publishes only A reviewed replacement', async () => {
  const { routeSerial } = await import('../../dist/domains/cats/services/agents/routing/route-serial.js');
  const { FreshnessEgressGate } = await import(
    '../../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'
  );
  const { FreshnessHoldStore } = await import('../../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');

  const threadId = 'two-agent-freshness-thread';
  const messageStore = new MessageStore();
  const holdStore = new FreshnessHoldStore({ maxReviews: 2 });
  const freshnessGate = new FreshnessEgressGate({ messageStore, holdStore });

  let releaseOriginal;
  let originalDraftReady;
  const originalDraftReadyPromise = new Promise((resolve) => {
    originalDraftReady = resolve;
  });
  const releaseOriginalPromise = new Promise((resolve) => {
    releaseOriginal = resolve;
  });
  const opusPrompts = [];
  let opusServiceCalls = 0;
  const opusService = {
    async *invoke(prompt) {
      opusPrompts.push(prompt);
      opusServiceCalls += 1;
      if (opusServiceCalls === 1) {
        yield {
          type: 'text',
          catId: 'opus',
          content: 'A 基于旧上下文的回答，不得发送',
          timestamp: Date.now(),
        };
        originalDraftReady();
        await releaseOriginalPromise;
      } else {
        yield {
          type: 'text',
          catId: 'opus',
          content: 'A 已结合 B 的新消息完成改写',
          timestamp: Date.now(),
        };
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const codexService = {
    async *invoke() {
      yield {
        type: 'text',
        catId: 'codex',
        content: 'B 在 A 生成期间追加的新约束',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };

  let invocationSequence = 0;
  const latestInvocationByCat = new Map();
  const invocationCat = new Map();
  const registry = {
    async create(_userId, catId) {
      const invocationId = `${catId}-invocation-${++invocationSequence}`;
      latestInvocationByCat.set(catId, invocationId);
      invocationCat.set(invocationId, catId);
      return { invocationId, callbackToken: `token-${invocationSequence}` };
    },
    async isLatest(invocationId) {
      return latestInvocationByCat.get(invocationCat.get(invocationId)) === invocationId;
    },
  };
  const deps = {
    services: { codex: codexService, opus: opusService },
    freshnessGate,
    messageStore,
    invocationDeps: {
      registry,
      sessionManager: {
        async getOrCreate() {
          return {};
        },
        async get() {
          return null;
        },
        resolveWorkingDirectory() {
          return '/tmp/freshness-two-agent';
        },
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
  };

  const firstContext = { failed: false, errors: [], egressByCat: {} };
  const firstYielded = [];
  const firstRun = (async () => {
    for await (const message of routeSerial(deps, ['opus'], '请 A 回答', 'user-1', threadId, {
      persistenceContext: firstContext,
      parentInvocationId: 'parent-original-a',
    })) {
      firstYielded.push(message);
    }
  })();

  await originalDraftReadyPromise;
  const bContext = { failed: false, errors: [], egressByCat: {} };
  const bYielded = [];
  for await (const message of routeSerial(deps, ['codex'], '请 B 补充新约束', 'user-1', threadId, {
    persistenceContext: bContext,
    parentInvocationId: 'parent-independent-b',
  })) {
    bYielded.push(message);
  }
  assert.equal(bContext.egressByCat.codex.disposition, 'published');
  assert.equal(bYielded.filter((message) => message.type === 'text').length, 1);
  const bMessage = messageStore.getById(bContext.egressByCat.codex.messageId);
  assert.ok(bMessage);
  releaseOriginal();
  await firstRun;

  assert.equal(firstContext.egressByCat.opus.disposition, 'held');
  assert.deepEqual(firstContext.egressByCat.opus.unseenMessageIds, [bMessage.id]);
  assert.equal(
    firstYielded.some((message) => message.type === 'text'),
    false,
  );
  assert.equal(
    messageStore.getRecent(20).some((message) => message.content.includes('基于旧上下文')),
    false,
  );

  const reviewPayload = firstContext.egressByCat.opus.freshnessReview;
  assert.ok(reviewPayload, 'held stdout must provide a bounded successor review envelope');
  const reviewContext = { failed: false, errors: [], egressByCat: {}, freshnessReview: reviewPayload };
  const reviewYielded = [];
  for await (const message of routeSerial(deps, ['opus'], 'Freshness review pending', 'user-1', threadId, {
    persistenceContext: reviewContext,
    parentInvocationId: 'parent-reviewed-a',
  })) {
    reviewYielded.push(message);
  }

  assert.match(opusPrompts[1], /A 基于旧上下文的回答/);
  assert.match(opusPrompts[1], /B 在 A 生成期间追加的新约束/);
  assert.equal(reviewContext.egressByCat.opus.disposition, 'published');
  assert.equal(reviewYielded.filter((message) => message.type === 'text').length, 1);
  assert.equal(reviewYielded.find((message) => message.type === 'text').content, 'A 已结合 B 的新消息完成改写');
  assert.deepEqual(
    messageStore
      .getRecent(20)
      .filter((message) => message.catId)
      .map((message) => message.content),
    ['B 在 A 生成期间追加的新约束', 'A 已结合 B 的新消息完成改写'],
  );
});
