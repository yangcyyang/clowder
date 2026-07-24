/**
 * [thread-task-design §1.1] Regression test: QueuePanel has no externally-owned
 * open/close prop — its only "switch" is its own local `collapsed` state. The
 * "排队中" badge on a queued message bubble (ChatMessage.tsx) needs to flip that
 * switch to expanded and scroll the panel into view, via the
 * QUEUE_PANEL_FOCUS_EVENT window CustomEvent bridge (see QueuePanel.tsx).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QUEUE_PANEL_FOCUS_EVENT, QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

function makeEntry(id: string): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'u1',
    content: `queued message ${id}`,
    messageId: `m-${id}`,
    mergedMessageIds: [],
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt: NOW,
  };
}

// >= COLLAPSE_THRESHOLD (4) so the panel defaults to collapsed on mount —
// otherwise the "expand on focus" assertion would be trivially true already.
const MANY_ENTRIES: QueueEntry[] = ['a', 'b', 'c', 'd', 'e'].map(makeEntry);

describe('QueuePanel focus event (open-on-click bridge)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scrollIntoViewSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView.
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      scrollIntoViewSpy as unknown as () => void;

    useChatStore.setState({
      messages: [],
      queue: MANY_ENTRIES,
      queuePaused: false,
      currentThreadId: 'thread-1',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('starts collapsed by default once past COLLAPSE_THRESHOLD', () => {
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '展开');
    expect(toggle).toBeTruthy();
  });

  it('expands and scrolls into view when the focus event targets this thread', () => {
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(QUEUE_PANEL_FOCUS_EVENT, { detail: { threadId: 'thread-1' } }));
    });

    const toggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '展开' || b.textContent === '收起',
    );
    expect(toggle?.textContent).toBe('收起');
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  });

  it('ignores a focus event scoped to a different thread', () => {
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(QUEUE_PANEL_FOCUS_EVENT, { detail: { threadId: 'thread-other' } }));
    });

    const toggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '展开' || b.textContent === '收起',
    );
    expect(toggle?.textContent).toBe('展开');
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});
