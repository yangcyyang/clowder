import { describe, expect, it, vi } from 'vitest';
import { createChunkLoadBootstrapScript } from '../chunk-load-bootstrap';

type BrowserListener = (event: Record<string, unknown>) => void;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function fakeBrowser(
  options: {
    storage?: ReturnType<typeof memoryStorage>;
    hasDraft?: () => boolean;
    textareas?: Array<{ value: string; disabled?: boolean }>;
  } = {},
) {
  const listeners = new Map<string, BrowserListener[]>();
  const captures = new Map<string, boolean>();
  const dispatched: Array<{ type: string; detail?: unknown }> = [];
  const reload = vi.fn();
  const update = vi.fn(() => Promise.resolve());
  const storage = options.storage ?? memoryStorage();
  const windowRef = {
    sessionStorage: storage,
    __CLOWDER_HAS_PENDING_DRAFT__: options.hasDraft,
    addEventListener: (type: string, listener: BrowserListener, capture?: boolean) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      captures.set(type, capture === true);
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      dispatched.push(event);
      return true;
    },
    CustomEvent: class {
      type: string;
      detail?: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    navigator: {
      serviceWorker: {
        getRegistrations: () => Promise.resolve([{ update }]),
      },
    },
    caches: {
      keys: () => Promise.resolve(['old-shell']),
      delete: () => Promise.resolve(true),
    },
    location: { reload },
  };
  const documentRef = {
    querySelectorAll: () => (options.textareas ?? []).filter((textarea) => !textarea.disabled),
  };

  new Function('window', 'document', createChunkLoadBootstrapScript('build-a'))(windowRef, documentRef);

  return {
    captures,
    dispatched,
    emit: (type: string, event: Record<string, unknown>) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    reload,
    storage,
    update,
  };
}

describe('chunk-load-bootstrap', () => {
  it('installs capture-phase error and unhandledrejection listeners immediately', () => {
    const browser = fakeBrowser();

    expect(browser.captures.get('error')).toBe(true);
    expect(browser.captures.get('unhandledrejection')).toBe(true);
  });

  it('retains a resource event target and reloads the same build only once', async () => {
    const browser = fakeBrowser();
    const resourceEvent = { target: { src: 'http://localhost:3003/_next/static/chunks/app.js' } };

    browser.emit('error', resourceEvent);
    browser.emit('error', resourceEvent);

    await vi.waitFor(() => expect(browser.reload).toHaveBeenCalledTimes(1));
    expect(browser.update).toHaveBeenCalledTimes(1);
  });

  it('prompts without navigating whenever the live draft bridge reports pending work', async () => {
    const browser = fakeBrowser({ hasDraft: () => true });

    browser.emit('unhandledrejection', { reason: new Error('Loading chunk 7 failed.') });
    await Promise.resolve();

    expect(browser.reload).not.toHaveBeenCalled();
    expect(JSON.parse(browser.storage.getItem('clowder:recovery-prompt') ?? '{}')).toEqual({
      kind: 'chunk',
      targetBuildId: 'build-a',
      reason: 'unsaved-draft',
    });
    expect(browser.dispatched).toContainEqual(expect.objectContaining({ type: 'clowder:recovery-prompt' }));
  });

  it('prompts instead of reloading for a non-empty enabled textarea', async () => {
    const browser = fakeBrowser({
      hasDraft: () => false,
      textareas: [{ value: '   ' }, { value: 'pending textarea' }, { value: 'disabled', disabled: true }],
    });

    browser.emit('error', { target: { src: 'http://localhost:3003/_next/static/chunks/page.js' } });
    await Promise.resolve();

    expect(browser.reload).not.toHaveBeenCalled();
    expect(browser.storage.getItem('clowder:recovery-prompt')).not.toBeNull();
  });

  it('keeps a same-build in-memory latch when sessionStorage throws', async () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const browser = fakeBrowser({ storage });
    const event = { target: { href: 'http://localhost:3003/_next/static/css/app.css' } };

    browser.emit('error', event);
    await vi.waitFor(() => expect(browser.reload).toHaveBeenCalledTimes(1));
    browser.emit('error', event);
    await Promise.resolve();

    expect(browser.reload).toHaveBeenCalledTimes(1);
  });
});
