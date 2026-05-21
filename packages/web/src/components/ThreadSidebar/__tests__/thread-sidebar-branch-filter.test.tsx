import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSidebar } from '../ThreadSidebar';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

const now = Date.now();
const VISIBLE_THREAD = {
  id: 'thread-visible',
  title: '工作处理疑惑',
  projectPath: 'default',
  createdBy: 'default-user',
  participants: [] as string[],
  lastActiveAt: now,
  createdAt: now,
  pinned: false,
  favorited: false,
  preferredCats: [] as string[],
};
const BRANCH_WITH_SUFFIX = {
  ...VISIBLE_THREAD,
  id: 'thread-branch-suffix',
  title: '工作处理疑惑 (分支)',
};
const BRANCH_WITH_FALLBACK_TITLE = {
  ...VISIBLE_THREAD,
  id: 'thread-branch-fallback',
  title: '分支对话',
};
const DIRECT_AGENT_THREAD = {
  ...VISIBLE_THREAD,
  id: 'thread-direct-codex',
  title: 'Codex (GPT-5.5)',
  preferredCats: ['gpt52'],
  participatingCats: ['gpt52'],
  isDM: false,
};

type TestThread = typeof VISIBLE_THREAD & {
  preferredCats: string[];
  participatingCats?: string[];
  isDM?: boolean;
};

let storeThreads: TestThread[] = [VISIBLE_THREAD, BRANCH_WITH_SUFFIX, BRANCH_WITH_FALLBACK_TITLE];
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

describe('ThreadSidebar branch thread filtering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [VISIBLE_THREAD, BRANCH_WITH_SUFFIX, BRANCH_WITH_FALLBACK_TITLE];
    mockPush.mockReset();
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

  it('keeps branch threads out of the sidebar channel list', async () => {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    expect(container.textContent).toContain('工作处理疑惑');
    expect(container.textContent).not.toContain('工作处理疑惑 (分支)');
    expect(container.textContent).not.toContain('分支对话');
  });

  it('keeps single-agent direct threads out of the channel list', async () => {
    storeThreads = [VISIBLE_THREAD, DIRECT_AGENT_THREAD];

    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();

    expect(container.querySelector('[data-thread-id="thread-visible"]')).not.toBeNull();
    expect(container.querySelector('[data-thread-id="thread-direct-codex"]')).toBeNull();
  });
});
