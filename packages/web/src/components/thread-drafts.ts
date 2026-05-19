export const threadDrafts = new Map<string, string>();
export const threadImageDrafts = new Map<string, File[]>();
export const threadFileDrafts = new Map<string, File[]>();

export function hasPendingThreadDraft(threadId: string): boolean {
  const textDraft = threadDrafts.get(threadId);
  if (typeof textDraft === 'string' && textDraft.trim().length > 0) return true;

  const imageDrafts = threadImageDrafts.get(threadId);
  if (Array.isArray(imageDrafts) && imageDrafts.length > 0) return true;

  const fileDrafts = threadFileDrafts.get(threadId);
  return Array.isArray(fileDrafts) && fileDrafts.length > 0;
}
