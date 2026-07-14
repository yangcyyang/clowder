import { describe, expect, it } from 'vitest';
import { applyInlineThreadReplyCountUpdate } from '@/components/inline-thread-reply-state';

describe('inline thread reply count state', () => {
  it('keeps a visible entry when a non-authoritative loading zero arrives', () => {
    const next = applyInlineThreadReplyCountUpdate(
      { 'msg-source': { branchThreadId: 'thread-branch', replyCount: 4 } },
      'msg-source',
      'thread-branch',
      0,
      { authoritative: false },
    );

    expect(next['msg-source']).toEqual({ branchThreadId: 'thread-branch', replyCount: 4 });
  });

  it('allows an authoritative zero to hide an actually empty thread', () => {
    const next = applyInlineThreadReplyCountUpdate(
      { 'msg-source': { branchThreadId: 'thread-branch', replyCount: 4 } },
      'msg-source',
      'thread-branch',
      0,
      { authoritative: true },
    );

    expect(next['msg-source']).toEqual({ branchThreadId: 'thread-branch', replyCount: 0 });
  });

  it('accepts optimistic non-zero counts immediately', () => {
    const next = applyInlineThreadReplyCountUpdate({}, 'msg-source', 'thread-branch', 1, {
      authoritative: false,
    });

    expect(next['msg-source']).toEqual({ branchThreadId: 'thread-branch', replyCount: 1 });
  });

  it('updates and preserves the latest reply preview without carrying it across branches', () => {
    const preview = { id: 'reply-1', catId: 'opus', content: '最新回复', timestamp: 10 };
    const withPreview = applyInlineThreadReplyCountUpdate({}, 'msg-source', 'thread-branch', 1, {
      authoritative: true,
      latestReply: preview,
    });
    const loadingZero = applyInlineThreadReplyCountUpdate(withPreview, 'msg-source', 'thread-branch', 0, {
      authoritative: false,
    });
    const otherBranch = applyInlineThreadReplyCountUpdate(loadingZero, 'msg-source', 'thread-other', 1, {
      authoritative: false,
    });

    expect(loadingZero['msg-source']?.latestReply).toEqual(preview);
    expect(otherBranch['msg-source']?.latestReply).toBeUndefined();
  });
});
