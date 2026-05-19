// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { auditRoutes } from '../dist/routes/audit.js';

function stubThreadStore(threads = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
  };
}

describe('audit route HTTP-level access control', () => {
  let app;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(threads, auditLog) {
    app = Fastify();
    await app.register(auditRoutes, { threadStore: stubThreadStore(threads), ...(auditLog ? { auditLog } : {}) });
    await app.ready();
    return app;
  }

  it('returns 200 for owner accessing their own thread', async () => {
    await buildApp({ 'thread-123': { id: 'thread-123', createdBy: 'user-alice' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-123',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('returns 403 for non-owner accessing the shared default thread (owner unconfigured)', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    await buildApp({ default: { id: 'default', createdBy: 'system' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/default',
      headers: { 'x-cat-cafe-user': 'user-bob' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 200 for configured owner accessing the shared default thread', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'owner-admin';
    await buildApp({ default: { id: 'default', createdBy: 'system' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/default',
      headers: { 'x-cat-cafe-user': 'owner-admin' },
    });
    delete process.env.DEFAULT_OWNER_USER_ID;
    assert.equal(res.statusCode, 200);
  });

  it('returns 401 for unauthenticated request', async () => {
    await buildApp({ 'thread-123': { id: 'thread-123', createdBy: 'user-alice' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-123',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 for non-default system-owned thread', async () => {
    await buildApp({ 'thread-sys': { id: 'thread-sys', createdBy: 'system' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-sys',
      headers: { 'x-cat-cafe-user': 'user-bob' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Access denied');
  });

  it('returns 403 for another user accessing someone else thread', async () => {
    await buildApp({ 'thread-456': { id: 'thread-456', createdBy: 'user-alice' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/thread-456',
      headers: { 'x-cat-cafe-user': 'user-eve' },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Access denied');
  });

  it('returns 404 for missing thread', async () => {
    await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/thread/nonexistent',
      headers: { 'x-cat-cafe-user': 'user-alice' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Thread not found');
  });

  it('lists dangerous action audit events with action/result filters', async () => {
    const auditLog = {
      readByDate: async () => [
        {
          id: 'danger-1',
          type: 'dangerous_action',
          timestamp: 1000,
          data: {
            actorId: 'owner-admin',
            action: 'thread.delete',
            targetType: 'thread',
            targetId: 't1',
            result: 'blocked',
            severity: 'critical',
            confirmation: 'not_required',
          },
        },
        {
          id: 'danger-2',
          type: 'dangerous_action',
          timestamp: 2000,
          data: {
            actorId: 'owner-admin',
            action: 'queue.clear',
            targetType: 'queue',
            targetId: 't2',
            result: 'succeeded',
            severity: 'high',
            confirmation: 'ui_confirmed',
          },
        },
        { id: 'other-1', type: 'server_started', timestamp: 3000, data: {} },
      ],
      readByThread: async () => [],
      listFiles: async () => ['audit-2026-05-19.ndjson'],
      getLogPath: () => '/tmp/audit-2026-05-19.ndjson',
    };
    await buildApp({}, auditLog);

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/dangerous-actions?date=2026-05-19&action=thread.delete&result=blocked',
      headers: { 'x-cat-cafe-user': 'owner-admin' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.total, 1);
    assert.equal(body.events[0].id, 'danger-1');
    assert.deepEqual(body.actions, ['queue.clear', 'thread.delete']);
    assert.deepEqual(body.results, ['blocked', 'succeeded']);
  });

  it('requires identity for global dangerous audit list', async () => {
    await buildApp(
      {},
      {
        readByDate: async () => [],
        readByThread: async () => [],
        listFiles: async () => [],
        getLogPath: () => '/tmp/audit.ndjson',
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/dangerous-actions?date=2026-05-19',
    });
    assert.equal(res.statusCode, 401);
  });
});
