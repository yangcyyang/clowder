import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

function record(overrides) {
  return {
    id: overrides.id ?? randomUUID(),
    threadId: 'default',
    userId: 'owner',
    userMessageId: null,
    targetCats: ['codex'],
    intent: 'execute',
    status: 'succeeded',
    phase: 'done',
    idempotencyKey: 'k',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('runtime traffic light route', () => {
  async function createApp(records, now = 1_000_000) {
    const { runtimeTrafficLightRoutes } = await import('../dist/routes/runtime-traffic-light.js');
    const app = Fastify();
    await app.register(runtimeTrafficLightRoutes, {
      now: () => now,
      invocationRecordStore: {
        async scanAll() {
          return records;
        },
      },
    });
    await app.ready();
    return app;
  }

  it('returns running when any invocation is running', async () => {
    const app = await createApp([record({ status: 'running', updatedAt: 100 })]);
    const res = await app.inject({ method: 'GET', url: '/api/runtime/traffic-light' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.state, 'running');
    assert.equal(body.runningCount, 1);
    assert.equal(body.queuedCount, 0);
    await app.close();
  });

  it('returns running when queue has pending invocation records', async () => {
    const app = await createApp([record({ status: 'queued', updatedAt: 100 })]);
    const res = await app.inject({ method: 'GET', url: '/api/runtime/traffic-light' });
    const body = res.json();
    assert.equal(body.state, 'running');
    assert.equal(body.runningCount, 0);
    assert.equal(body.queuedCount, 1);
    await app.close();
  });

  it('returns error for a recent failed invocation when nothing is running', async () => {
    const app = await createApp([record({ status: 'failed', updatedAt: 990_000 })], 1_000_000);
    const res = await app.inject({ method: 'GET', url: '/api/runtime/traffic-light' });
    const body = res.json();
    assert.equal(body.state, 'error');
    assert.equal(body.failedCount, 1);
    assert.equal(body.lastStatus, 'failed');
    await app.close();
  });

  it('returns idle after a successful completion', async () => {
    const app = await createApp([record({ status: 'succeeded', updatedAt: 900_000, targetCats: ['claude'] })]);
    const res = await app.inject({ method: 'GET', url: '/api/runtime/traffic-light' });
    const body = res.json();
    assert.equal(body.state, 'idle');
    assert.equal(body.lastAgent, 'claude');
    assert.equal(body.lastStatus, 'succeeded');
    assert.equal(typeof body.lastCompletedAt, 'string');
    await app.close();
  });
});
