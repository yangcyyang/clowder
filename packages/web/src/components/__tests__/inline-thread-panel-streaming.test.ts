import { describe, expect, it } from 'vitest';
import {
  getInlineThreadSearchHits,
  getNextInlineThreadSearchIndex,
  isUnsafeInlineThreadTarget,
  normalizeInlineThreadMessage,
  shouldShowInlineThreadRuntimeStatus,
} from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';

describe('InlineThreadPanel streaming normalization', () => {
  it('maps API draft replies to streaming messages so ChatMessage hides partial content', () => {
    const draftMessage = {
      id: 'draft-inv-1',
      type: 'assistant',
      catId: 'codex',
      content: 'partial reply',
      timestamp: 123,
      origin: 'stream',
      isDraft: true,
    } as ChatMessage & { isDraft: true };

    const normalized = normalizeInlineThreadMessage(draftMessage);

    expect(normalized.isStreaming).toBe(true);
    expect('isDraft' in normalized).toBe(false);
  });

  it('keeps completed replies unchanged', () => {
    const finalMessage = {
      id: 'm-final',
      type: 'assistant',
      catId: 'codex',
      content: 'complete reply',
      timestamp: 456,
      origin: 'stream',
      isStreaming: false,
    } as ChatMessage;

    expect(normalizeInlineThreadMessage(finalMessage)).toBe(finalMessage);
  });
});

describe('InlineThreadPanel runtime status visibility', () => {
  it('hides silent/done cats from the thread current-replies strip', () => {
    expect(shouldShowInlineThreadRuntimeStatus('alive_but_silent')).toBe(false);
    expect(shouldShowInlineThreadRuntimeStatus('done')).toBe(false);
  });

  it('keeps actionable runtime statuses visible', () => {
    expect(shouldShowInlineThreadRuntimeStatus('spawning')).toBe(true);
    expect(shouldShowInlineThreadRuntimeStatus('pending')).toBe(true);
    expect(shouldShowInlineThreadRuntimeStatus('streaming')).toBe(true);
    expect(shouldShowInlineThreadRuntimeStatus('suspected_stall')).toBe(true);
    expect(shouldShowInlineThreadRuntimeStatus('error')).toBe(true);
  });
});

describe('InlineThreadPanel thread target guard', () => {
  it('blocks fallback panels that would send replies into the source/main thread', () => {
    expect(isUnsafeInlineThreadTarget('thread-main', { threadId: 'thread-main' })).toBe(true);
  });

  it('allows real branch threads to receive replies', () => {
    expect(isUnsafeInlineThreadTarget('thread-branch', { threadId: 'thread-main' })).toBe(false);
  });
});

describe('InlineThreadPanel search helpers', () => {
  const messages = [
    { id: 'source', type: 'user', content: '复刻 Raft thread 搜索', timestamp: 1 },
    { id: 'reply-1', type: 'assistant', catId: 'codex', content: '当前 thread 内命中 Raft', timestamp: 2 },
    { id: 'reply-2', type: 'assistant', catId: 'codex', content: '无关回复', timestamp: 3 },
  ] as ChatMessage[];

  it('matches source message and replies case-insensitively', () => {
    expect(getInlineThreadSearchHits(messages, 'raft')).toEqual([
      { id: 'source', index: 0 },
      { id: 'reply-1', index: 1 },
    ]);
  });

  it('ignores empty queries', () => {
    expect(getInlineThreadSearchHits(messages, '   ')).toEqual([]);
  });

  it('wraps next/previous search index', () => {
    expect(getNextInlineThreadSearchIndex(1, 2, 1)).toBe(0);
    expect(getNextInlineThreadSearchIndex(0, 2, -1)).toBe(1);
    expect(getNextInlineThreadSearchIndex(0, 0, 1)).toBe(0);
  });
});
