export function createChunkLoadBootstrapScript(clientBuildId: string): string {
  const serializedBuildId = JSON.stringify(clientBuildId);
  return `
(() => {
  const clientBuildId = ${serializedBuildId};
  const recoveryKey = 'clowder:automatic-recovery';
  const promptKey = 'clowder:recovery-prompt';
  const attemptedTargets = new Set();
  const chunkErrorPattern = /ChunkLoadError|Loading chunk \\d+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;
  const nextStaticResourcePattern = /\\/_next\\/static\\/(?:chunks|css)\\//i;

  const collectErrorText = (reason) => {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    if (typeof reason !== 'object') return '';
    return [reason.name, reason.message, reason.stack, reason.type]
      .filter((value) => typeof value === 'string')
      .join('\\n');
  };

  const isRecoverable = (event) => {
    const target = event && event.target;
    const resourceUrl = target && typeof target === 'object'
      ? [target.src, target.href].filter((value) => typeof value === 'string').join('\\n')
      : '';
    if (nextStaticResourcePattern.test(resourceUrl)) return true;
    const reason = event && Object.prototype.hasOwnProperty.call(event, 'reason')
      ? event.reason
      : event && (event.error || event.message || event);
    return chunkErrorPattern.test(collectErrorText(reason));
  };

  const hasUnsavedWork = () => {
    try {
      if (window.__CLOWDER_HAS_PENDING_DRAFT__?.()) return true;
    } catch {
      return true;
    }
    try {
      return Array.from(document.querySelectorAll('textarea:not(:disabled)'))
        .some((textarea) => String(textarea.value || '').trim().length > 0);
    } catch {
      return true;
    }
  };

  const dispatchDraftPrompt = () => {
    const prompt = { kind: 'chunk', targetBuildId: clientBuildId, reason: 'unsaved-draft' };
    try {
      window.sessionStorage.setItem(promptKey, JSON.stringify(prompt));
    } catch {}
    const event = typeof window.CustomEvent === 'function'
      ? new window.CustomEvent('clowder:recovery-prompt', { detail: prompt })
      : { type: 'clowder:recovery-prompt', detail: prompt };
    window.dispatchEvent(event);
  };

  const reserveRecovery = (targetBuildId) => {
    if (attemptedTargets.has(targetBuildId)) return false;
    attemptedTargets.add(targetBuildId);
    try {
      const rawRecord = window.sessionStorage.getItem(recoveryKey);
      if (rawRecord) {
        try {
          const record = JSON.parse(rawRecord);
          if (record && record.targetBuildId === targetBuildId) return false;
        } catch {}
      }
      window.sessionStorage.setItem(
        recoveryKey,
        JSON.stringify({ targetBuildId, attemptedAt: Date.now() }),
      );
    } catch {}
    return true;
  };

  const prepareForReload = () => Promise.allSettled([
    Promise.resolve().then(() => window.navigator.serviceWorker?.getRegistrations()).then((registrations) =>
      Promise.allSettled((registrations || []).map((registration) => registration.update())),
    ),
    'caches' in window
      ? Promise.resolve().then(() => window.caches.keys()).then((keys) =>
          Promise.allSettled(keys.map((key) => window.caches.delete(key))),
        )
      : Promise.resolve(),
  ]);

  const recover = (event) => {
    if (!isRecoverable(event)) return;
    if (hasUnsavedWork()) {
      dispatchDraftPrompt();
      return;
    }
    const targetBuildId = 'chunk:' + clientBuildId;
    if (!reserveRecovery(targetBuildId)) return;
    void prepareForReload().then(() => window.location.reload());
  };

  window.addEventListener('error', recover, true);
  window.addEventListener('unhandledrejection', recover, true);
})();
`;
}
