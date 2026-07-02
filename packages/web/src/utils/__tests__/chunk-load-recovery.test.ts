import { describe, expect, it, vi } from 'vitest';
import { clearStaleBrowserShell, isRecoverableChunkLoadError, shouldAttemptChunkReload } from '../chunk-load-recovery';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('chunk-load-recovery', () => {
  it('recognizes stale Next/Vite chunk loading failures', () => {
    expect(isRecoverableChunkLoadError(new Error('Loading chunk 1234 failed.'))).toBe(true);
    expect(isRecoverableChunkLoadError('Failed to fetch dynamically imported module: /_next/static/chunks/app.js')).toBe(
      true,
    );
    expect(isRecoverableChunkLoadError(new TypeError('ordinary request failed'))).toBe(false);
  });

  it('only allows one automatic reload during the cooldown window', () => {
    const storage = memoryStorage();

    expect(shouldAttemptChunkReload(storage, 1000)).toBe(true);
    expect(shouldAttemptChunkReload(storage, 2000)).toBe(false);
    expect(shouldAttemptChunkReload(storage, 130_000)).toBe(true);
  });

  it('clears service workers and caches before reload', async () => {
    const unregister = vi.fn(() => Promise.resolve(true));
    const cacheDelete = vi.fn(() => Promise.resolve(true));
    const windowRef = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([{ unregister }]),
        },
      },
      caches: {
        keys: () => Promise.resolve(['old-shell']),
        delete: cacheDelete,
      },
    } as unknown as Window;

    await clearStaleBrowserShell(windowRef);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('old-shell');
  });
});
