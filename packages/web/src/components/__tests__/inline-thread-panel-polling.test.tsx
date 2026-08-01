import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineThreadPanel } from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: 'Opus',
        name: 'Opus',
        color: { primary: '#8855ff' },
        defaultModel: 'claude-opus',
        provider: 'anthropic',
        clientId: 'anthropic',
        mentionPatterns: ['@opus'],
        roleDescription: '',
        avatar: '',
        roster: { available: true },
      },
    ],
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/components/ChatMessage', () => ({
  ChatMessage: () => React.createElement('div', null, 'message'),
  shouldRenderChatMessage: () => true,
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

const sourceMessage = {
  id: 'source-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

function isMessagesPoll(call: unknown[]) {
  return String(call[0]).startsWith('/api/messages?');
}

function isQueuePoll(call: unknown[]) {
  return call[0] === '/api/threads/thread-branch/queue';
}

describe('InlineThreadPanel polling coordinator', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queueActive: boolean;
  let visibilityState: DocumentVisibilityState;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    queueActive = true;
    visibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/messages' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url === '/api/threads/thread-branch/queue') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            activeInvocations: queueActive ? [{ catId: 'opus', mode: 'reply', startedAt: Date.now() }] : [],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function mountPanel() {
    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-branch"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function sendReply() {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '继续处理');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('runs only one messages+queue polling cycle after send while the branch is active', async () => {
    await mountPanel();
    await sendReply();
    apiFetchMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiFetchMock.mock.calls.filter(isMessagesPoll)).toHaveLength(5);
    expect(apiFetchMock.mock.calls.filter(isQueuePoll)).toHaveLength(5);
  });

  it('pauses polling while hidden, refreshes once on visibility, and stops after the branch becomes inactive', async () => {
    await mountPanel();
    apiFetchMock.mockClear();

    visibilityState = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiFetchMock.mock.calls.filter(isMessagesPoll)).toHaveLength(0);
    expect(apiFetchMock.mock.calls.filter(isQueuePoll)).toHaveLength(0);

    queueActive = false;
    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiFetchMock.mock.calls.filter(isMessagesPoll)).toHaveLength(1);
    expect(apiFetchMock.mock.calls.filter(isQueuePoll)).toHaveLength(1);

    apiFetchMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetchMock.mock.calls.filter(isMessagesPoll)).toHaveLength(0);
    expect(apiFetchMock.mock.calls.filter(isQueuePoll)).toHaveLength(0);
  });
});
