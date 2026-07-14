import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockApiFetch = vi.fn(async (_url: string, _opts?: Record<string, unknown>) => ({ ok: true }));
const mockConfirmUnreadAck = vi.fn();
const mockArmUnreadSuppression = vi.fn();

type StoreMessage = {
  id: string;
  type: 'assistant' | 'user' | 'system';
  content: string;
  timestamp: number;
  catId?: string | null;
};

type StoreThread = {
  id: string;
  projectPath: string;
  title: string | null;
  createdBy: string;
  participants: string[];
  lastActiveAt: number;
  createdAt: number;
  unreadCount?: number;
  hasUserMention?: boolean;
  lastReadMessageId?: string;
};

// Mutable store state — mutate between renders to simulate thread switching
let storeState: { currentThreadId: string; messages: StoreMessage[]; threads?: StoreThread[] } = {
  currentThreadId: 'thread-A',
  messages: [
    {
      id: '0000001772900001-000001-aabbcc01',
      type: 'assistant' as const,
      content: 'hello from A',
      timestamp: Date.now(),
      catId: 'opus',
    },
  ],
};

const baseStore = () => ({
  ...storeState,
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  activeInvocations: {},
  addMessage: vi.fn(),
  removeMessage: vi.fn(),
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setTargetCats: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCurrentThread: vi.fn(),
  setCurrentProject: vi.fn(),
  updateThreadTitle: vi.fn(),
  setCurrentGame: vi.fn(),
  currentGame: null,

  viewMode: 'single' as const,
  setViewMode: vi.fn(),
  clearUnread: vi.fn(),
  confirmUnreadAck: mockConfirmUnreadAck,
  armUnreadSuppression: mockArmUnreadSuppression,
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  rightPanelMode: null,
  uiThinkingExpandedByDefault: false,
  queue: [],
  queuePaused: false,
  queuePauseReason: null,
  queueFull: false,
  queueFullSource: null,
  threads: storeState.threads ?? [],
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof baseStore>) => unknown) => {
    const state = baseStore();
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: string[]) => mockApiFetch(args[0], args[1] as unknown as Record<string, unknown>),
  API_URL: 'http://localhost:3004',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({ tasks: [], addTask: vi.fn(), updateTask: vi.fn(), clearTasks: vi.fn() }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ cancelInvocation: vi.fn(), syncRooms: vi.fn() }),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: vi.fn(),
    handleStop: vi.fn(),
    resetRefs: vi.fn(),
    resetTimeout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));

vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));

vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    hasFetched: true,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: async () => [],
  }),
}));

vi.mock('../ChatMessage', () => ({ ChatMessage: () => null, shouldRenderChatMessage: () => true }));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('../MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('@/components/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@/components/AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));

describe('F069-R5: read ack via POST /read/latest', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;
  let visibilityStateSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    visibilityStateSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ ok: true });
    mockConfirmUnreadAck.mockClear();
    mockArmUnreadSuppression.mockClear();
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        {
          id: '0000001772900001-000001-aabbcc01',
          type: 'assistant' as const,
          content: 'hello from A',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
      threads: [],
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    hasFocusSpy.mockRestore();
    visibilityStateSpy.mockRestore();
  });

  it('sends POST /read/latest on mount (no message ID needed)', async () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0][0]).toContain('thread-A');
    expect(ackCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('fires new POST /read/latest when threadId changes', async () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    mockApiFetch.mockClear();

    // Switch to thread-B
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-B' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0][0]).toContain('thread-B');
  });

  it('works regardless of message content (even all-synthetic)', async () => {
    // With R5, ack does not depend on frontend messages at all — server resolves the latest.
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        { id: 'draft-inv-1', type: 'assistant' as const, content: '...', timestamp: Date.now(), catId: 'opus' },
        {
          id: 'bg-sys-1772900004-opus-1',
          type: 'assistant' as const,
          content: 'info',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
      threads: [],
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should STILL fire — unlike old approach which skipped when no real IDs were in cache
    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
  });

  it('re-acks when new messages arrive in the active thread (P1 regression)', async () => {
    // Initial render with 1 message
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have fired once on mount
    const initialCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(initialCalls.length).toBe(1);
    mockApiFetch.mockClear();

    // Simulate new message arriving (messages.length changes from 1 → 2)
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        {
          id: '0000001772900001-000001-aabbcc01',
          type: 'assistant' as const,
          content: 'hello from A',
          timestamp: Date.now(),
          catId: 'opus',
        },
        {
          id: '0000001772900002-000002-aabbcc02',
          type: 'assistant' as const,
          content: 'new reply',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
      threads: [],
    };

    // Re-render with updated store state (simulating store update from socket)
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should fire again because messageCount changed — so switching away after this
    // will have the cursor advanced to the new message
    const newCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(newCalls.length).toBe(1);
    expect(newCalls[0][0]).toContain('thread-A');
  });

  it.each([
    ['hidden', 'hidden' as const, true],
    ['unfocused', 'visible' as const, false],
  ])('does not ack newly arrived messages while the tab is %s', async (_label, visibility, hasFocus) => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    mockApiFetch.mockClear();

    visibilityStateSpy.mockReturnValue(visibility);
    hasFocusSpy.mockReturnValue(hasFocus);
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        ...storeState.messages,
        {
          id: '0000001772900002-000002-aabbcc02',
          type: 'assistant',
          content: 'arrived while hidden',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
      threads: [],
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls).toHaveLength(0);
  });

  it('acks deferred messages once when the tab becomes visible and focused again', async () => {
    visibilityStateSpy.mockReturnValue('hidden');
    hasFocusSpy.mockReturnValue(false);
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockApiFetch.mock.calls.filter((call) => String(call[0]).includes('/read/latest'))).toHaveLength(0);

    visibilityStateSpy.mockReturnValue('visible');
    hasFocusSpy.mockReturnValue(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0][0]).toContain('thread-A');
  });

  it.each([
    ['non-2xx response', () => Promise.resolve({ ok: false })],
    ['network rejection', () => Promise.reject(new Error('network unavailable'))],
  ])('settles suppression after %s so a later attention retry can clear it', async (_label, failOnce) => {
    let readAckAttempts = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (String(url).includes('/read/latest') && readAckAttempts++ === 0) return await failOnce();
      return { ok: true };
    });

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockArmUnreadSuppression).toHaveBeenCalledTimes(1);
    expect(mockConfirmUnreadAck).toHaveBeenCalledTimes(1);

    visibilityStateSpy.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibilityStateSpy.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });

    // Every arm attempt, successful or failed, has one matching settlement.
    // The second successful retry therefore leaves the store ledger at zero.
    expect(mockArmUnreadSuppression).toHaveBeenCalledTimes(2);
    expect(mockConfirmUnreadAck).toHaveBeenCalledTimes(2);
  });

  it('renders unread divider before the first message after the read cursor', async () => {
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        {
          id: '0000001772900001-000001-aabbcc01',
          type: 'assistant',
          content: 'read reply',
          timestamp: Date.now() - 1000,
          catId: 'opus',
        },
        {
          id: '0000001772900002-000002-aabbcc02',
          type: 'assistant',
          content: 'unread reply',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
      threads: [
        {
          id: 'thread-A',
          projectPath: '',
          title: 'A',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now() - 2000,
          unreadCount: 1,
          hasUserMention: false,
          lastReadMessageId: '0000001772900001-000001-aabbcc01',
        },
      ],
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('上次读到这里');
  });
});
