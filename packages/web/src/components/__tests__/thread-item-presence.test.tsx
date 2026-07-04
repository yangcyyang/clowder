import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';
import type { CatData } from '@/hooks/useCatData';
import { DEFAULT_THREAD_STATE, type ThreadState } from '@/stores/chat-types';

const TEST_CAT: CatData = {
  id: 'codex',
  displayName: '老者-codex',
  color: { primary: '#f26aa3', secondary: '#ffd6e8' },
  mentionPatterns: ['@codex'],
  clientId: 'openai',
  defaultModel: 'gpt-5',
  avatar: 'cat',
  roleDescription: 'test',
  personality: 'test',
};

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [TEST_CAT],
    getCatById: (catId: string) => (catId === TEST_CAT.id ? TEST_CAT : undefined),
    getCatsByBreed: () => new Map(),
  }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));

vi.mock('@/components/ThreadSidebar/ThreadCatSettings', () => ({
  ThreadCatSettings: () => null,
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://example.test',
}));

function renderThreadItem(threadState: ThreadState): string {
  return renderToStaticMarkup(
    React.createElement(ThreadItem, {
      id: 'thread-1',
      title: '设计对话',
      participants: ['codex'],
      lastActiveAt: Date.now(),
      isActive: false,
      onSelect: vi.fn(),
      threadState,
    }),
  );
}

describe('ThreadItem presence line', () => {
  it('renders current agent action under the thread title', () => {
    const html = renderThreadItem({
      ...DEFAULT_THREAD_STATE,
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'codex', mode: 'execute', phase: 'tool_calling' },
      },
      catStatuses: { codex: 'streaming' },
    });

    expect(html).toContain('data-testid="thread-presence-line"');
    expect(html).toContain('老者-codex');
    expect(html).toContain('正在执行工具');
  });

  it('keeps idle threads compact even if a stale status is present', () => {
    const html = renderThreadItem({
      ...DEFAULT_THREAD_STATE,
      hasActiveInvocation: false,
      activeInvocations: {},
      catStatuses: { codex: 'streaming' },
    });

    expect(html).not.toContain('data-testid="thread-presence-line"');
    expect(html).not.toContain('正在回复');
  });
});
