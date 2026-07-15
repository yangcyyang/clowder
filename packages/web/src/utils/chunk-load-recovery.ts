import { hasAnyPendingThreadDraft } from '@/components/thread-drafts';
import { CLIENT_WEB_BUILD_ID } from '@/utils/web-build-version';

const AUTOMATIC_RECOVERY_SESSION_KEY = 'clowder:automatic-recovery';
const reservedRecoveryTargets = new Set<string>();

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk \d+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;
const NEXT_STATIC_RESOURCE_RE = /\/_next\/static\/(?:chunks|css)\//i;

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function collectErrorText(reason: unknown): string {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}\n${reason.message}\n${reason.stack ?? ''}`;
  if (typeof reason === 'object') {
    const candidate = reason as { name?: unknown; message?: unknown; stack?: unknown; type?: unknown };
    return [candidate.name, candidate.message, candidate.stack, candidate.type]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }
  return '';
}

function collectResourceUrl(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return '';
  const target = (reason as { target?: unknown }).target;
  if (!target || typeof target !== 'object') return '';
  const candidate = target as { src?: unknown; href?: unknown };
  return [candidate.src, candidate.href].filter((value): value is string => typeof value === 'string').join('\n');
}

export function isRecoverableChunkLoadError(reason: unknown): boolean {
  return CHUNK_ERROR_RE.test(collectErrorText(reason)) || NEXT_STATIC_RESOURCE_RE.test(collectResourceUrl(reason));
}

export function hasUnsavedUserWork(documentRef?: Pick<Document, 'querySelectorAll'>): boolean {
  if (hasAnyPendingThreadDraft()) return true;
  const activeDocument = documentRef ?? (typeof document === 'undefined' ? undefined : document);
  if (!activeDocument) return false;
  return Array.from(activeDocument.querySelectorAll('textarea:not(:disabled)')).some(
    (textarea) => ((textarea as HTMLTextAreaElement).value ?? '').trim().length > 0,
  );
}

export function reserveAutomaticRecovery(storage: RecoveryStorage, targetBuildId: string, now = Date.now()): boolean {
  if (reservedRecoveryTargets.has(targetBuildId)) return false;
  reservedRecoveryTargets.add(targetBuildId);

  try {
    const rawRecord = storage.getItem(AUTOMATIC_RECOVERY_SESSION_KEY);
    if (rawRecord) {
      try {
        const record = JSON.parse(rawRecord) as { targetBuildId?: unknown };
        if (record?.targetBuildId === targetBuildId) return false;
      } catch {
        // Malformed records are equivalent to no prior recovery attempt.
      }
    }
    storage.setItem(AUTOMATIC_RECOVERY_SESSION_KEY, JSON.stringify({ targetBuildId, attemptedAt: now }));
  } catch {
    // The in-memory reservation above still keeps this target fail-closed.
  }
  return true;
}

export async function prepareBrowserForReload(windowRef: Window): Promise<void> {
  await Promise.allSettled([
    windowRef.navigator.serviceWorker
      ?.getRegistrations()
      .then((registrations) => Promise.allSettled(registrations.map((registration) => registration.update()))),
    'caches' in windowRef
      ? windowRef.caches.keys().then((keys) => Promise.allSettled(keys.map((key) => windowRef.caches.delete(key))))
      : Promise.resolve(),
  ]);
}

// Compatibility exports for the hydrated guard. A later task can replace the
// component without reintroducing cooldown or service-worker unregister semantics.
export function shouldAttemptChunkReload(storage: RecoveryStorage, now = Date.now()): boolean {
  return reserveAutomaticRecovery(storage, `chunk:${CLIENT_WEB_BUILD_ID}`, now);
}

export function markChunkReloadAttempt(windowRef: Window): boolean {
  if (hasUnsavedUserWork(windowRef.document)) return false;
  return reserveAutomaticRecovery(windowRef.sessionStorage, `chunk:${CLIENT_WEB_BUILD_ID}`);
}

export const clearStaleBrowserShell = prepareBrowserForReload;
