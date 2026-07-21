/**
 * #404-interaction item 3: Escape closes the thread panel — but only when no sub-widget
 * (search bar / slash-command picker / mention picker) is already handling it. Those
 * handlers only call preventDefault (not stopPropagation), so the keypress still bubbles to
 * the panel root; the panel-level handler must check their current open state and defer.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [] }),
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

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

describe('InlineThreadPanel Escape-to-close', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({ ok: true, json: async () => ({ activeInvocations: [] }) });
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
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function mountPanel(onClose: () => void) {
    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-branch"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={onClose}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('Escape with no sub-widget open closes the panel', async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);

    const aside = container.querySelector('aside') as HTMLElement;
    act(() => {
      aside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape while the search bar is open closes search instead of the panel', async () => {
    const onClose = vi.fn();
    await mountPanel(onClose);

    const searchToggle = container.querySelector('button[aria-label="搜索 Thread"]') as HTMLButtonElement;
    await act(async () => {
      searchToggle.click();
    });
    expect(container.querySelector('input[aria-label="搜索当前 Thread"]')).toBeTruthy();

    const searchInput = container.querySelector('input[aria-label="搜索当前 Thread"]') as HTMLInputElement;
    act(() => {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="搜索当前 Thread"]')).toBeNull();
  });
});
