import type { TaskItem } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  getInlineThreadSearchHits,
  getNextInlineThreadSearchIndex,
  InlineThreadTaskStatusCard,
  isUnsafeInlineThreadTarget,
  normalizeInlineThreadMessage,
  shouldSendInlineThreadMessage,
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

describe('InlineThreadPanel send shortcut', () => {
  it('sends on Enter and keeps Shift+Enter for newline', () => {
    expect(shouldSendInlineThreadMessage({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false })).toBe(true);
    expect(shouldSendInlineThreadMessage({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('keeps command/control Enter compatible', () => {
    expect(shouldSendInlineThreadMessage({ key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldSendInlineThreadMessage({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldSendInlineThreadMessage({ key: 'a', shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe('InlineThreadPanel task status card', () => {
  const baseTask = {
    id: 'task-status-card',
    kind: 'work',
    threadId: 'thread-main',
    subjectKey: null,
    title: '验证任务 Thread 状态卡',
    ownerCatId: 'codex',
    status: 'in_review',
    why: '用户需要一眼看到状态和交付证据',
    createdBy: 'opus',
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_001_000,
    evidence: {
      tests: 'node --test packages/api/test/tasks-route.test.js passed',
      review: '@专家-Claude review passed',
    },
  } as TaskItem;

  it('renders task target, owner, status, evidence count and next step', () => {
    const html = renderToStaticMarkup(React.createElement(InlineThreadTaskStatusCard, { task: baseTask }));

    expect(html).toContain('任务目标');
    expect(html).toContain('验证任务 Thread 状态卡');
    expect(html).toContain('负责人');
    expect(html).toContain('codex');
    expect(html).toContain('待验收');
    expect(html).toContain('交付证据 2/5');
    expect(html).toContain('下一步');
    expect(html).toContain('等待验收');
  });

  it('renders nothing when no task context is available', () => {
    const html = renderToStaticMarkup(React.createElement(InlineThreadTaskStatusCard, {}));

    expect(html).toBe('');
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
