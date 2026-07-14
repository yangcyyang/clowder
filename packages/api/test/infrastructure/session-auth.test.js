/**
 * F156 Phase D-1: HTTP Session Authentication
 *
 * P1-1 fix: session plugin only validates existing cookies, never auto-mints.
 * Session establishment happens exclusively via GET /api/session.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';

const { SessionStore: LocalSessionStore } = await import('../../dist/infrastructure/session-auth.js');
const { apiBearerAuthPlugin, isApiBearerAuthorized, sessionAuthPlugin, sessionRoute } = await import(
  '../../dist/infrastructure/session-auth.js'
);

const API_BEARER_ENV = 'CLOWDER_API_BEARER_TOKEN';

async function createAuthApp() {
  const app = Fastify();
  await app.register(apiBearerAuthPlugin);
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);
  app.get('/api/test', async (request) => ({ sessionUserId: request.sessionUserId ?? null }));
  app.get('/apiary', async () => ({ ok: true }));
  app.get('/health', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('F156 D-1: LocalSessionStore', () => {
  it('create returns a token and stores userId', () => {
    const store = new LocalSessionStore();
    const token = store.create('alice');
    assert.ok(typeof token === 'string');
    assert.ok(token.length >= 32, 'token must be at least 32 chars');
    assert.equal(store.validate(token), 'alice');
  });

  it('validate returns null for unknown token', () => {
    const store = new LocalSessionStore();
    assert.equal(store.validate('bogus'), null);
  });

  it('validate returns null for empty string', () => {
    const store = new LocalSessionStore();
    assert.equal(store.validate(''), null);
  });
});

describe('F156 D-1: Session Auth Plugin — no auto-mint', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute);
    app.get('/api/test', async (request) => ({
      sessionUserId: request.sessionUserId ?? null,
    }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('request without cookie gets NO sessionUserId (trust boundary)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.sessionUserId, null, 'anonymous request must not auto-get identity');
    assert.ok(!res.headers['set-cookie'], 'must NOT auto-issue cookie on business route');
  });

  it('invalid cookie gets NO sessionUserId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { cookie: 'cat_cafe_session=invalid-garbage' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.sessionUserId, null, 'invalid cookie must not produce identity');
  });
});

describe('F156 D-1: SessionStore eviction', () => {
  it('evicts oldest token when capacity is exceeded', () => {
    const store = new LocalSessionStore({ maxSessions: 3 });
    const t1 = store.create('user-1');
    const t2 = store.create('user-2');
    const t3 = store.create('user-3');
    assert.equal(store.validate(t1), 'user-1');

    const t4 = store.create('user-4');
    assert.equal(store.validate(t1), null, 'oldest token should be evicted');
    assert.equal(store.validate(t2), 'user-2');
    assert.equal(store.validate(t3), 'user-3');
    assert.equal(store.validate(t4), 'user-4');
  });
});

describe('F156 D-1: GET /api/session — session establishment', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute);
    app.get('/api/test', async (request) => ({
      sessionUserId: request.sessionUserId ?? null,
    }));
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('creates session and sets HttpOnly/SameSite=Strict cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'must set cookie on session establishment');
    assert.ok(setCookie.includes('cat_cafe_session='), 'cookie name');
    assert.ok(setCookie.includes('HttpOnly'), 'must be HttpOnly');
    assert.ok(setCookie.includes('SameSite=Strict'), 'must be SameSite=Strict');
    assert.ok(setCookie.includes('Path=/'), 'must have Path=/');
    const body = JSON.parse(res.body);
    assert.equal(body.userId, 'default-user');
  });

  it('sets Secure flag when request has X-Forwarded-Proto: https', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'must set cookie');
    assert.ok(setCookie.includes('Secure'), 'must have Secure flag behind HTTPS proxy');
  });

  it('shares the session cookie across Clowder Web/API subdomains', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: {
        host: '127.0.0.1:3004',
        'x-forwarded-host': 'cafe.clowder-ai.com',
        'x-forwarded-proto': 'https',
      },
    });
    const setCookie = response.headers['set-cookie'];
    assert.match(setCookie, /Domain=\.clowder-ai\.com/i);
    assert.match(setCookie, /Secure/i);
  });

  it('sets Secure flag for chained proxy header "https, http"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'must set cookie');
    assert.ok(setCookie.includes('Secure'), 'chained proxy starting with https must set Secure');
  });

  it('handles array-valued X-Forwarded-Proto without crashing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { 'x-forwarded-proto': ['https', 'http'] },
    });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'must set cookie');
    assert.ok(setCookie.includes('Secure'), 'array starting with https must set Secure');
  });

  it('omits Secure flag on plain HTTP localhost (dev mode)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'must set cookie');
    assert.ok(!setCookie.includes('Secure'), 'must NOT have Secure on plain HTTP');
  });

  it('subsequent request with established cookie gets sessionUserId', async () => {
    const pair = await app.inject({ method: 'GET', url: '/api/session' });
    const cookieHeader = pair.headers['set-cookie'];
    const token = cookieHeader.match(/cat_cafe_session=([^;]+)/)?.[1];
    assert.ok(token);

    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { cookie: `cat_cafe_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.sessionUserId, 'default-user');
  });

  it('returns existing session if cookie already valid', async () => {
    const pair = await app.inject({ method: 'GET', url: '/api/session' });
    const token = pair.headers['set-cookie'].match(/cat_cafe_session=([^;]+)/)?.[1];

    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: `cat_cafe_session=${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.headers['set-cookie'], 'should not re-issue cookie for valid session');
    const body = JSON.parse(res.body);
    assert.equal(body.userId, 'default-user');
  });
});

describe('P1 API bearer fallback', () => {
  const originalToken = process.env[API_BEARER_ENV];

  after(() => {
    if (originalToken === undefined) delete process.env[API_BEARER_ENV];
    else process.env[API_BEARER_ENV] = originalToken;
  });

  it('keeps legacy single-user behavior when the env token is unset', async () => {
    delete process.env[API_BEARER_ENV];
    const app = await createAuthApp();
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/test' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('protects every /api/* route with one generic 401 and accepts the exact bearer', async () => {
    process.env[API_BEARER_ENV] = 'server-only-secret';
    const app = await createAuthApp();
    try {
      for (const authorization of [undefined, 'Basic abc', 'Bearer wrong', 'Bearer server-only-secret-extra']) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          ...(authorization ? { headers: { authorization } } : {}),
        });
        assert.equal(res.statusCode, 401);
        assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' });
        assert.equal(res.headers['www-authenticate'], undefined);
        assert.ok(!res.body.includes('server-only-secret'));
      }

      const accepted = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { authorization: 'Bearer server-only-secret' },
      });
      assert.equal(accepted.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('does not overmatch non-/api paths', async () => {
    process.env[API_BEARER_ENV] = 'server-only-secret';
    const app = await createAuthApp();
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/apiary' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('rejects a bearer-minted session cookie on ordinary HTTP while allowing explicit WebSocket delegation', async () => {
    process.env[API_BEARER_ENV] = 'server-only-secret';
    const app = await createAuthApp();
    try {
      const session = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { authorization: 'Bearer server-only-secret' },
      });
      assert.equal(session.statusCode, 200);
      const token = session.headers['set-cookie']?.match(/cat_cafe_session=([^;]+)/)?.[1];
      assert.ok(token);

      const delegated = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `cat_cafe_session=${token}` },
      });
      assert.equal(delegated.statusCode, 401);
      assert.deepEqual(JSON.parse(delegated.body), { error: 'Unauthorized' });

      const forgedUpgrade = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: {
          cookie: `cat_cafe_session=${token}`,
          upgrade: 'websocket',
        },
      });
      assert.equal(forgedUpgrade.statusCode, 401, 'Upgrade alone must not bypass bearer auth on an ordinary API route');

      const cookieHeader = `cat_cafe_session=${token}`;
      assert.equal(
        isApiBearerAuthorized({ cookie: cookieHeader, env: process.env }),
        false,
        'session cookie must not authorize normal HTTP',
      );
      assert.equal(
        isApiBearerAuthorized({ cookie: cookieHeader, env: process.env, allowSessionCookie: true }),
        true,
        'the server may explicitly delegate a bearer-minted session to a WebSocket handshake',
      );
    } finally {
      await app.close();
    }
  });

  it('fails closed when the token env is present but blank', async () => {
    process.env[API_BEARER_ENV] = '   ';
    const app = Fastify();
    await assert.rejects(
      app.register(apiBearerAuthPlugin).then(() => app.ready()),
      /must not be blank/i,
    );
    await app.close();
  });
});
