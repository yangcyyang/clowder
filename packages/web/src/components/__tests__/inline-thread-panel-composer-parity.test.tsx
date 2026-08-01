/**
 * Raft-parity #2: the Thread composer used to be a bare textarea + send button while the
 * main channel's ChatInput had image/attachment upload + a prompt-prefix preset menu. This
 * locks in that the Thread composer now carries the same core affordances (attachment
 * upload alongside the pre-existing image upload, and the shared "提示词" preset menu from
 * chat-input-prompt-prefix.ts), without pulling in the main ChatInput's store-coupled
 * runtime-status/game/whisper machinery (see report for why that full-reuse path was
 * rejected).
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

describe('InlineThreadPanel composer parity with the main channel input', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
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
    window.localStorage.clear();
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

  it('offers a non-image attachment upload button alongside the image button', async () => {
    await mountPanel();
    expect(container.querySelector('button[aria-label="上传图片"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="上传文件"]')).toBeTruthy();
  });

  it('previews a selected attachment and sends it with the branch reply metadata', async () => {
    await mountPanel();

    const file = new File(['spec content'], 'spec.pdf', { type: 'application/pdf' });
    const attachmentInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    Object.defineProperty(attachmentInput, 'files', { configurable: true, value: [file] });
    await act(async () => {
      attachmentInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('spec.pdf');

    const sendButton = container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.click();
      await Promise.resolve();
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = (post?.[1] as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll('attachments')).toEqual([file]);
    expect(body.get('threadId')).toBe('thread-branch');
  });

  it('removes an attachment via its remove button before sending', async () => {
    await mountPanel();

    const file = new File(['spec content'], 'spec.pdf', { type: 'application/pdf' });
    const attachmentInput = container.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    Object.defineProperty(attachmentInput, 'files', { configurable: true, value: [file] });
    await act(async () => {
      attachmentInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('spec.pdf');

    const removeButton = container.querySelector('button[aria-label="移除文件 spec.pdf"]') as HTMLButtonElement;
    await act(async () => {
      removeButton.click();
    });
    expect(container.textContent).not.toContain('spec.pdf');
  });

  it('offers the shared "提示词" preset menu and prefixes the sent content', async () => {
    await mountPanel();

    const prefixButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('提示词'),
    ) as HTMLButtonElement;
    expect(prefixButton).toBeTruthy();

    await act(async () => {
      prefixButton.click();
    });
    expect(container.querySelector('[data-testid="thread-prompt-prefix-menu"]')).toBeTruthy();

    const planOption = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((button) =>
      button.textContent?.includes('方案规划'),
    ) as HTMLButtonElement;
    expect(planOption).toBeTruthy();

    await act(async () => {
      planOption.click();
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '帮我拆一下这个功能');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    apiFetchMock.mockClear();
    const sendButton = container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.click();
      await Promise.resolve();
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const sentContent = JSON.parse(String((post?.[1] as RequestInit).body)).content as string;
    expect(sentContent).toContain('[PLAN_MODE]');
    expect(sentContent).toContain('帮我拆一下这个功能');
  });

  it('does not render an "As Task" control — replies always carry replyTo, which the backend already excludes from task admission', async () => {
    await mountPanel();
    expect(
      Array.from(container.querySelectorAll('label, span')).some((el) => el.textContent?.trim() === 'As Task'),
    ).toBe(false);
  });

  it('does not render the keyboard shortcut hint below the composer', async () => {
    await mountPanel();
    expect(container.textContent).not.toContain('Enter 发送 · Shift+Enter 换行');
  });
});
