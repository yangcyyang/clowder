const CHUNK_RELOAD_SESSION_KEY = 'clowder:chunk-load-reload-at';
const CHUNK_RELOAD_COOLDOWN_MS = 2 * 60 * 1000;

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk \d+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

function collectErrorText(reason: unknown): string {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}\n${reason.message}\n${reason.stack ?? ''}`;
  if (typeof reason === 'object') {
    const candidate = reason as { name?: unknown; message?: unknown; stack?: unknown; type?: unknown; target?: unknown };
    const target = candidate.target as { src?: unknown; href?: unknown } | undefined;
    return [candidate.name, candidate.message, candidate.stack, candidate.type, target?.src, target?.href]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }
  return '';
}

export function isRecoverableChunkLoadError(reason: unknown): boolean {
  return CHUNK_ERROR_RE.test(collectErrorText(reason));
}

export function shouldAttemptChunkReload(storage: Pick<Storage, 'getItem' | 'setItem'>, now = Date.now()): boolean {
  const previous = Number(storage.getItem(CHUNK_RELOAD_SESSION_KEY) ?? 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  storage.setItem(CHUNK_RELOAD_SESSION_KEY, String(now));
  return true;
}

export function markChunkReloadAttempt(windowRef: Window): boolean {
  try {
    return shouldAttemptChunkReload(windowRef.sessionStorage);
  } catch {
    return true;
  }
}

export async function clearStaleBrowserShell(windowRef: Window): Promise<void> {
  await Promise.allSettled([
    windowRef.navigator.serviceWorker?.getRegistrations().then((registrations) =>
      Promise.allSettled(registrations.map((registration) => registration.unregister())),
    ),
    'caches' in windowRef
      ? windowRef.caches.keys().then((keys) => Promise.allSettled(keys.map((key) => windowRef.caches.delete(key))))
      : Promise.resolve(),
  ]);
}
