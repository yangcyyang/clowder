export const threadDrafts = new Map<string, string>();
export const threadImageDrafts = new Map<string, File[]>();
export const threadFileDrafts = new Map<string, File[]>();

declare global {
  interface Window {
    __CLOWDER_HAS_PENDING_DRAFT__?: () => boolean;
  }
}

export function hasPendingThreadDraft(threadId: string): boolean {
  const textDraft = threadDrafts.get(threadId);
  if (typeof textDraft === 'string' && textDraft.trim().length > 0) return true;

  const imageDrafts = threadImageDrafts.get(threadId);
  if (Array.isArray(imageDrafts) && imageDrafts.length > 0) return true;

  const fileDrafts = threadFileDrafts.get(threadId);
  return Array.isArray(fileDrafts) && fileDrafts.length > 0;
}

export function hasAnyPendingThreadDraft(): boolean {
  for (const draft of threadDrafts.values()) {
    if (draft.trim().length > 0) return true;
  }
  for (const drafts of threadImageDrafts.values()) {
    if (drafts.length > 0) return true;
  }
  for (const drafts of threadFileDrafts.values()) {
    if (drafts.length > 0) return true;
  }
  return false;
}

export function installThreadDraftBridge(): void {
  if (typeof window === 'undefined') return;
  window.__CLOWDER_HAS_PENDING_DRAFT__ = () => hasAnyPendingThreadDraft();
}

installThreadDraftBridge();
