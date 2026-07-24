import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';

const apiFetchMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { removeThreadMessage: () => void; patchMessage: () => void }) => unknown,
  ) => selector({ removeThreadMessage: vi.fn(), patchMessage: vi.fn() }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: addToastMock }),
  },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'user-1',
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const { MessageActions } = await import('@/components/MessageActions');

describe('MessageActions convert to task', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    addToastMock.mockReset();
    useTaskStore.setState({ tasks: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const baseTask = {
    id: 'task-1',
    kind: 'work' as const,
    threadId: 'thread-1',
    subjectKey: 'work-intake:thread-1:msg-1',
    title: '需要跟进的消息',
    ownerCatId: null,
    status: 'todo' as const,
    why: '由消息转为任务',
    createdBy: 'user' as const,
    createdAt: 1,
    updatedAt: 1,
    sourceMessageId: 'msg-1',
  };

  async function openMoreMenu() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click();
    });
  }

  function findConvertMenuItem() {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (button) => button.textContent === 'Convert to Task',
    );
  }

  it('calls the admitWorkMessage forced-path endpoint (POST /api/messages/:id/convert-to-task) and links the returned task', async () => {
    // [batch 2-E] PENDING 2-A: this endpoint does not exist in the backend yet —
    // assumed response contract {task: TaskItem, created: boolean}. See MessageActions.tsx
    // handleConvertToTask for the exact assumed request/response shape.
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ task: baseTask, created: true }),
    });

    await act(async () => {
      root.render(
        <MessageActions
          message={{
            id: 'msg-1',
            type: 'user',
            content: '需要跟进的消息\n第二行不用进标题',
            timestamp: Date.now(),
          }}
          threadId="thread-1"
        >
          <div>message body</div>
        </MessageActions>,
      );
    });

    await openMoreMenu();
    await act(async () => {
      findConvertMenuItem()?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/messages/msg-1/convert-to-task',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"userId":"user-1"'),
      }),
    );
    // messageId travels in the URL, not the body — no sourceMessageId duplication.
    expect(apiFetchMock.mock.calls[0][1].body).not.toContain('sourceMessageId');
    expect(useTaskStore.getState().tasks[0]?.id).toBe('task-1');
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title: '已转为任务' }));
  });

  it('shows an "already linked" toast instead of re-posting when the server reports created:false', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ task: baseTask, created: false }),
    });

    await act(async () => {
      root.render(
        <MessageActions message={{ id: 'msg-1', type: 'user', content: '需要跟进的消息', timestamp: Date.now() }} threadId="thread-1">
          <div>message body</div>
        </MessageActions>,
      );
    });

    await openMoreMenu();
    await act(async () => {
      findConvertMenuItem()?.click();
    });

    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title: '已关联任务' }));
  });

  it('Raft rule: hides the Convert to Task menu item for thread-nested messages (canConvertToTask=false)', async () => {
    await act(async () => {
      root.render(
        <MessageActions
          message={{ id: 'msg-2', type: 'user', content: '这是 thread 内的回复', timestamp: Date.now() }}
          threadId="branch-thread-1"
          canConvertToTask={false}
        >
          <div>message body</div>
        </MessageActions>,
      );
    });

    await openMoreMenu();
    expect(findConvertMenuItem()).toBeUndefined();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('top-level messages (canConvertToTask default true) still show the Convert to Task item', async () => {
    await act(async () => {
      root.render(
        <MessageActions message={{ id: 'msg-3', type: 'user', content: '主频道消息', timestamp: Date.now() }} threadId="thread-1">
          <div>message body</div>
        </MessageActions>,
      );
    });

    await openMoreMenu();
    expect(findConvertMenuItem()).toBeTruthy();
  });
});
