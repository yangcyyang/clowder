/**
 * [thread-task-design §1.1] Regression test for the "排队中" badge.
 * Bug: message.deliveryStatus was never consumed by the frontend at all —
 * useSendMessage.ts kept the optimistic bubble visible on a smart-defaulted
 * 'queued' response but never marked it, so the user had no idea the send was
 * still waiting behind an active invocation. Guard: ChatMessage renders the
 * badge exactly when deliveryStatus==='queued', and it disappears once
 * delivered (deliveryStatus no longer 'queued').
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      messages: [],
      currentThreadId: 'thread-1',
      isLoadingThreads: false,
    }),
  resolveBubbleExpanded: (override: string | undefined, globalDefault: string) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

function makeUserMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'm-queued-1',
    type: 'user',
    catId: null,
    timestamp: Date.now(),
    visibility: 'public',
    revealedAt: null,
    whisperTo: null,
    origin: 'user',
    variant: null,
    isStreaming: false,
    content: '排队消息测试',
    thinking: '',
    contentBlocks: null,
    toolEvents: null,
    metadata: null,
    summary: null,
    evidence: null,
    extra: null,
    source: null,
    ...overrides,
  } as unknown as ChatMessageType;
}

describe('ChatMessage queued delivery badge', () => {
  let container: HTMLDivElement;
  let root: Root;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useTaskStore.setState({ tasks: [] });
    dispatchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders the "排队中" badge when deliveryStatus is queued', () => {
    act(() => {
      root.render(<ChatMessage message={makeUserMessage({ deliveryStatus: 'queued' })} getCatById={() => undefined} />);
    });

    const badge = container.querySelector('[data-testid="queued-delivery-badge"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain('排队中');
  });

  it('does not render the badge once delivered (deliveryStatus cleared)', () => {
    act(() => {
      root.render(
        <ChatMessage message={makeUserMessage({ deliveryStatus: 'delivered' })} getCatById={() => undefined} />,
      );
    });

    expect(container.querySelector('[data-testid="queued-delivery-badge"]')).toBeNull();
  });

  it('does not render the badge when deliveryStatus is absent (legacy/normal messages)', () => {
    act(() => {
      root.render(<ChatMessage message={makeUserMessage()} getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-testid="queued-delivery-badge"]')).toBeNull();
  });

  it('clicking the badge dispatches the QueuePanel focus event for this message thread', async () => {
    const { QUEUE_PANEL_FOCUS_EVENT } = await import('@/components/QueuePanel');

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage({ deliveryStatus: 'queued', threadId: 'thread-42' })}
          getCatById={() => undefined}
        />,
      );
    });

    const badge = container.querySelector('[data-testid="queued-delivery-badge"]') as HTMLButtonElement;
    expect(badge).toBeTruthy();

    act(() => {
      badge.click();
    });

    const dispatchedEvents = (dispatchSpy.mock.calls as unknown as Array<[Event]>).map((call) => call[0]);
    const dispatched = dispatchedEvents.find((event: Event) => event.type === QUEUE_PANEL_FOCUS_EVENT) as
      | CustomEvent<{ threadId?: string }>
      | undefined;
    expect(dispatched).toBeTruthy();
    expect(dispatched?.detail?.threadId).toBe('thread-42');
  });
});
