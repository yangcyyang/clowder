import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchServerBuildId: vi.fn<(fetchImpl?: typeof fetch, signal?: AbortSignal) => Promise<string | null>>(),
  prepareBrowserForReload: vi.fn<() => Promise<void>>(),
  reload: vi.fn(),
  controllerFactory: vi.fn(),
  controllerProbeResult: vi.fn(),
  controllerRequestRecovery: vi.fn(),
  controllerManualAction: vi.fn(),
}));

vi.mock('@/utils/web-build-version', () => ({
  CLIENT_WEB_BUILD_ID: 'build-a',
  fetchServerBuildId: mocks.fetchServerBuildId,
}));

vi.mock('@/utils/chunk-load-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chunk-load-recovery')>()),
  prepareBrowserForReload: mocks.prepareBrowserForReload,
}));

vi.mock('@/utils/build-recovery-controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/build-recovery-controller')>();
  return {
    ...actual,
    createBuildRecoveryController: (...args: Parameters<typeof actual.createBuildRecoveryController>) => {
      mocks.controllerFactory(...args);
      const controller = actual.createBuildRecoveryController(...args);
      return {
        ...controller,
        handleProbeResult: (...methodArgs: Parameters<typeof controller.handleProbeResult>) => {
          mocks.controllerProbeResult(...methodArgs);
          return controller.handleProbeResult(...methodArgs);
        },
        requestRecovery: (...methodArgs: Parameters<typeof controller.requestRecovery>) => {
          mocks.controllerRequestRecovery(...methodArgs);
          return controller.requestRecovery(...methodArgs);
        },
        manualPromptAction: () => {
          mocks.controllerManualAction();
          return controller.manualPromptAction();
        },
      };
    },
  };
});

import { ChunkLoadRefreshGuard } from '../ChunkLoadRefreshGuard';

type BuildChangedMessage = { type: 'build-changed'; buildId: string };

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  readonly name: string;
  readonly postMessage = vi.fn();
  onmessage: ((event: MessageEvent<BuildChangedMessage>) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  close() {}

  emit(data: BuildChangedMessage) {
    this.onmessage?.({ data } as MessageEvent<BuildChangedMessage>);
  }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChunkLoadRefreshGuard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalLocation: Location;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalLocation = window.location;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchServerBuildId.mockReset().mockResolvedValue('build-a');
    mocks.prepareBrowserForReload.mockReset().mockResolvedValue(undefined);
    mocks.reload.mockReset();
    mocks.controllerFactory.mockClear();
    mocks.controllerProbeResult.mockClear();
    mocks.controllerRequestRecovery.mockClear();
    mocks.controllerManualAction.mockClear();
    MockBroadcastChannel.instances = [];
    sessionStorage.clear();
    document.body.replaceChildren();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: mocks.reload },
    });
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: MockBroadcastChannel,
      writable: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderGuard(strict = false) {
    await act(async () => {
      root.render(
        strict ? (
          <StrictMode>
            <ChunkLoadRefreshGuard />
          </StrictMode>
        ) : (
          <ChunkLoadRefreshGuard />
        ),
      );
    });
    await flushEffects();
  }

  it('delegates probe and external recovery requests to the production controller', async () => {
    await renderGuard();

    expect(mocks.controllerFactory).toHaveBeenCalledTimes(1);
    expect(mocks.controllerProbeResult).toHaveBeenCalledWith('build-a');

    await act(async () => {
      MockBroadcastChannel.instances[0]?.emit({ type: 'build-changed', buildId: 'build-controller-wire' });
      await Promise.resolve();
    });
    expect(mocks.controllerRequestRecovery).toHaveBeenCalledWith('broadcast', 'build-controller-wire');
  });

  it('does nothing when the server build id matches the client', async () => {
    await renderGuard();

    expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(1);
    expect(mocks.prepareBrowserForReload).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('reloads exactly once when a valid different build id is observed without drafts', async () => {
    mocks.fetchServerBuildId.mockResolvedValue('build-b-guard');

    await renderGuard();

    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledWith({
      type: 'build-changed',
      buildId: 'build-b-guard',
    });
    expect(mocks.prepareBrowserForReload).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('shows an actionable persistent prompt and preserves textarea when drafts exist', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = '未发送内容';
    document.body.appendChild(textarea);
    mocks.fetchServerBuildId.mockResolvedValue('build-b-draft');

    await renderGuard();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('检测到 Clowder 新版本');
    expect(dialog?.textContent).toContain('保存好草稿并刷新');
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(textarea.value).toBe('未发送内容');
  });

  it('caps three null probes until focus, visible visibilitychange, or online explicitly retries', async () => {
    mocks.fetchServerBuildId.mockResolvedValue(null);
    await renderGuard();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(3);
    expect(mocks.reload).not.toHaveBeenCalled();

    for (const [index, event] of ['focus', 'visibilitychange', 'online'].entries()) {
      mocks.fetchServerBuildId.mockResolvedValueOnce(null);
      await act(async () => {
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
        await Promise.resolve();
      });
      expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(4 + index);
    }

    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('aborts an in-flight probe before an explicit attention event starts the replacement', async () => {
    mocks.fetchServerBuildId
      .mockImplementationOnce(
        (_fetchImpl, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve(null), { once: true });
          }),
      )
      .mockResolvedValue('build-a');
    await renderGuard();
    const firstSignal = mocks.fetchServerBuildId.mock.calls[0]?.[1];

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(2);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('times out a hung probe, records one failed result, and releases the probe slot', async () => {
    mocks.fetchServerBuildId.mockImplementation(
      (_fetchImpl, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve(null), { once: true });
        }),
    );
    await renderGuard();
    const firstSignal = mocks.fetchServerBuildId.mock.calls[0]?.[1];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(mocks.controllerProbeResult).toHaveBeenCalledWith(null);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(2);
  });

  it('applies this tab reservation and reloads once for duplicate BroadcastChannel events', async () => {
    await renderGuard();
    const channel = MockBroadcastChannel.instances[0];

    await act(async () => {
      channel?.emit({ type: 'build-changed', buildId: 'build-b-broadcast' });
      channel?.emit({ type: 'build-changed', buildId: 'build-b-broadcast' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.prepareBrowserForReload).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('routes chunk errors with drafts through the same persistent prompt', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'chunk 前的草稿';
    document.body.appendChild(textarea);
    await renderGuard();

    await act(async () => {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('Loading chunk 42 failed.') }));
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('检测到 Clowder 新版本');
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(textarea.value).toBe('chunk 前的草稿');
  });

  it('lets a resource target exclusively decide recovery even with chunk-like error text', async () => {
    let errorListener: ((event: ErrorEvent) => void) | null = null;
    const addEventListener = window.addEventListener.bind(window);
    const listenerSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'error') errorListener = listener as (event: ErrorEvent) => void;
      addEventListener(type, listener, options);
    });
    await renderGuard();
    listenerSpy.mockRestore();
    mocks.controllerRequestRecovery.mockClear();

    await act(async () => {
      errorListener?.({
        target: { src: 'https://cdn.example/_next/static/chunks/foreign.js' },
        message: 'Loading chunk 77 failed.',
        error: new Error('ChunkLoadError: foreign resource'),
      } as unknown as ErrorEvent);
      await Promise.resolve();
    });

    expect(mocks.controllerRequestRecovery).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();

    await act(async () => {
      errorListener?.({
        target: { src: `${window.location.origin}/_next/static/chunks/local.js` },
        message: 'Loading chunk 77 failed.',
        error: new Error('ChunkLoadError: local resource'),
      } as unknown as ErrorEvent);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.controllerRequestRecovery).toHaveBeenCalledWith('chunk', 'build-a');
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('hydrates a bootstrap session prompt into the visible draft-safe UI', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'bootstrap 草稿';
    document.body.appendChild(textarea);
    sessionStorage.setItem(
      'clowder:recovery-prompt',
      JSON.stringify({ kind: 'chunk', targetBuildId: 'build-a', reason: 'unsaved-draft' }),
    );

    await renderGuard();

    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('检测到 Clowder 新版本');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('continues safely when the sessionStorage getter throws SecurityError', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });

    try {
      await renderGuard();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }

    expect(mocks.fetchServerBuildId).toHaveBeenCalledTimes(1);
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('keeps the bootstrap prompt controller through StrictMode effect reconstruction', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'StrictMode 草稿';
    document.body.appendChild(textarea);
    sessionStorage.setItem(
      'clowder:recovery-prompt',
      JSON.stringify({ kind: 'chunk', targetBuildId: 'strict-build-a', reason: 'unsaved-draft' }),
    );

    await renderGuard(true);
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '保存好草稿并刷新',
    );
    await act(async () => {
      button?.click();
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.prepareBrowserForReload).toHaveBeenCalledTimes(1);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.controllerManualAction).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup before the manual draft-safe button reloads exactly once', async () => {
    const textarea = document.createElement('textarea');
    textarea.value = '先保存';
    document.body.appendChild(textarea);
    mocks.fetchServerBuildId.mockResolvedValue('build-b-manual');
    const order: string[] = [];
    mocks.prepareBrowserForReload.mockImplementation(async () => {
      order.push('cleanup');
    });
    mocks.reload.mockImplementation(() => {
      order.push('reload');
    });
    await renderGuard();

    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '保存好草稿并刷新',
    );
    await act(async () => {
      button?.click();
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(order).toEqual(['cleanup', 'reload']);
    expect(mocks.controllerManualAction).toHaveBeenCalledTimes(1);
  });
});
