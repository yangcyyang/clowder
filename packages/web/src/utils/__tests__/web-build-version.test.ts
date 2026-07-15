import { describe, expect, it, vi } from 'vitest';

import { fetchServerBuildId } from '../web-build-version';

describe('fetchServerBuildId', () => {
  it('returns null for 503, invalid JSON and empty build ids', async () => {
    await expect(fetchServerBuildId(async () => new Response('down', { status: 503 }))).resolves.toBeNull();
    await expect(fetchServerBuildId(async () => new Response('{bad'))).resolves.toBeNull();
    await expect(fetchServerBuildId(async () => Response.json({ buildId: '   ' }))).resolves.toBeNull();
  });

  it('accepts only a non-empty build id from a no-store request', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ buildId: 'build-b' }));

    await expect(fetchServerBuildId(fetchImpl)).resolves.toBe('build-b');
    expect(fetchImpl).toHaveBeenCalledWith('/_clowder/build-id', expect.objectContaining({ cache: 'no-store' }));
  });
});
