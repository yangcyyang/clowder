'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type BuildRecoveryAction,
  type BuildRecoveryController,
  createBuildRecoveryController,
  type RecoveryRequest,
} from '@/utils/build-recovery-controller';
import { hasUnsavedUserWork, isRecoverableChunkLoadError, prepareBrowserForReload } from '@/utils/chunk-load-recovery';
import { CLIENT_WEB_BUILD_ID, fetchServerBuildId } from '@/utils/web-build-version';

const BUILD_CHANNEL_NAME = 'clowder:web-build';
const BOOTSTRAP_PROMPT_KEY = 'clowder:recovery-prompt';
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function createMemoryRecoveryStorage(): RecoveryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function getSafeSessionStorage(): RecoveryStorage {
  try {
    return window.sessionStorage;
  } catch {
    return createMemoryRecoveryStorage();
  }
}

type BuildChangedMessage = {
  type: 'build-changed';
  buildId: string;
};

function parseBootstrapPrompt(value: unknown): RecoveryRequest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { kind?: unknown; targetBuildId?: unknown };
  if (candidate.kind !== 'chunk' || typeof candidate.targetBuildId !== 'string') return null;
  const targetBuildId = candidate.targetBuildId.trim();
  return targetBuildId ? { kind: 'chunk', targetBuildId } : null;
}

function openBuildChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(BUILD_CHANNEL_NAME);
  } catch {
    return null;
  }
}

export function ChunkLoadRefreshGuard() {
  const [prompt, setPrompt] = useState<RecoveryRequest | null>(null);
  const promptVisibleRef = useRef(false);
  const reloadStartedRef = useRef(false);
  const controllerRef = useRef<BuildRecoveryController | null>(null);
  const recoveryStorageRef = useRef<RecoveryStorage | null>(null);

  const beginReload = useCallback(async () => {
    if (reloadStartedRef.current) return;
    reloadStartedRef.current = true;
    try {
      await prepareBrowserForReload(window);
    } finally {
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let activeProbe: {
      timeoutId: number;
      cancel: () => void;
      cancelled: boolean;
    } | null = null;
    const channel = openBuildChannel();
    recoveryStorageRef.current ??= getSafeSessionStorage();
    const controller =
      controllerRef.current ??
      createBuildRecoveryController({
        currentBuildId: CLIENT_WEB_BUILD_ID,
        storage: recoveryStorageRef.current,
        hasUnsavedWork: () => hasUnsavedUserWork(document),
      });
    controllerRef.current ??= controller;

    const applyActions = (actions: BuildRecoveryAction[]) => {
      for (const action of actions) {
        if (action.type === 'announce') {
          channel?.postMessage({ type: 'build-changed', buildId: action.buildId } satisfies BuildChangedMessage);
        } else if (action.type === 'prompt') {
          promptVisibleRef.current = true;
          setPrompt((current) => current ?? action.request);
        } else if (action.type === 'reload') {
          void beginReload();
        }
      }
    };

    const requestRecovery = (kind: RecoveryRequest['kind'], targetBuildId: string) =>
      applyActions(controller.requestRecovery(kind, targetBuildId));

    const shouldSkipProbe = () =>
      Boolean(
        disposed || activeProbe || promptVisibleRef.current || reloadStartedRef.current || !controller.canProbe(),
      );

    const applyProbeResult = (serverBuildId: string | null) => {
      applyActions(controller.handleProbeResult(serverBuildId));
    };

    const probeBuildId = async () => {
      if (shouldSkipProbe()) return;

      const abortController = new AbortController();
      let settleTimeout = () => {};
      const timeoutResult = new Promise<null>((resolve) => {
        settleTimeout = () => resolve(null);
      });
      const probe = {
        timeoutId: 0,
        cancelled: false,
        cancel: () => {
          probe.cancelled = true;
          abortController.abort();
          settleTimeout();
        },
      };
      probe.timeoutId = window.setTimeout(() => {
        abortController.abort();
        settleTimeout();
      }, PROBE_TIMEOUT_MS);
      activeProbe = probe;
      try {
        const serverBuildId = await Promise.race([fetchServerBuildId(fetch, abortController.signal), timeoutResult]);
        if (disposed || probe.cancelled) return;
        applyProbeResult(serverBuildId);
      } finally {
        window.clearTimeout(probe.timeoutId);
        if (activeProbe === probe) activeProbe = null;
      }
    };

    const resetFailuresAndProbe = () => {
      controller.resetProbeFailures();
      activeProbe?.cancel();
      activeProbe = null;
      void probeBuildId();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resetFailuresAndProbe();
    };
    const onError = (event: ErrorEvent) => {
      if (isRecoverableChunkLoadError(event, window.location.origin)) {
        requestRecovery('chunk', CLIENT_WEB_BUILD_ID);
      }
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isRecoverableChunkLoadError(event.reason, window.location.origin)) {
        requestRecovery('chunk', CLIENT_WEB_BUILD_ID);
      }
    };
    const onBootstrapPrompt = (event: Event) => {
      const request = parseBootstrapPrompt((event as CustomEvent<unknown>).detail);
      if (!request) return;
      try {
        window.sessionStorage.removeItem(BOOTSTRAP_PROMPT_KEY);
      } catch {
        // The visible in-memory prompt remains authoritative when storage is blocked.
      }
      requestRecovery(request.kind, request.targetBuildId);
    };

    if (channel) {
      channel.onmessage = (event: MessageEvent<BuildChangedMessage>) => {
        const message = event.data;
        if (message?.type !== 'build-changed' || typeof message.buildId !== 'string') return;
        const buildId = message.buildId.trim();
        if (!buildId || buildId === CLIENT_WEB_BUILD_ID) return;
        requestRecovery('broadcast', buildId);
      };
    }

    window.addEventListener('focus', resetFailuresAndProbe);
    window.addEventListener('online', resetFailuresAndProbe);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection, true);
    window.addEventListener('clowder:recovery-prompt', onBootstrapPrompt);

    try {
      const rawPrompt = window.sessionStorage.getItem(BOOTSTRAP_PROMPT_KEY);
      if (rawPrompt) {
        window.sessionStorage.removeItem(BOOTSTRAP_PROMPT_KEY);
        const request = parseBootstrapPrompt(JSON.parse(rawPrompt));
        if (request) requestRecovery(request.kind, request.targetBuildId);
      }
    } catch {
      // Malformed or inaccessible prompt state must not break the hydrated app.
    }

    void probeBuildId();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void probeBuildId();
    }, PROBE_INTERVAL_MS);

    return () => {
      disposed = true;
      activeProbe?.cancel();
      window.clearInterval(intervalId);
      window.removeEventListener('focus', resetFailuresAndProbe);
      window.removeEventListener('online', resetFailuresAndProbe);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection, true);
      window.removeEventListener('clowder:recovery-prompt', onBootstrapPrompt);
      channel?.close();
    };
  }, [beginReload]);

  const reloadAfterSaving = () => {
    if (!prompt || reloadStartedRef.current) return;
    const actions = controllerRef.current?.manualPromptAction() ?? [];
    if (actions.some((action) => action.type === 'reload')) void beginReload();
  };

  if (!prompt) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="clowder-recovery-title"
      aria-describedby="clowder-recovery-description"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 text-slate-950 shadow-2xl">
        <h2 id="clowder-recovery-title" className="text-lg font-semibold">
          检测到 Clowder 新版本
        </h2>
        <p id="clowder-recovery-description" className="mt-2 text-sm leading-6 text-slate-700">
          当前页面仍有未发送内容。请先保存草稿，再手动刷新以加载新版本。
        </p>
        <button
          type="button"
          onClick={reloadAfterSaving}
          className="mt-5 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white"
        >
          保存好草稿并刷新
        </button>
      </div>
    </div>
  );
}
