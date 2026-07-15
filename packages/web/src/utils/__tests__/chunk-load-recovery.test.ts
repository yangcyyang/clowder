import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installThreadDraftBridge,
  threadDrafts,
  threadFileDrafts,
  threadImageDrafts,
} from '../../components/thread-drafts';
import {
  hasUnsavedUserWork,
  isRecoverableChunkLoadError,
  prepareBrowserForReload,
  reserveAutomaticRecovery,
} from '../chunk-load-recovery';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

afterEach(() => {
  threadDrafts.clear();
  threadImageDrafts.clear();
  threadFileDrafts.clear();
  document.body.replaceChildren();
  delete window.__CLOWDER_HAS_PENDING_DRAFT__;
});

describe('chunk-load-recovery', () => {
  it('recognizes only Next chunk/css resource failures', () => {
    expect(isRecoverableChunkLoadError(new Error('Loading chunk 1234 failed.'))).toBe(true);
    expect(
      isRecoverableChunkLoadError('Failed to fetch dynamically imported module: /_next/static/chunks/app.js'),
    ).toBe(true);
    expect(
      isRecoverableChunkLoadError(
        { target: { src: 'http://localhost:3003/_next/static/chunks/app.js' } },
        'http://localhost:3003',
      ),
    ).toBe(true);
    expect(
      isRecoverableChunkLoadError({ target: { href: '/_next/static/css/app.css' } }, 'http://localhost:3003'),
    ).toBe(true);
    expect(
      isRecoverableChunkLoadError(
        { target: { src: 'https://cdn.example/_next/static/chunks/foreign.js' } },
        'http://localhost:3003',
      ),
    ).toBe(false);
    expect(
      isRecoverableChunkLoadError({ target: { src: 'http://localhost:3003/avatar.png' } }, 'http://localhost:3003'),
    ).toBe(false);
    expect(isRecoverableChunkLoadError(new TypeError('ordinary request failed'))).toBe(false);
  });

  it('allows one automatic recovery per target build, never a second after cooldown', () => {
    const storage = memoryStorage();
    expect(reserveAutomaticRecovery(storage, 'build-b', 1_000)).toBe(true);
    expect(reserveAutomaticRecovery(storage, 'build-b', 130_000)).toBe(false);
    expect(reserveAutomaticRecovery(storage, 'build-c', 131_000)).toBe(true);
  });

  it('fails closed with an in-memory latch when sessionStorage throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(reserveAutomaticRecovery(storage, 'build-storage-off')).toBe(true);
    expect(reserveAutomaticRecovery(storage, 'build-storage-off')).toBe(false);
  });

  it('treats malformed recovery records as absent and persists the target record', () => {
    const storage = memoryStorage('{not-json');

    expect(reserveAutomaticRecovery(storage, 'build-malformed', 42)).toBe(true);
    expect(storage.getItem()).toBe(JSON.stringify({ attemptedTargets: ['build-malformed'], attemptedAt: 42 }));
  });

  it('persists every attempted target across controller and page reconstruction, including legacy records', () => {
    const storage = memoryStorage(JSON.stringify({ targetBuildId: 'build-ledger-legacy', attemptedAt: 1 }));

    expect(reserveAutomaticRecovery(storage, 'build-ledger-b', 2)).toBe(true);
    expect(reserveAutomaticRecovery(storage, 'build-ledger-c', 3)).toBe(true);
    expect(reserveAutomaticRecovery(storage, 'build-ledger-b', 4)).toBe(false);
    expect(reserveAutomaticRecovery(storage, 'build-ledger-legacy', 5)).toBe(false);
    expect(JSON.parse(storage.getItem() ?? '{}').attemptedTargets).toEqual([
      'build-ledger-legacy',
      'build-ledger-b',
      'build-ledger-c',
    ]);
  });

  it('detects text, image, file and textarea drafts while ignoring whitespace and disabled textareas', () => {
    threadDrafts.set('thread-space', '   ');
    expect(hasUnsavedUserWork(document)).toBe(false);

    threadDrafts.set('thread-text', 'pending');
    expect(hasUnsavedUserWork(document)).toBe(true);
    threadDrafts.clear();

    threadImageDrafts.set('thread-image', [new File(['image'], 'image.png')]);
    expect(hasUnsavedUserWork(document)).toBe(true);
    threadImageDrafts.clear();

    threadFileDrafts.set('thread-file', [new File(['file'], 'draft.txt')]);
    expect(hasUnsavedUserWork(document)).toBe(true);
    threadFileDrafts.clear();

    const whitespace = document.createElement('textarea');
    whitespace.value = '   ';
    document.body.append(whitespace);
    expect(hasUnsavedUserWork(document)).toBe(false);

    const disabled = document.createElement('textarea');
    disabled.disabled = true;
    disabled.value = 'disabled draft';
    document.body.append(disabled);
    expect(hasUnsavedUserWork(document)).toBe(false);

    const textarea = document.createElement('textarea');
    textarea.value = '  textarea draft  ';
    document.body.append(textarea);
    expect(hasUnsavedUserWork(document)).toBe(true);
  });

  it('installs a live draft bridge rather than a snapshot', () => {
    installThreadDraftBridge();

    expect(window.__CLOWDER_HAS_PENDING_DRAFT__?.()).toBe(false);
    threadFileDrafts.set('background-thread', [new File(['pending'], 'pending.txt')]);
    expect(window.__CLOWDER_HAS_PENDING_DRAFT__?.()).toBe(true);
  });

  it('updates service workers without unregistering and tolerates cache deletion rejection', async () => {
    const update = vi.fn(() => Promise.resolve());
    const unregister = vi.fn(() => Promise.resolve(true));
    const cacheDelete = vi.fn(() => Promise.reject(new Error('cache busy')));
    const windowRef = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([{ update, unregister }]),
        },
      },
      caches: {
        keys: () => Promise.resolve(['old-shell']),
        delete: cacheDelete,
      },
    } as unknown as Window;

    await expect(prepareBrowserForReload(windowRef)).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledWith('old-shell');
  });
});
