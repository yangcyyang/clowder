/**
 * Bug repro: 铲屎官报告 InlineThreadPanel 在零操作情况下自动在不同 thread 之间切换——
 * 头部"回复自"显示正确的 thread，但面板消息内容却是另一条正在流式的 thread 的讨论。
 *
 * Root cause (see InlineThreadPanel.tsx loadMessages/loadQueueRuntime): ChatContainer
 * renders a single, reused <InlineThreadPanel> instance (no key={threadId}), so switching
 * from thread A to thread B only changes props — it does not unmount/remount. loadMessages's
 * `mountedRef` guard only detects true component unmount, not "the threadId prop moved on to
 * a different thread." So if thread A's `/api/messages?threadId=A` request is still in
 * flight when the user switches to thread B (very likely when thread A has a cat actively
 * streaming under concurrent load — exactly tonight's scenario with multiple branch threads
 * live at once), thread A's stale response can resolve AFTER thread B's own response and
 * blindly overwrite `messages` state with thread A's content — while the header (driven
 * synchronously by the `sourceMessage` prop) already correctly shows thread B's source.
 *
 * This test pins the invariant demanded by the fix: once the panel is anchored to a thread
 * via props, no async response belonging to a thread it has since navigated away from may
 * change what's rendered.
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
  ChatMessage: ({ message }: { message: { content: string } }) => React.createElement('div', null, message.content),
  shouldRenderChatMessage: () => true,
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceA = { id: 'source-a', type: 'user', content: '@宪宪 看下 grok 采集…', timestamp: 1 } as ChatMessage;
const sourceB = { id: 'source-b', type: 'user', content: '@大师 收到请只回一句：收到。', timestamp: 2 } as ChatMessage;

function makeReply(id: string, content: string, timestamp: number): ChatMessage {
  return { id, type: 'assistant', content, timestamp } as ChatMessage;
}

describe('InlineThreadPanel thread anchor race', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
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

  it('does not let a slow in-flight fetch for the previously-open thread clobber the newly-anchored thread', async () => {
    let resolveThreadAMessages: ((value: unknown) => void) | undefined;
    const threadAMessagesPromise = new Promise((resolve) => {
      resolveThreadAMessages = resolve;
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('threadId=thread-a')) {
        return threadAMessagesPromise.then(() => ({
          ok: true,
          json: async () => ({ messages: [sourceA, makeReply('reply-a', '芝芝流式回复中', 5)] }),
        }));
      }
      if (url.includes('threadId=thread-b')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ messages: [sourceB, makeReply('reply-b', '大师：收到。', 6)] }),
        });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({ ok: true, json: async () => ({ activeInvocations: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    // 1) 面板打开 thread-a（宪宪-thread），它的 /api/messages 请求还没 resolve。
    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-a"
          parentThreadId="thread-parent"
          sourceMessage={sourceA}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    // 2) 用户显式点开另一条消息的 Thread（大师-thread）—— thread-a 的请求仍在飞行中未 resolve。
    //    ChatContainer 复用同一个面板实例（无 key={threadId}），所以这里只是 props 变化。
    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-b"
          parentThreadId="thread-parent"
          sourceMessage={sourceB}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // thread-b 的内容应该已经正确显示。
    expect(container.textContent).toContain('大师：收到。');
    expect(container.textContent).not.toContain('芝芝流式回复中');

    // 3) thread-a 迟到的响应终于 resolve —— 绝不能覆盖已经切换到的 thread-b 内容。
    await act(async () => {
      resolveThreadAMessages?.(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('大师：收到。');
    expect(container.textContent).not.toContain('芝芝流式回复中');
  });
});
