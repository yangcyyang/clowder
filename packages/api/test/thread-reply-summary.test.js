import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveThreadReplySummary } from '../dist/routes/thread-reply-summary.js';

function message(overrides = {}) {
  return {
    id: 'message',
    userId: 'user-1',
    catId: null,
    content: '父消息',
    mentions: [],
    timestamp: 100,
    threadId: 'thread-main',
    ...overrides,
  };
}

describe('deriveThreadReplySummary', () => {
  it('counts only replies after the copied source and returns the latest visible preview', () => {
    const source = message();
    const branchMessages = [
      message({ id: 'context', content: '更早上下文', timestamp: 50, threadId: 'thread-branch' }),
      message({ id: 'source-copy', threadId: 'thread-branch' }),
      message({ id: 'reply-1', catId: 'codex', content: '第一条回复', timestamp: 110, threadId: 'thread-branch' }),
      message({ id: 'reply-2', catId: 'opus', content: '  最新\n回复  ', timestamp: 120, threadId: 'thread-branch' }),
    ];

    assert.deepEqual(deriveThreadReplySummary(source, branchMessages, { type: 'user' }), {
      replyCount: 2,
      latestReply: {
        id: 'reply-2',
        catId: 'opus',
        content: '最新 回复',
        timestamp: 120,
      },
    });
  });

  it('excludes deleted, progress and task-system noise from count and preview', () => {
    const source = message();
    const branchMessages = [
      message({ id: 'source-copy', threadId: 'thread-branch' }),
      message({ id: 'visible', catId: 'codex', content: '真实回复', timestamp: 110, threadId: 'thread-branch' }),
      message({ id: 'deleted', content: '已删除', deletedAt: 120, timestamp: 120, threadId: 'thread-branch' }),
      message({ id: 'progress', content: '处理中', origin: 'progress', timestamp: 130, threadId: 'thread-branch' }),
      message({
        id: 'task-event',
        content: 'task #1 状态变化',
        timestamp: 140,
        threadId: 'thread-branch',
        source: { connector: 'task-system', label: 'Task', icon: '📋', meta: { presentation: 'system_notice' } },
      }),
    ];

    assert.deepEqual(deriveThreadReplySummary(source, branchMessages, { type: 'user' }), {
      replyCount: 1,
      latestReply: {
        id: 'visible',
        catId: 'codex',
        content: '真实回复',
        timestamp: 110,
      },
    });
  });

  it('returns an empty fold when the source copy has no visible replies', () => {
    const source = message();
    assert.deepEqual(
      deriveThreadReplySummary(source, [message({ id: 'source-copy', threadId: 'thread-branch' })], { type: 'user' }),
      {
        replyCount: 0,
      },
    );
  });

  it('uses per-viewer whisper visibility when choosing count and latest preview', () => {
    const source = message();
    const branchMessages = [
      message({ id: 'source-copy', threadId: 'thread-branch' }),
      message({ id: 'public', catId: 'codex', content: '公开回复', timestamp: 110, threadId: 'thread-branch' }),
      message({
        id: 'whisper',
        catId: 'opus',
        content: '只给 opus 的秘密',
        timestamp: 120,
        threadId: 'thread-branch',
        visibility: 'whisper',
        whisperTo: ['opus'],
      }),
    ];

    assert.deepEqual(deriveThreadReplySummary(source, branchMessages, { type: 'cat', catId: 'codex' }), {
      replyCount: 1,
      latestReply: { id: 'public', catId: 'codex', content: '公开回复', timestamp: 110 },
    });
    assert.deepEqual(deriveThreadReplySummary(source, branchMessages, { type: 'cat', catId: 'opus' }), {
      replyCount: 2,
      latestReply: {
        id: 'whisper',
        catId: 'opus',
        content: '只给 opus 的秘密',
        timestamp: 120,
        // whisper-hygiene: visibility fields now carried through (consistency fix,
        // twin of the InlineThreadReplyPreview live-socket fix) so a downstream
        // frontend mirror filter has fields to work with.
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    });
  });

  it('uses the last identical source copy as the reply boundary', () => {
    const source = message({ content: '重复内容' });
    const branchMessages = [
      message({ id: 'older-identical', content: '重复内容', threadId: 'thread-branch' }),
      message({ id: 'context-after-older', content: '仍是复制上下文', timestamp: 105, threadId: 'thread-branch' }),
      message({ id: 'source-copy', content: '重复内容', threadId: 'thread-branch' }),
      message({ id: 'actual-reply', content: '真正回复', timestamp: 120, threadId: 'thread-branch' }),
    ];

    assert.deepEqual(deriveThreadReplySummary(source, branchMessages, { type: 'user' }), {
      replyCount: 1,
      latestReply: { id: 'actual-reply', catId: null, content: '真正回复', timestamp: 120 },
    });
  });
});
