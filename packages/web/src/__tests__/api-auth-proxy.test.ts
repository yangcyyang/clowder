import { describe, expect, it } from 'vitest';
import { buildApiProxyRequestHeaders, config } from '../middleware';

describe('API bearer Web proxy', () => {
  it('overwrites a browser-supplied Authorization header with the server-only token', () => {
    const headers = buildApiProxyRequestHeaders(new Headers({ authorization: 'Bearer attacker' }), 'server-secret');
    expect(headers.get('authorization')).toBe('Bearer server-secret');
  });

  it('preserves legacy headers when the token is unset', () => {
    const headers = buildApiProxyRequestHeaders(new Headers({ 'x-request-id': 'req-1' }), undefined);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-request-id')).toBe('req-1');
  });

  it('covers API paths without intercepting Socket.IO upgrades or exposing the token', () => {
    expect(config.matcher).toEqual(['/api/:path*']);
    expect(JSON.stringify(config)).not.toContain('server-secret');
  });
});
