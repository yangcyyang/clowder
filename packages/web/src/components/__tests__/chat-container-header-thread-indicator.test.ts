/**
 * Thread indicator in ChatContainerHeader.
 * Verifies that the header shows the current thread title (not just "Clowder AI").
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader, ThreadIndicator } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/ThreadCatPill', () => ({
  ThreadCatPill: () => null,
}));
vi.mock('@/components/ExportButton', () => ({
  ExportButton: () => null,
}));
vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));
vi.mock('@/components/VoiceCompanionButton', () => ({
  VoiceCompanionButton: () => null,
}));
vi.mock('@/components/icons/CatCafeLogo', () => ({
  CatCafeLogo: () => React.createElement('span', null, 'logo'),
}));

const TEST_THREADS = [
  {
    id: 'thread_xyz',
    title: '讨论 F095 设计',
    projectPath: '/projects/cat-cafe',
    createdBy: 'user1',
    participants: ['user1'],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    pinned: false,
    favorited: false,
    preferredCats: [] as string[],
  },
];

const mockStore: Record<string, unknown> = {
  threads: TEST_THREADS,
  rightPanelMode: 'status',
  setRightPanelMode: vi.fn(),
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

const defaultProps = {
  sidebarOpen: false,
  onToggleSidebar: vi.fn(),
  authPendingCount: 0,
  viewMode: 'single' as const,
  onToggleViewMode: vi.fn(),
  onOpenMobileStatus: vi.fn(),
  statusPanelOpen: false,
  onToggleStatusPanel: vi.fn(),
  onOpenChannelSettings: vi.fn(),
  onOpenKnowledgeCapture: vi.fn(),
  defaultCatId: 'opus',
};

describe('ChatContainerHeader thread indicator', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockStore.threads = TEST_THREADS;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  const renderHeader = (threadId: string) => {
    container.innerHTML = renderToStaticMarkup(React.createElement(ChatContainerHeader, { ...defaultProps, threadId }));
    return container;
  };

  it('shows "大厅" when threadId is default', () => {
    const rendered = renderHeader('default');
    expect(rendered.textContent).toContain('大厅');
    expect(rendered.querySelector('[data-testid="channel-stamp"]')?.textContent).toBe('#');
  });

  it('shows thread title and decorates a confirmed channel', () => {
    const rendered = renderHeader('thread_xyz');
    expect(rendered.textContent).toContain('讨论 F095 设计');

    container.innerHTML = renderToStaticMarkup(
      React.createElement(ThreadIndicator, { threadId: 'thread_xyz', showChannelStamp: true }),
    );
    expect(container.querySelector('[data-testid="channel-stamp"]')?.textContent).toBe('#');
  });

  it('shows "未命名对话" when thread has no title', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_no_title', title: null }];
    expect(renderHeader('thread_no_title').textContent).toContain('未命名对话');
  });

  it('does not flash a channel stamp for a direct message before hydration', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_dm', title: '专家-Claude', isDM: true }];
    const rendered = renderHeader('thread_dm');

    expect(rendered.textContent).toContain('专家-Claude');
    expect(rendered.querySelector('[data-testid="channel-stamp"]')).toBeNull();
  });

  it('does not decorate direct messages with a channel stamp', () => {
    container.innerHTML = renderToStaticMarkup(
      React.createElement(ThreadIndicator, { threadId: 'thread_xyz', showChannelStamp: false }),
    );

    expect(container.textContent).toContain('讨论 F095 设计');
    expect(container.querySelector('[data-testid="channel-stamp"]')).toBeNull();
  });

  it('shows a durable branch badge and parent breadcrumb after rename', () => {
    mockStore.threads = [
      ...TEST_THREADS,
      {
        ...TEST_THREADS[0],
        id: 'thread_branch',
        title: '已经改名',
        relation: {
          v: 1,
          kind: 'inline_reply',
          parentThreadId: 'thread_xyz',
          rootMessageId: '0000000000000001-000001-aabbccdd',
        },
      },
    ];

    container.innerHTML = renderToStaticMarkup(
      React.createElement(ThreadIndicator, { threadId: 'thread_branch', showChannelStamp: true }),
    );

    expect(container.querySelector('[data-testid="branch-badge"]')?.textContent).toContain('分支');
    expect(container.querySelector('[data-testid="branch-breadcrumb"]')?.textContent).toContain('讨论 F095 设计');
    expect(container.querySelector('[data-testid="channel-stamp"]')).toBeNull();
  });

  it('treats a missing parent as an orphan without inventing a parent title', () => {
    mockStore.threads = [
      {
        ...TEST_THREADS[0],
        id: 'thread_orphan',
        title: '孤儿分支',
        relation: {
          v: 1,
          kind: 'edit_branch',
          parentThreadId: 'PRIVATE_PARENT_ID',
          rootMessageId: '0000000000000002-000001-aabbccdd',
        },
      },
    ];

    container.innerHTML = renderToStaticMarkup(
      React.createElement(ThreadIndicator, { threadId: 'thread_orphan', showChannelStamp: true }),
    );

    expect(container.querySelector('[data-testid="branch-breadcrumb"]')?.textContent).toContain('孤立 Thread');
    expect(container.textContent).not.toContain('PRIVATE_PARENT_ID');
  });

  it('does not infer branch identity from a branch-like title', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'title_only', title: '预算 (分支)' }];

    container.innerHTML = renderToStaticMarkup(
      React.createElement(ThreadIndicator, { threadId: 'title_only', showChannelStamp: true }),
    );

    expect(container.querySelector('[data-testid="branch-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-stamp"]')?.textContent).toBe('#');
  });
});
