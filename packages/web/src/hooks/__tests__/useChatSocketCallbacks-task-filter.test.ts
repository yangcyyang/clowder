/**
 * Regression test: TaskPanel must only receive task events for the active thread.
 * Guard: socket callbacks filter by threadId.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const addTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const addMessageMock = vi.fn();
const addActiveInvocationMock = vi.fn();
const patchMessageMock = vi.fn();

// [thread-task-design §3 step 1.1] onThreadBranched reads current message state
// via useChatStore.getState() (module-level, not the hook) so it can preserve an
// already-live replyCount instead of clobbering it back to 0 — see the
// "preserves an existing replyCount" test below. mockMessages lets each test
// seed that read.
let mockMessages: Array<{
  id: string;
  extra?: { slockThread?: { branchThreadId: string; replyCount: number } };
}> = [];

vi.mock('@/stores/chatStore', () => {
  const useChatStore = () => ({
    updateThreadTitle: vi.fn(),
    updateThreadParticipants: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    addMessage: addMessageMock,
    addActiveInvocation: addActiveInvocationMock,
    removeMessage: vi.fn(),
    removeThreadMessage: vi.fn(),
    patchMessage: patchMessageMock,
    requestStreamCatchUp: vi.fn(),
  });
  useChatStore.getState = () => ({ messages: mockMessages });
  return { useChatStore };
});

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: addTaskMock,
    updateTask: updateTaskMock,
  }),
}));

const { useChatSocketCallbacks } = await import('../useChatSocketCallbacks');

import type { SocketCallbacks } from '../useSocket';

let captured: SocketCallbacks | null = null;

function HookHost({ threadId }: { threadId: string }) {
  captured = useChatSocketCallbacks({
    threadId,
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

describe('TaskPanel socket filter: threadId guard', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    addTaskMock.mockClear();
    updateTaskMock.mockClear();
    addMessageMock.mockClear();
    addActiveInvocationMock.mockClear();
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

  // --- threadId filter ---

  it('blocks task_created from a different thread', () => {
    captured!.onTaskCreated!({ id: 't2', threadId: 'thread-other', kind: 'work', title: 'review' });
    expect(addTaskMock).not.toHaveBeenCalled();
  });

  it('blocks task_updated from a different thread', () => {
    captured!.onTaskUpdated!({ id: 't2', threadId: 'thread-other', kind: 'work', status: 'doing' });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  // --- happy path ---

  it('allows work task_created for the active thread', () => {
    captured!.onTaskCreated!({ id: 't3', threadId: 'thread-1', kind: 'work', title: 'fix bug' });
    expect(addTaskMock).toHaveBeenCalledTimes(1);
  });

  it('allows work task_updated for the active thread', () => {
    captured!.onTaskUpdated!({ id: 't3', threadId: 'thread-1', kind: 'work', status: 'done' });
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
  });

  it('registers active invocation without creating a placeholder on spawn_started', () => {
    captured!.onSpawnStarted!({
      threadId: 'thread-1',
      invocationId: 'inv-kimi-1',
      targetCats: ['kimi'],
    });

    expect(addMessageMock).not.toHaveBeenCalled();
    expect(addActiveInvocationMock).toHaveBeenCalledWith('inv-kimi-1', 'kimi', 'execute', expect.any(Number));
  });

  it('patches the live parent root when the server creates a task thread branch', () => {
    captured!.onThreadBranched!({
      sourceThreadId: 'thread-1',
      newThreadId: 'thread-task',
      fromMessageId: 'message-root',
    });
    expect(patchMessageMock).toHaveBeenCalledWith('message-root', {
      extra: { slockThread: { branchThreadId: 'thread-task', replyCount: 0 } },
    });
  });

  // [thread-task-design §2 root cause 2 / §3 step 1.1] Regression test for the bug fix:
  // thread_branched used to hardcode replyCount:0 unconditionally, which could clobber a
  // real live count (e.g. thread_reply_count_updated already bumped it) if this event
  // ever re-fires for the same message (reconnect replay, re-announce, etc).
  it('preserves an existing live replyCount instead of resetting it to 0 on re-branch', () => {
    mockMessages = [
      {
        id: 'message-root',
        extra: { slockThread: { branchThreadId: 'thread-task-old', replyCount: 5 } },
      },
    ];

    captured!.onThreadBranched!({
      sourceThreadId: 'thread-1',
      newThreadId: 'thread-task',
      fromMessageId: 'message-root',
    });

    expect(patchMessageMock).toHaveBeenCalledWith('message-root', {
      extra: { slockThread: { branchThreadId: 'thread-task', replyCount: 5 } },
    });
  });
});
