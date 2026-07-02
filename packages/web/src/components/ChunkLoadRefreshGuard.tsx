'use client';

import { useEffect } from 'react';
import { clearStaleBrowserShell, isRecoverableChunkLoadError, markChunkReloadAttempt } from '@/utils/chunk-load-recovery';

export function ChunkLoadRefreshGuard() {
  useEffect(() => {
    const reloadOnce = (reason: unknown) => {
      if (!isRecoverableChunkLoadError(reason)) return;
      if (!markChunkReloadAttempt(window)) return;
      void clearStaleBrowserShell(window).finally(() => {
        window.setTimeout(() => window.location.reload(), 0);
      });
    };

    const onError = (event: ErrorEvent) => {
      reloadOnce(event.error ?? event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reloadOnce(event.reason);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
