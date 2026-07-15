'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hasUnsavedUserWork,
  isRecoverableChunkLoadError,
  prepareBrowserForReload,
  reserveAutomaticRecovery,
} from '@/utils/chunk-load-recovery';
import { CLIENT_WEB_BUILD_ID, fetchServerBuildId } from '@/utils/web-build-version';

const BUILD_CHANNEL_NAME = 'clowder:web-build';
const BOOTSTRAP_PROMPT_KEY = 'clowder:recovery-prompt';
const PROBE_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_PROBE_FAILURES = 3;

type RecoveryKind = 'build' | 'broadcast' | 'chunk';

type RecoveryRequest = {
  kind: RecoveryKind;
  targetBuildId: string;
};

type BuildChangedMessage = {
  type: 'build-changed';
  buildId: string;
};

function normalizeRecoveryTarget(kind: RecoveryKind, targetBuildId: string): string {
  const normalizedBuildId = targetBuildId.trim();
  if (kind !== 'chunk' || normalizedBuildId.startsWith('chunk:')) return normalizedBuildId;
  return `chunk:${normalizedBuildId}`;
}

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
    let consecutiveProbeFailures = 0;
    let activeProbe: AbortController | null = null;
    const announcedBuildIds = new Set<string>();
    const channel = openBuildChannel();

    const requestRecovery = (kind: RecoveryKind, targetBuildId: string) => {
      const recoveryTarget = normalizeRecoveryTarget(kind, targetBuildId);
      if (!recoveryTarget || reloadStartedRef.current) return;

      if (promptVisibleRef.current || hasUnsavedUserWork(document)) {
        promptVisibleRef.current = true;
        setPrompt((current) => current ?? { kind, targetBuildId: recoveryTarget });
        return;
      }

      if (!reserveAutomaticRecovery(window.sessionStorage, recoveryTarget)) return;
      void beginReload();
    };

    const shouldSkipProbe = () =>
      Boolean(
        disposed ||
          activeProbe ||
          promptVisibleRef.current ||
          reloadStartedRef.current ||
          consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES,
      );

    const applyProbeResult = (serverBuildId: string | null) => {
      if (!serverBuildId) {
        consecutiveProbeFailures += 1;
        return;
      }

      consecutiveProbeFailures = 0;
      if (serverBuildId === CLIENT_WEB_BUILD_ID) return;
      if (!announcedBuildIds.has(serverBuildId)) {
        announcedBuildIds.add(serverBuildId);
        channel?.postMessage({ type: 'build-changed', buildId: serverBuildId } satisfies BuildChangedMessage);
      }
      requestRecovery('build', serverBuildId);
    };

    const probeBuildId = async () => {
      if (shouldSkipProbe()) return;

      const controller = new AbortController();
      activeProbe = controller;
      try {
        const serverBuildId = await fetchServerBuildId(fetch, controller.signal);
        if (disposed || controller.signal.aborted) return;
        applyProbeResult(serverBuildId);
      } finally {
        if (activeProbe === controller) activeProbe = null;
      }
    };

    const resetFailuresAndProbe = () => {
      consecutiveProbeFailures = 0;
      activeProbe?.abort();
      activeProbe = null;
      void probeBuildId();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resetFailuresAndProbe();
    };
    const onError = (event: ErrorEvent) => {
      if (isRecoverableChunkLoadError(event) || isRecoverableChunkLoadError(event.error ?? event.message)) {
        requestRecovery('chunk', CLIENT_WEB_BUILD_ID);
      }
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isRecoverableChunkLoadError(event.reason)) requestRecovery('chunk', CLIENT_WEB_BUILD_ID);
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
      activeProbe?.abort();
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
    reserveAutomaticRecovery(window.sessionStorage, prompt.targetBuildId);
    void beginReload();
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
