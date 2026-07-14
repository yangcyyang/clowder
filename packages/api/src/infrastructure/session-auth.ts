import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {} from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const COOKIE_NAME = 'cat_cafe_session';
const TOKEN_BYTES = 32;
export const API_BEARER_TOKEN_ENV = 'CLOWDER_API_BEARER_TOKEN';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUserId?: string;
  }
}

const DEFAULT_MAX_SESSIONS = 10_000;

export class SessionStore {
  private sessions = new Map<string, string>();
  private maxSessions: number;

  constructor(opts?: { maxSessions?: number }) {
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  create(userId: string): string {
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.sessions.set(token, userId);
    return token;
  }

  validate(token: string): string | null {
    if (!token) return null;
    return this.sessions.get(token) ?? null;
  }
}

const globalStore = new SessionStore();

function resolveConfiguredBearerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[API_BEARER_TOKEN_ENV];
  if (raw === undefined) return undefined;
  const token = raw.trim();
  if (!token) {
    throw new Error(`${API_BEARER_TOKEN_ENV} must not be blank when configured`);
  }
  return token;
}

function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function extractBearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function resolveSessionUserIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  try {
    const token = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    return token ? globalStore.validate(token) : null;
  } catch {
    return null;
  }
}

export function isApiBearerAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfiguredBearerToken(env) !== undefined;
}

export function isApiBearerAuthorized(input: {
  authorization?: string;
  cookie?: string;
  env?: NodeJS.ProcessEnv;
  allowSessionCookie?: boolean;
}): boolean {
  const expected = resolveConfiguredBearerToken(input.env);
  if (expected === undefined) return true;

  const supplied = extractBearerToken(input.authorization);
  if (supplied && constantTimeTokenEquals(supplied, expected)) return true;

  // Browser delegation is deliberately restricted to WebSocket handshakes.
  // Normal HTTP /api/* requests must always present the configured bearer.
  return input.allowSessionCookie === true && resolveSessionUserIdFromCookieHeader(input.cookie) !== null;
}

function isApiPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? '';
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isSessionDelegatedWebSocketPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? '';
  return /^\/api\/terminal\/(?:sessions|agent-panes)\/[^/]+\/ws$/.test(pathname);
}

function apiBearerAuth(app: FastifyInstance, _opts: Record<string, never>, done: (error?: Error) => void) {
  try {
    // Validate once during startup so a present-but-empty secret fails closed.
    resolveConfiguredBearerToken();
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  app.addHook('onRequest', (request, reply, next) => {
    if (!isApiPath(request.url) || !isApiBearerAuthEnabled()) {
      next();
      return;
    }
    if (
      isApiBearerAuthorized({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        allowSessionCookie:
          request.headers.upgrade?.toLowerCase() === 'websocket' && isSessionDelegatedWebSocketPath(request.url),
      })
    ) {
      next();
      return;
    }
    void reply.code(401).send({ error: 'Unauthorized' });
  });

  done();
}

export const apiBearerAuthPlugin = fp(apiBearerAuth, {
  name: 'api-bearer-auth',
});

function sessionAuth(app: FastifyInstance, _opts: Record<string, never>, done: () => void) {
  app.decorateRequest('sessionUserId', undefined);

  app.addHook('onRequest', (request, _reply, next) => {
    const token = request.cookies?.[COOKIE_NAME];
    if (token) {
      const userId = globalStore.validate(token);
      if (userId) {
        request.sessionUserId = userId;
      }
    }
    next();
  });

  done();
}

export const sessionAuthPlugin = fp(sessionAuth, {
  name: 'session-auth',
  dependencies: ['@fastify/cookie'],
});

function sessionRoutePlugin(app: FastifyInstance, _opts: Record<string, never>, done: () => void) {
  app.get('/api/session', async (request, reply) => {
    if (request.sessionUserId) {
      return { userId: request.sessionUserId };
    }

    const fwdProto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim().toLowerCase();
    const isSecure = request.protocol === 'https' || fwdProto === 'https';
    const forwardedHost = (request.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
    const hostname = (forwardedHost || request.hostname).replace(/:\d+$/, '').toLowerCase();
    const sharedCloudDomain = hostname === 'clowder-ai.com' || hostname.endsWith('.clowder-ai.com');

    const token = globalStore.create('default-user');
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      ...(sharedCloudDomain ? { domain: '.clowder-ai.com' } : {}),
      ...(isSecure ? { secure: true } : {}),
    });
    return { userId: 'default-user' };
  });

  done();
}

export const sessionRoute = fp(sessionRoutePlugin, {
  name: 'session-route',
  dependencies: ['session-auth'],
});
