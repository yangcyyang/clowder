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

describe('InlineThreadPanel IME guard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrameId = 0;
  let animationFrames = new Map<number, FrameRequestCallback>();

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    animationFrameId = 0;
    animationFrames = new Map();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrameId += 1;
      animationFrames.set(animationFrameId, callback);
      return animationFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => animationFrames.delete(id));
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
    vi.unstubAllGlobals();
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

  async function setComposerValue(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function sentMessageRequests() {
    return apiFetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
    );
  }

  it('does not send while an IME composition consumes Enter or Space, including Chrome compositionend timing', async () => {
    await mountPanel();
    apiFetchMock.mockClear();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await setComposerValue(textarea, '中文候选词');

    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    });

    expect(sentMessageRequests()).toHaveLength(0);

    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      // Chrome fires this final Enter after compositionend but before the next animation frame.
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(sentMessageRequests()).toHaveLength(0);

    await act(async () => {
      for (const callback of animationFrames.values()) callback(performance.now());
      animationFrames.clear();
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(sentMessageRequests()).toHaveLength(1);
  });
});
