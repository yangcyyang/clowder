/**
 * #404-interaction item 2: the reply list should auto-follow the bottom when the reader is
 * already there, but never yank someone who has scrolled up to read history — instead it
 * surfaces a content-free "N 条新消息" jump button. Content-free by design (no reply preview
 * text), so this feature has no whisper surface to gate.
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

function makeReply(id: string, timestamp: number): ChatMessage {
  return { id, type: 'user', content: `回复 ${id}`, timestamp } as ChatMessage;
}

function setScrollMetrics(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: Record<string, number>) {
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('InlineThreadPanel scroll-follow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let messagesResponse: ChatMessage[];
  let scrollToSpy: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    messagesResponse = [sourceMessage];
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: messagesResponse }) });
      }
      if (url.startsWith('/api/threads/')) {
        // Non-empty so the 2s runtime poll (gated on runtimeCats.length > 0) actually registers.
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    scrollToSpy = vi.fn();
    HTMLElement.prototype.scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo'];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
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

  it('auto-scrolls to bottom when a new reply arrives and the reader was already near the bottom', async () => {
    await mountPanel();
    const scrollEl = container.querySelector('.absolute.inset-0.overflow-y-auto') as HTMLElement;
    expect(scrollEl).toBeTruthy();
    setScrollMetrics(scrollEl, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      scrollEl.dispatchEvent(new Event('scroll'));
    });

    messagesResponse = [sourceMessage, makeReply('r1', 10)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(scrollToSpy).toHaveBeenCalled();
    expect(container.textContent).not.toContain('条新消息');
  });

  it('does not auto-scroll and shows a content-free "N 条新消息" button when the reader has scrolled up', async () => {
    await mountPanel();
    const scrollEl = container.querySelector('.absolute.inset-0.overflow-y-auto') as HTMLElement;
    setScrollMetrics(scrollEl, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      scrollEl.dispatchEvent(new Event('scroll'));
    });
    scrollToSpy.mockClear();

    messagesResponse = [sourceMessage, makeReply('r1', 10)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(scrollToSpy).not.toHaveBeenCalled();
    const jumpButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('条新消息'),
    );
    expect(jumpButton?.textContent).toContain('1 条新消息');
    // No reply content/preview text anywhere near the button — content-free by design.
    expect(jumpButton?.textContent).not.toContain('回复 r1');

    await act(async () => {
      jumpButton?.click();
    });
    expect(scrollToSpy).toHaveBeenCalled();
    expect(container.textContent).not.toContain('条新消息');
  });
});
