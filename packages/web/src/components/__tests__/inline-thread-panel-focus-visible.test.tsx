/**
 * #404-interaction item 4: close/collapse/View-in-channel/send must have a visible
 * keyboard-focus state (previously hover-only). Close + View-in-channel share
 * `.slock-header-action`, which now has a `:focus-visible` rule in console-shell.css;
 * collapse + send carry their own Tailwind `focus-visible:` utility classes directly since
 * they don't use that shared class.
 */

import type { TaskItem } from '@cat-cafe/shared';
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

import { InlineThreadPanel, InlineThreadTaskStatusCard } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: '焦点态验收',
    ownerCatId: 'opus',
    status: 'doing',
    why: '',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    evidence: {},
    ...overrides,
  } as TaskItem;
}

describe('InlineThreadPanel focus-visible affordances', () => {
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

  it('close button and View in channel use the shared .slock-header-action class (CSS :focus-visible rule applies)', async () => {
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

    const closeButton = container.querySelector('button[aria-label="关闭 Thread 面板"]');
    const viewInChannelButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('View in channel'),
    );
    expect(closeButton?.className).toContain('slock-header-action');
    expect(viewInChannelButton?.className).toContain('slock-header-action');
  });

  it('send button carries a focus-visible ring utility class', async () => {
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

    const sendButton = container.querySelector('button[aria-label="发送 Thread 回复"]');
    expect(sendButton?.className).toContain('focus-visible:ring');
  });

  it('task card collapse toggle carries a focus-visible ring utility class', async () => {
    await act(async () => {
      root.render(<InlineThreadTaskStatusCard task={makeTask()} threadId="thread-1" />);
    });

    const toggle = container.querySelector('button[aria-label="折叠任务 Thread 状态"]');
    expect(toggle?.className).toContain('focus-visible:ring');
  });
});
