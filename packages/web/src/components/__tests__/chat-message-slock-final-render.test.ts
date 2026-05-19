import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      currentThreadId: 'default',
      isLoadingThreads: false,
      messages: [],
    }),
  resolveBubbleExpanded: (override: string | undefined, globalDefault: string) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChatMessage Slock-like final render', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('hides stream-origin token bubbles until the final message is complete', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const streamingMessage = {
      id: 'm-stream',
      type: 'assistant',
      catId: 'codex',
      timestamp: Date.now(),
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'stream',
      variant: null,
      isStreaming: true,
      content: 'partial token text',
      thinking: '',
      contentBlocks: null,
      toolEvents: null,
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: streamingMessage as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });
    expect(container.textContent).not.toContain('partial token text');

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: { ...streamingMessage, isStreaming: false } as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });
    expect(container.textContent).toContain('partial token text');
    const messageRow = container.querySelector('[data-message-id="m-stream"]');
    expect(messageRow?.className).toContain('motion-safe:animate-message-appear');
  });
});
