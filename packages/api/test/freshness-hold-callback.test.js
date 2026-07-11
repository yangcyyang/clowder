import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('callback Freshness Hold', () => {
  let InvocationRegistry;
  let MessageStore;
  let FreshnessHoldStore;
  let FreshnessEgressGate;
  let callbacksRoutes;
  let registry;
  let messageStore;
  let holdStore;
  let gate;
  let broadcasts;
  let outbound;

  beforeEach(async () => {
    ({ InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js'));
    ({ FreshnessEgressGate } = await import('../dist/domains/cats/services/agents/freshness/FreshnessEgressGate.js'));
    ({ callbacksRoutes } = await import('../dist/routes/callbacks.js'));
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    holdStore = new FreshnessHoldStore({ maxReviews: 2 });
    gate = new FreshnessEgressGate({ messageStore, holdStore });
    broadcasts = [];
    outbound = [];
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      freshnessGate: gate,
      socketManager: {
        broadcastAgentMessage(message) {
          broadcasts.push(message);
        },
      },
      outboundHook: {
        async deliver(...args) {
          outbound.push(args);
        },
      },
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: {
        submit: async (marker) => ({ id: 'marker-1', createdAt: new Date().toISOString(), ...marker }),
        list: async () => [],
        transition: async () => {},
      },
    });
    return app;
  }

  async function createInvocation(threadId = 'freshness-callback-thread') {
    const baseline = await messageStore.captureFreshnessWatermark(threadId, { kind: 'cat', catId: 'opus' });
    const credentials = await registry.create('user-1', 'opus', threadId, undefined, undefined, {
      freshnessBaseline: baseline,
    });
    return { ...credentials, baseline, threadId };
  }

  function headers(credentials) {
    return {
      'x-invocation-id': credentials.invocationId,
      'x-callback-token': credentials.callbackToken,
    };
  }

  test('new queued message holds callback before persistence and fanout, then retries the same hold', async () => {
    const app = await createApp();
    const invocation = await createInvocation();
    const newer = messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: invocation.threadId,
      content: '生成期间补充的新要求',
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });

    const request = {
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(invocation),
      payload: { content: '基于旧上下文的回答', clientMessageId: 'freshness-callback-1' },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);

    const body = JSON.parse(first.body);
    const replayBody = JSON.parse(replay.body);
    assert.equal(body.status, 'freshness_held');
    assert.equal(body.disposition, 'held');
    assert.equal(typeof body.holdId, 'string');
    assert.equal(replayBody.holdId, body.holdId);
    assert.deepEqual(
      body.newMessages.map((message) => message.id),
      [newer.id],
    );
    assert.equal(broadcasts.length, 0);
    assert.equal(outbound.length, 0);
    assert.equal(messageStore.getRecent(20).filter((message) => message.catId === 'opus').length, 0);
  });

  test('current baseline publishes and an LLM callback cannot self-declare a status exemption', async () => {
    const app = await createApp();
    const current = await createInvocation('freshness-current-thread');
    const published = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(current),
      payload: { content: '当前回答', clientMessageId: 'freshness-current-1' },
    });
    assert.equal(JSON.parse(published.body).disposition, 'published');

    const statusInvocation = await createInvocation('freshness-status-thread');
    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: statusInvocation.threadId,
      content: '实质新消息',
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const status = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(statusInvocation),
      payload: {
        content: '仍在处理中',
        clientMessageId: 'freshness-status-1',
        messageClass: 'status',
      },
    });
    assert.equal(status.statusCode, 400);
    assert.equal(JSON.parse(status.body).error, 'Invalid request body');
  });

  test('retrying a current callback submission fans out the published message exactly once', async () => {
    const app = await createApp();
    const invocation = await createInvocation('freshness-current-retry-thread');
    const request = {
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(invocation),
      payload: { content: '只应发布一次', clientMessageId: 'freshness-current-retry-1' },
    };

    const [first, concurrentReplay] = await Promise.all([app.inject(request), app.inject(request)]);
    const replay = await app.inject(request);

    assert.deepEqual([JSON.parse(first.body).status, JSON.parse(concurrentReplay.body).status].sort(), [
      'duplicate',
      'ok',
    ]);
    assert.equal(JSON.parse(replay.body).status, 'duplicate');
    assert.equal(messageStore.getRecent(20).filter((message) => message.content === '只应发布一次').length, 1);
    assert.equal(broadcasts.length, 1, 'the persisted message must only be broadcast once');
    assert.equal(outbound.length, 1, 'the persisted message must only reach connector outbound once');
  });

  test('review send_draft releases the held envelope exactly once', async () => {
    const app = await createApp();
    const invocation = await createInvocation('freshness-review-thread');
    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: invocation.threadId,
      content: '触发 hold 的新消息',
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const heldResponse = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(invocation),
      payload: { content: '待复核原稿', clientMessageId: 'freshness-review-submit' },
    });
    const held = JSON.parse(heldResponse.body);
    assert.equal(held.status, 'freshness_held');

    const reviewRequest = {
      method: 'POST',
      url: `/api/callbacks/freshness-holds/${held.holdId}/review`,
      headers: headers(invocation),
      payload: {
        action: 'send_draft',
        expectedVersion: held.freshness.version,
        clientMessageId: 'freshness-review-1',
      },
    };
    const [reviewed, concurrentReplay] = await Promise.all([app.inject(reviewRequest), app.inject(reviewRequest)]);
    assert.equal(reviewed.statusCode, 200);
    assert.equal(concurrentReplay.statusCode, 200);
    assert.deepEqual([JSON.parse(reviewed.body).status, JSON.parse(concurrentReplay.body).status].sort(), [
      'duplicate',
      'ok',
    ]);
    assert.equal(messageStore.getRecent(20).filter((message) => message.content === '待复核原稿').length, 1);

    const replayed = await app.inject(reviewRequest);
    assert.equal(JSON.parse(replayed.body).status, 'duplicate');
    assert.equal(messageStore.getRecent(20).filter((message) => message.content === '待复核原稿').length, 1);
    assert.equal(broadcasts.length, 1, 'terminal review replay must not rebroadcast');
    assert.equal(outbound.length, 1, 'terminal review replay must not repeat connector outbound');
  });

  test('protected create-rich-block stays private until the callback publication verdict', async () => {
    const app = await createApp();
    const invocation = await createInvocation('freshness-rich-callback-thread');
    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: invocation.threadId,
      content: '富文本生成期间的新要求',
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-rich-block',
      headers: headers(invocation),
      payload: {
        block: {
          id: 'freshness-private-card',
          kind: 'card',
          v: 1,
          title: '旧稿卡片',
          bodyMarkdown: '这个卡片不能在 verdict 前外泄',
        },
      },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(broadcasts.length, 0, 'protected rich block must remain in the invocation buffer');

    const posted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: headers(invocation),
      payload: { content: '携带卡片的旧回答', clientMessageId: 'freshness-rich-submit' },
    });
    const held = JSON.parse(posted.body);
    assert.equal(held.status, 'freshness_held');
    assert.equal(broadcasts.length, 0);

    const hold = await holdStore.get(held.holdId);
    assert.equal(hold.draft.extra.rich.blocks[0].id, 'freshness-private-card');
  });
});
