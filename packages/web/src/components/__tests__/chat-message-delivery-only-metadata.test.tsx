import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        catStatuses: {},
        currentThreadId: 'default',
        globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
        isLoadingThreads: false,
        messages: [],
        threads: [],
      }),
    { getState: () => ({ openMemberEditor: vi.fn() }) },
  ),
  resolveBubbleExpanded: () => false,
}));

vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => React.createElement('span', null, 'avatar') }));

const cat = {
  id: 'codex',
  displayName: 'Codex',
  breedId: 'american-shorthair',
  color: { primary: '#111111', secondary: '#ffffff' },
} as unknown as CatData;

function message(deliveryOnlyMode: 'active' | 'degraded'): ChatMessageType {
  return {
    id: `m-${deliveryOnlyMode}`,
    type: 'assistant',
    catId: 'codex',
    timestamp: Date.now(),
    visibility: 'public',
    origin: 'callback',
    isStreaming: false,
    content: 'answer',
    metadata: {
      provider: 'codex-cli',
      model: 'gpt-5.5',
      usage: {
        deliveryOnlyMode,
        ...(deliveryOnlyMode === 'degraded' ? { deliveryOnlyDegradedIssue: 'missing_summary' as const } : {}),
      },
    },
  } as ChatMessageType;
}

describe('ChatMessage deliveryOnly metadata', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: typeof import('@/components/ChatMessage').ChatMessage;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ChatMessage = (await import('@/components/ChatMessage')).ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('forces an amber degradation badge even when ordinary runtime metadata is hidden', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message('degraded'),
          getCatById: () => undefined,
          isGrouped: true,
        }),
      );
    });

    expect(container.textContent).toContain('⚠ deliveryOnly 降级 · missing_summary');
    expect(container.textContent).not.toContain('codex-cli');
    expect(container.textContent).not.toContain('gpt-5.5');
  });

  it('keeps active diagnostics silent when ordinary runtime metadata is hidden', () => {
    act(() => {
      root.render(React.createElement(ChatMessage, { message: message('active'), getCatById: () => cat }));
    });

    expect(container.textContent).not.toContain('deliveryOnly');
  });
});
