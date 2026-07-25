/**
 * F194 Raft-parity batch 3-C: task-discussion-kind threads (auto/anchored
 * task or @mention discussion branches) must be pulled out of CHANNELS into
 * their own collapsible "任务讨论" section — default collapsed, count badge
 * always visible. See docs/research/clowder-raft-thread-task-design.md §1/§4
 * and ThreadSidebar.tsx's channelEligibleThreads/taskDiscussionThreads split.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSidebar } from '../ThreadSidebar';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

const now = Date.now();

const CHANNEL_THREAD = {
  id: 'thread-channel',
  title: '设计讨论',
  projectPath: 'default',
  createdBy: 'default-user',
  participants: [] as string[],
  lastActiveAt: now,
  createdAt: now,
  pinned: false,
  favorited: false,
  preferredCats: [] as string[],
};

const TASK_DISCUSSION_THREAD = {
  ...CHANNEL_THREAD,
  id: 'thread-task-discussion',
  title: '书籍分析任务 (分支)',
  relation: { v: 1 as const, kind: 'task_thread' as const, parentThreadId: CHANNEL_THREAD.id, rootMessageId: 'msg-1' },
  lastActiveAt: now - 1000,
};

const MESSAGE_ANCHOR_THREAD = {
  ...CHANNEL_THREAD,
  id: 'thread-message-anchor',
  title: '@猫回复锚点 (分支)',
  relation: {
    v: 1 as const,
    kind: 'message_thread' as const,
    parentThreadId: CHANNEL_THREAD.id,
    rootMessageId: 'msg-2',
  },
  lastActiveAt: now - 2000,
};

type TestThread = typeof CHANNEL_THREAD & {
  relation?: { v: 1; kind: string; parentThreadId: string; rootMessageId: string };
};

let storeThreads: TestThread[] = [CHANNEL_THREAD, TASK_DISCUSSION_THREAD, MESSAGE_ANCHOR_THREAD];
const mockStore: Record<string, unknown> = {
  get threads() {
    return storeThreads;
  },
  currentThreadId: 'default',
  setThreads: vi.fn((threads: typeof storeThreads) => {
    storeThreads = threads;
  }),
  setCurrentProject: vi.fn(),
  isLoadingThreads: false,
  setLoadingThreads: vi.fn(),
  updateThreadTitle: vi.fn(),
  getThreadState: () => ({ catStatuses: {}, unreadCount: 0 }),
  updateThreadPin: vi.fn(),
  updateThreadFavorite: vi.fn(),
  updateThreadPreferredCats: vi.fn(),
  threadStates: {},
  catStatuses: {},
  clearUnread: vi.fn(),
  clearAllUnread: vi.fn(),
  initThreadUnread: vi.fn(),
  fetchGlobalBubbleDefaults: vi.fn(),
};

vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: vi.fn() }),
  },
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
  formatCatName: (cat: { name?: string; id: string }) => cat.name ?? cat.id,
}));

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

describe('ThreadSidebar task-discussion grouping', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [CHANNEL_THREAD, TASK_DISCUSSION_THREAD, MESSAGE_ANCHOR_THREAD];
    pushMock.mockReset();
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: storeThreads });
      return jsonOk({});
    });
    mockStore.threadStates = {};
    mockStore.catStatuses = {};
    mockStore.setThreads = vi.fn((threads: typeof storeThreads) => {
      storeThreads = threads;
    });

    const storage: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
        removeItem: (key: string) => {
          delete storage[key];
        },
      },
      writable: true,
      configurable: true,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('keeps task_discussion-kind threads out of the CHANNELS list', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    expect(container.querySelector('[data-thread-id="thread-channel"]')).not.toBeNull();
    expect(container.querySelector('[data-thread-id="thread-task-discussion"]')).toBeNull();
    expect(container.querySelector('[data-thread-id="thread-message-anchor"]')).toBeNull();
  });

  it('renders a collapsed-by-default 任务讨论 section with a count badge', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    const title = container.querySelector('[data-testid="task-discussions-section-title"]');
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe('任务讨论');
    // Count badge shows 2 even while collapsed.
    expect(title?.parentElement?.textContent).toContain('2');
    // Collapsed: rows not rendered.
    expect(container.textContent).not.toContain('书籍分析任务 (分支)');
    expect(container.textContent).not.toContain('@猫回复锚点 (分支)');

    const expandButton = container.querySelector('button[aria-label="展开任务讨论"]') as HTMLButtonElement | null;
    expect(expandButton).not.toBeNull();
  });

  it('expands to reveal task discussion rows and collapses back on toggle', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    const expandButton = container.querySelector('button[aria-label="展开任务讨论"]') as HTMLButtonElement | null;
    expect(expandButton).not.toBeNull();

    await act(async () => {
      expandButton?.click();
    });
    await flush();

    expect(container.textContent).toContain('书籍分析任务 (分支)');
    expect(container.textContent).toContain('@猫回复锚点 (分支)');
    expect(container.querySelector('[data-thread-id="thread-task-discussion"]')).not.toBeNull();

    const collapseButton = container.querySelector('button[aria-label="折叠任务讨论"]') as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    await act(async () => {
      collapseButton?.click();
    });
    await flush();

    expect(container.textContent).not.toContain('书籍分析任务 (分支)');
  });

  it('shows an empty state when there are no task discussion threads', async () => {
    storeThreads = [CHANNEL_THREAD];

    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    const title = container.querySelector('[data-testid="task-discussions-section-title"]');
    expect(title?.parentElement?.textContent).toContain('0');

    const expandButton = container.querySelector('button[aria-label="展开任务讨论"]') as HTMLButtonElement | null;
    await act(async () => {
      expandButton?.click();
    });
    await flush();

    expect(container.textContent).toContain('暂无任务讨论');
  });
});
