import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { FreshnessHoldStore } from '../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js';
import { freshnessHoldsRoutes } from '../dist/routes/freshness-holds.js';

const NOW = 1_700_000_000_000;

function input(overrides = {}) {
  return {
    invocationId: 'route-invocation',
    submissionKey: 'route-submission',
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    baselineWatermark: '10',
    observedWatermark: '12',
    deltaMessageIds: ['secret-delta-message-id'],
    draft: {
      content: 'TOP-SECRET-HELD-DRAFT',
      richBlocks: [{ id: 'secret-card', bodyMarkdown: 'SECRET-RICH-BODY' }],
    },
    createdAt: NOW,
    reviewDeadlineAt: NOW + 60_000,
    ...overrides,
  };
}

describe('GET /api/freshness-holds', () => {
  let app;

  afterEach(async () => {
    await app?.close();
  });

  it('returns only current-user active metadata and never exposes held draft data', async () => {
    const store = new FreshnessHoldStore();
    const own = await store.createOrGet(input());
    await store.createOrGet(
      input({ invocationId: 'other-user-inv', submissionKey: 'other-user-sub', userId: 'user-2' }),
    );
    await store.createOrGet(
      input({ invocationId: 'other-thread-inv', submissionKey: 'other-thread-sub', threadId: 'thread-2' }),
    );
    app = Fastify();
    await app.register(freshnessHoldsRoutes, { holdStore: store });

    const response = await app.inject({
      method: 'GET',
      url: '/api/freshness-holds?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      holds: [
        {
          id: own.hold.id,
          catId: 'opus',
          threadId: 'thread-1',
          status: 'held',
          version: 1,
          reviewCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
          reviewDeadlineAt: NOW + 60_000,
        },
      ],
    });
    assert.doesNotMatch(response.body, /TOP-SECRET|SECRET-RICH|secret-delta|draft|content|deltaMessageIds/);
  });

  it('requires identity and a valid threadId', async () => {
    app = Fastify();
    await app.register(freshnessHoldsRoutes, { holdStore: new FreshnessHoldStore() });

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/freshness-holds?threadId=thread-1' });
    assert.equal(unauthenticated.statusCode, 401);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/freshness-holds?threadId=',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(invalid.statusCode, 400);
  });
});
