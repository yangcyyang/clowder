/**
 * Raft-parity #1: "当前回复" (who's replying + what model) used to be a permanently
 * fixed block between the header and the scrollable reply list, always eating header
 * space. It now renders as a lightweight chip row scoped to the composer area (right
 * above the input), matching the same visual language as AgentStatusIndicator.tsx (the
 * main channel's equivalent status strip). This locks in: the info survives the move
 * (label / status / model), and it lives inside the composer container, not the fixed
 * header region above the scrollable message list.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
        mentionPatterns: ['opus'],
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

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

describe('InlineThreadPanel runtime status placement', () => {
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
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply' }] }),
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
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders the runtime status strip inside the composer area (not the fixed header) with cat + status + model preserved', async () => {
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

    const statusRow = container.querySelector('[data-testid="inline-thread-runtime-status"]');
    expect(statusRow).toBeTruthy();
    expect(statusRow?.textContent).toContain('Opus');
    expect(statusRow?.textContent).toContain('回复中');
    expect(statusRow?.textContent).toContain('claude-opus');

    // Scoped to the composer, not the fixed header area above the scrollable reply list.
    const composer = container.querySelector('.slock-inline-thread-composer');
    expect(composer?.contains(statusRow)).toBe(true);

    const header = container.querySelector('.slock-inline-thread-header');
    expect(header?.contains(statusRow)).toBe(false);

    // The old standalone "当前回复" section heading is gone — the chip itself already
    // names the cat + its status (matching AgentStatusIndicator's headerless design).
    expect(container.textContent).not.toContain('当前回复');
  });

  it('omits the strip entirely when no cat is currently replying', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({ ok: true, json: async () => ({ activeInvocations: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

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

    expect(container.querySelector('[data-testid="inline-thread-runtime-status"]')).toBeNull();
  });
});
