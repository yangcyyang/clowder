import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineThreadPanel } from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

const opus = {
  id: 'opus',
  displayName: 'Opus',
  name: 'Opus',
  color: { primary: '#8855ff', secondary: '#ddd' },
  defaultModel: 'claude-opus',
  provider: 'anthropic',
  clientId: 'anthropic',
  mentionPatterns: ['@opus'],
  roleDescription: '',
  personality: '',
  avatar: '',
  roster: { available: true },
};

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; name?: string; id: string }) => cat.displayName ?? cat.name ?? cat.id,
  useCatData: () => ({
    cats: [opus],
    getCatById: (catId: string) => (catId === opus.id ? opus : undefined),
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

const sourceMessage = {
  id: 'source-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
  threadId: 'thread-parent',
} as ChatMessage;

const assistantReply = {
  id: 'assistant-reply',
  type: 'assistant',
  catId: 'opus',
  content: '正在处理',
  timestamp: 2,
  threadId: 'thread-branch',
  isStreaming: false,
} as ChatMessage;

describe('InlineThreadPanel avatar activity', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queueActive: boolean;
  const initialStoreState = useChatStore.getState();

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    HTMLElement.prototype.scrollTo = vi.fn();
    queueActive = true;
    useChatStore.setState(initialStoreState, true);
    useChatStore.setState({ currentThreadId: 'thread-parent', catStatuses: {} });
    useChatStore.getState().updateThreadCatStatus('thread-branch', 'opus', 'streaming');
    useChatStore.getState().addThreadActiveInvocation('thread-branch', 'invocation-opus', 'opus', 'reply', Date.now());

    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage, assistantReply] }) });
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
    useChatStore.setState(initialStoreState, true);
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('uses the branch runtime state for the real ChatMessage avatar, then stops breathing when the branch completes', async () => {
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

    const activeDot = container.querySelector('[data-testid="cat-activity-dot"]');
    expect(activeDot?.getAttribute('data-cat-activity-status')).toBe('active');
    expect(activeDot?.className).toContain('animate-pulse');

    await act(async () => {
      queueActive = false;
      useChatStore.getState().removeThreadActiveInvocation('thread-branch', 'invocation-opus');
      useChatStore.getState().updateThreadCatStatus('thread-branch', 'opus', 'done');
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const idleDot = container.querySelector('[data-testid="cat-activity-dot"]');
    expect(idleDot?.getAttribute('data-cat-activity-status')).toBe('idle');
    expect(idleDot?.className).not.toContain('animate-pulse');
  });
});
