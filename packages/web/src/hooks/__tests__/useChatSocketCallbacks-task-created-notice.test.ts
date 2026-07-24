/**
 * [thread-task-design §3 step 1.2] Regression test: a live task_created event
 * that carries both sourceMessageId and taskThreadId must immediately mark the
 * source message with extra.taskCreatedNotice so ChatMessage can render the
 * "已建任务 #<label> · 回复将进入任务 Thread →" inline bar without waiting for a
 * history reload. Guard: useChatSocketCallbacks.onTaskCreated.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const addTaskMock = vi.fn();
const patchMessageMock = vi.fn();

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
  useChatStore.getState = () => ({ messages: [] });
  return { useChatStore };
});

vi.mock('@/stores/gameStore', () => ({
  useGameStore: { getState: () => ({ setGameView: vi.fn() }) },
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: addTaskMock,
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

describe('useChatSocketCallbacks: task_created inline notice marker', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    addTaskMock.mockClear();
    patchMessageMock.mockClear();
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

  it('marks the source message with taskCreatedNotice when sourceMessageId + taskThreadId are both present', () => {
    captured!.onTaskCreated!({
      id: 'task-1',
      threadId: 'thread-1',
      kind: 'work',
      title: 'fix bug',
      sourceMessageId: 'message-root',
      taskThreadId: 'thread-task-1',
    });

    expect(addTaskMock).toHaveBeenCalledTimes(1);
    expect(patchMessageMock).toHaveBeenCalledWith('message-root', {
      extra: { taskCreatedNotice: { taskId: 'task-1', taskThreadId: 'thread-task-1' } },
    });
  });

  it('does not mark any message when the task has no sourceMessageId (Tasks-tab manual create)', () => {
    captured!.onTaskCreated!({
      id: 'task-2',
      threadId: 'thread-1',
      kind: 'work',
      title: 'manual task',
      taskThreadId: 'thread-task-2',
    });

    expect(addTaskMock).toHaveBeenCalledTimes(1);
    expect(patchMessageMock).not.toHaveBeenCalled();
  });

  it('does not mark any message when taskThreadId is not yet set (lazy thread creation)', () => {
    captured!.onTaskCreated!({
      id: 'task-3',
      threadId: 'thread-1',
      kind: 'work',
      title: 'no thread yet',
      sourceMessageId: 'message-root',
    });

    expect(addTaskMock).toHaveBeenCalledTimes(1);
    expect(patchMessageMock).not.toHaveBeenCalled();
  });
});
