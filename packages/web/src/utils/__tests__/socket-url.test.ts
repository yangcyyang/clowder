import { afterEach, describe, expect, it, vi } from 'vitest';

const ensureSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../api-client', () => ({
  API_URL: 'http://legacy-api:3004',
  ensureSession: ensureSessionMock,
}));

import { ensureSocketSession, resolveSocketUrl } from '../socket-url';

describe('resolveSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    ensureSessionMock.mockClear();
  });

  it('keeps the legacy API URL when bearer proxy mode is disabled', () => {
    expect(
      resolveSocketUrl(
        { protocol: 'http:', hostname: 'localhost', port: '5102' },
        { NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '0' },
      ),
    ).toBe('http://legacy-api:3004');
  });

  it('uses the direct API port while HTTP stays on the Web proxy', () => {
    expect(
      resolveSocketUrl(
        { protocol: 'http:', hostname: 'localhost', port: '5102' },
        {
          NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '1',
          NEXT_PUBLIC_API_URL: 'http://localhost:3102',
        },
      ),
    ).toBe('http://localhost:3102');
  });

  it('aligns a configured loopback host with the browser hostname so its host-only cookie is sent', () => {
    expect(
      resolveSocketUrl(
        { protocol: 'http:', hostname: 'localhost', port: '5102' },
        {
          NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '1',
          NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3102',
        },
      ),
    ).toBe('http://localhost:3102');

    expect(
      resolveSocketUrl(
        { protocol: 'http:', hostname: '127.0.0.1', port: '5102' },
        {
          NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '1',
          NEXT_PUBLIC_API_URL: 'http://localhost:3102',
        },
      ),
    ).toBe('http://127.0.0.1:3102');
  });

  it('keeps the browser hostname when deriving the adjacent API port', () => {
    expect(
      resolveSocketUrl(
        { protocol: 'http:', hostname: 'localhost', port: '5102' },
        { NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '1' },
      ),
    ).toBe('http://localhost:5103');
  });

  it('uses the API subdomain for Cloudflare Web access', () => {
    expect(
      resolveSocketUrl(
        { protocol: 'https:', hostname: 'cafe.clowder-ai.com', port: '' },
        { NEXT_PUBLIC_API_AUTH_PROXY_ENABLED: '1' },
      ),
    ).toBe('https://api.clowder-ai.com');
  });

  it('waits for the bearer-derived browser session only when proxy auth is enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_AUTH_PROXY_ENABLED', '0');
    await ensureSocketSession();
    expect(ensureSessionMock).not.toHaveBeenCalled();

    vi.stubEnv('NEXT_PUBLIC_API_AUTH_PROXY_ENABLED', '1');
    await ensureSocketSession();
    expect(ensureSessionMock).toHaveBeenCalledOnce();
  });
});
