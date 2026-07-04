import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useTaskStore } from '@/stores/taskStore';

const apiFetchMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn());

const cats: CatData[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [],
    clientId: 'openai',
    defaultModel: '',
    avatar: '',
    roleDescription: '',
    personality: '',
  },
  {
    id: 'claude',
    displayName: 'Claude',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [],
    clientId: 'anthropic',
    defaultModel: '',
    avatar: '',
    roleDescription: '',
    personality: '',
  },
];

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
  useCatData: () => ({ cats }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { removeThreadMessage: () => void; patchMessage: () => void }) => unknown) =>
    selector({ removeThreadMessage: vi.fn(), patchMessage: vi.fn() }),
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

function renderMessageActions(root: Root) {
  root.render(
    <MessageActions
      message={{
        id: 'msg-1',
        type: 'assistant',
        catId: 'codex',
        content: '部署完成后检查结果',
        timestamp: Date.now(),
      }}
      threadId="thread-1"
    >
      <div>message body</div>
    </MessageActions>,
  );
}

async function openReminderPanel(container: HTMLDivElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click();
  });
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent === '稍后提醒')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('MessageActions message reminders', () => {
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

  it('schedules a 30-minute reminder from the More menu', async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ reminders: [] }) }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'rem-1',
        catId: 'codex',
        threadId: 'thread-1',
        sourceMessageId: 'msg-1',
        message: '跟进这条消息：部署完成后检查结果',
        fireAt: Date.now() + 30 * 60 * 1000,
        status: 'scheduled',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    });

    await act(async () => renderMessageActions(root));
    await openReminderPanel(container);

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === '30分钟后')
        ?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/reminders?threadId=thread-1&sourceMessageId=msg-1&status=scheduled',
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/reminders',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"sourceMessageId":"msg-1"'),
      }),
    );
    const [, init] = apiFetchMock.mock.calls[1] as [string, { body?: string }];
    const body = JSON.parse(init.body ?? '{}') as { catId?: string; threadId?: string; message?: string };
    expect(body.catId).toBe('codex');
    expect(body.threadId).toBe('thread-1');
    expect(body.message).toContain('部署完成后检查结果');
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title: '已设置稍后提醒' }));
  });

  it('loads and cancels an existing reminder for the source message', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reminders: [
            {
              id: 'rem-1',
              catId: 'codex',
              threadId: 'thread-1',
              sourceMessageId: 'msg-1',
              message: '跟进这条消息：部署完成后检查结果',
              fireAt: Date.now() + 30 * 60 * 1000,
              status: 'scheduled',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'rem-1', status: 'canceled' }) });

    await act(async () => renderMessageActions(root));
    await openReminderPanel(container);

    expect(container.textContent).toContain('已设置');

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === '取消提醒')
        ?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/reminders/rem-1/cancel', { method: 'POST' });
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', title: '已取消提醒' }));
  });
});
