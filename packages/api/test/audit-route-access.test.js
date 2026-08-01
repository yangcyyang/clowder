// @ts-check
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { auditRoutes } from '../dist/routes/audit.js';

describe('audit route access control', () => {
  const savedOwner = process.env.DEFAULT_OWNER_USER_ID;
  const threads = new Map([
    ['thread-123', { id: 'thread-123', createdBy: 'user-alice' }],
    ['thread-system-private', { id: 'thread-system-private', createdBy: 'system' }],
  ]);
  let app;

  before(async () => {
    app = Fastify();
    await app.register(auditRoutes, {
      threadStore: { get: async (threadId) => threads.get(threadId) ?? null },
      auditLog: {
        readByThread: async () => [],
        readByDate: async () => [],
        listFiles: async () => [],
        getLogPath: () => '/tmp/audit',
      },
    });
    await app.ready();
  });

  afterEach(() => {
    if (savedOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = savedOwner;
  });

  after(async () => {
    await app.close();
  });

  it('allows the thread owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-123',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('allows the configured installation owner', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'installation-owner';
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-system-private',
      headers: { 'x-cat-cafe-user': 'installation-owner' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('forbids another user', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-123',
      headers: { 'x-cat-cafe-user': 'user-eve' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('rejects requests without identity', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/audit/thread/thread-123' });
    assert.equal(response.statusCode, 401);
  });

  it('returns 404 for an unknown thread', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/missing',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(response.statusCode, 404);
  });
});
