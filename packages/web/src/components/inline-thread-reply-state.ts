export type InlineThreadReplyPreview = {
  id: string;
  catId: string | null;
  content: string;
  timestamp: number;
  /**
   * Whisper metadata, carried through from the underlying reply message so
   * downstream summary rendering (e.g. the entry-chip hover title) can be
   * gated by canViewerSeeThreadMessage instead of always showing the raw
   * content of a possibly-whisper reply.
   */
  visibility?: 'public' | 'whisper';
  whisperTo?: string[];
  revealedAt?: number | null;
};
export type InlineThreadReplyEntry = {
  branchThreadId: string;
  replyCount: number;
  latestReply?: InlineThreadReplyPreview;
};
export type InlineThreadReplyState = Record<string, InlineThreadReplyEntry>;

export type InlineThreadReplyCountUpdateOptions = {
  authoritative?: boolean;
  latestReply?: InlineThreadReplyPreview;
};

export function applyInlineThreadReplyCountUpdate(
  prev: InlineThreadReplyState,
  sourceMessageId: string,
  branchThreadId: string,
  replyCount: number,
  options: InlineThreadReplyCountUpdateOptions = {},
): InlineThreadReplyState {
  const existing = prev[sourceMessageId];
  const isLoadingZero =
    !options.authoritative &&
    replyCount === 0 &&
    existing?.branchThreadId === branchThreadId &&
    existing.replyCount > 0;

  if (isLoadingZero) return prev;

  const latestReply =
    options.latestReply ??
    (!options.authoritative && existing?.branchThreadId === branchThreadId ? existing.latestReply : undefined);

  return {
    ...prev,
    [sourceMessageId]: {
      branchThreadId,
      replyCount,
      ...(latestReply ? { latestReply } : {}),
    },
  };
}
