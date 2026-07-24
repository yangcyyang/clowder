/**
 * [thread-task-design §3 step 1.1] Regression test: the entry indicator ("N
 * replies") under a source message must move in real time when the server
 * pushes `thread_reply_count_updated` (packages/api/src/routes/thread-reply-
 * summary.ts notifyBranchThreadReply), without the viewer having joined the
 * branch thread room. Guard: useChatSocketCallbacks.onThreadReplyCountUpdated
 * patches the source message's extra.slockThread.replyCount from the event.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const patchMessageMock = vi.fn();

let mockMessages: Array<{
  id: string;
  extra?: { slockThread?: { branchThreadId: string; replyCount: number; latestReply?: unknown } };
}> = [];

vi.mock('@/stores/chatStore', () => {
  const useChatStore = () => ({
    updateThreadTitle: vi.fn(),
    updateThreadParticipants: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    addActiveInvocation: vi.fn(),
    removeThreadMessage: vi.fn(),
    patchMessage: patchMessageMock,
    requestStreamCatchUp: vi.fn(),
  });
  useChatStore.getState = () => ({ messages: mockMessages });
  return { useChatStore };
});

vi.mock('@/stores/gameStore', () => ({
  useGameStore: { getState: () => ({ setGameView: vi.fn() }) },
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: vi.fn(),
    updateTask: vi.fn(),
  }),
}));

const { useChatSocketCallbacks } = await import('../useChatSocketCallbacks');

import type { SocketCallbacks } from '../useSocket';

let captured: SocketCallbacks | null = null;

function HookHost({ threadId }: { threadId: string }) {
  captured = useChatSocketCallbacks({
    threadId,
    userId: 'user-1',
    handleAgentMessage: vi.fn(() => true) as unknown as SocketCallbacks['onMessage'],
    resetTimeout: vi.fn(),
    clearDoneTimeout: vi.fn(),
    handleAuthRequest: vi.fn(),
    handleAuthResponse: vi.fn(),
  });
  return null;
}

let root: Root;
let container: HTMLDivElement;

describe('useChatSocketCallbacks: thread_reply_count_updated', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    patchMessageMock.mockClear();
    mockMessages = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('patches the source message replyCount from a fresh event (no prior slockThread)', () => {
    captured!.onThreadReplyCountUpdated!({
      sourceMessageId: 'message-root',
      branchThreadId: 'thread-task',
      replyCount: 3,
    });

    expect(patchMessageMock).toHaveBeenCalledWith('message-root', {
      extra: { slockThread: { branchThreadId: 'thread-task', replyCount: 3 } },
    });
  });

  it('bumps an existing replyCount upward and keeps other slockThread fields', () => {
    mockMessages = [
      {
        id: 'message-root',
        extra: {
          slockThread: {
            branchThreadId: 'thread-task',
            replyCount: 3,
            latestReply: { id: 'reply-1', catId: 'opus', content: 'old', timestamp: 1 },
          },
        },
      },
    ];

    captured!.onThreadReplyCountUpdated!({
      sourceMessageId: 'message-root',
      branchThreadId: 'thread-task',
      replyCount: 4,
    });

    expect(patchMessageMock).toHaveBeenCalledWith('message-root', {
      extra: {
        slockThread: {
          branchThreadId: 'thread-task',
          replyCount: 4,
          latestReply: { id: 'reply-1', catId: 'opus', content: 'old', timestamp: 1 },
        },
      },
    });
  });
});
