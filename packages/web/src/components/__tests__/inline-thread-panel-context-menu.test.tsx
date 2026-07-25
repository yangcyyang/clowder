/**
 * The Raft-parity right-click context menu (MessageActions + MessageContextMenu) must work on
 * BOTH the main channel (ChatContainer.tsx, covered by message-actions-context-menu-raft.test.tsx)
 * AND the Thread panel — InlineThreadPanel.tsx renders messages via bare <ChatMessage> without
 * ever wrapping them in <MessageActions>, so this test locks in the wiring added to fix that.
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

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

const replyMessage = {
  id: 'reply-1',
  type: 'assistant',
  catId: 'codex',
  content: '一条回复',
  timestamp: 2,
} as ChatMessage;

describe('InlineThreadPanel — Raft-parity context menu on thread messages', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    // jsdom doesn't implement Element.scrollTo — InlineThreadPanel calls it when the reply
    // list grows on load, unrelated to what this suite is testing (context-menu wiring).
    HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage, replyMessage] }) });
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

  /** MessageActions renders its `.slock-message-frame` (the onContextMenu target) as a CHILD
   * of the `data-inline-thread-message-id` wrapper div — events bubble up from target to
   * ancestors, so the contextmenu must be dispatched on the frame itself, not the wrapper. */
  function frameFor(row: HTMLElement): HTMLElement {
    return row.querySelector('.slock-message-frame') as HTMLElement;
  }

  it('right-clicking a reply message opens the Raft-parity context menu', async () => {
    await mountPanel();

    const replyRow = container.querySelector('[data-inline-thread-message-id="reply-1"]') as HTMLElement;
    expect(replyRow).not.toBeNull();

    await act(async () => {
      frameFor(replyRow).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });

    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(expect.arrayContaining(['Copy Link', 'Copy Markdown', 'Select Message', 'Save Message']));
  });

  it('Convert to Task is absent for thread-nested messages (Raft rule: no nesting)', async () => {
    await mountPanel();

    const replyRow = container.querySelector('[data-inline-thread-message-id="reply-1"]') as HTMLElement;
    await act(async () => {
      frameFor(replyRow).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });

    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
      (b) => b.textContent,
    );
    // Sanity check the menu actually opened (otherwise "not toContain" would pass vacuously).
    expect(labels).toContain('Copy Link');
    expect(labels).not.toContain('Convert to Task');
  });

  it('the source-message copy at the top of the panel also gets the context menu', async () => {
    await mountPanel();

    const sourceRow = container.querySelector('[data-inline-thread-message-id="source-branch-message"]') as HTMLElement;
    expect(sourceRow).not.toBeNull();

    await act(async () => {
      frameFor(sourceRow).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });

    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(expect.arrayContaining(['Copy Link', 'Copy Markdown']));
  });
});
