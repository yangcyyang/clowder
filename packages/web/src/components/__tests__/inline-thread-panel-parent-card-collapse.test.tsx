/**
 * Raft-parity #1: the "回复自" parent-message card used to be a permanently-expanded
 * fixed block (full quoted source message) competing with the scrollable reply list for
 * header space. It now defaults COLLAPSED to a single summary line and expands on click —
 * same collapse mechanics as InlineThreadTaskStatusCard (grid-template-rows 0fr/1fr,
 * localStorage-persisted per threadId), just a different default (collapsed, not expanded).
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildParentCardPreview,
  InlineThreadParentMessageCard,
  parentCardCollapsedStorageKey,
} from '@/components/InlineThreadPanel';
import type { ChatMessage } from '@/stores/chatStore';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    type: 'user',
    content: '普通回复内容',
    timestamp: 1,
    ...overrides,
  } as ChatMessage;
}

describe('buildParentCardPreview', () => {
  it('returns short content unchanged', () => {
    expect(buildParentCardPreview('普通回复内容')).toBe('普通回复内容');
  });

  it('truncates long content with an ellipsis and collapses whitespace', () => {
    const long = 'a'.repeat(80);
    const preview = buildParentCardPreview(long);
    expect(preview.length).toBeLessThan(long.length);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('InlineThreadParentMessageCard collapse (Raft-parity #1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('defaults COLLAPSED: aria-expanded=false, single summary line "回复自 X：preview", gridTemplateRows=0fr', async () => {
    const message = makeMessage();
    await act(async () => {
      root.render(<InlineThreadParentMessageCard message={message} getCatById={() => undefined} threadId="thread-1" />);
    });

    const header = container.querySelector('button[aria-label="展开父消息"]') as HTMLButtonElement;
    expect(header).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toContain('回复自 你');
    expect(header.textContent).toContain('普通回复内容');

    const detailWrapper = container.querySelector('.grid.transition-\\[grid-template-rows\\]') as HTMLElement;
    expect(detailWrapper?.style.gridTemplateRows).toBe('0fr');
  });

  it('click expands: aria-expanded=true, gridTemplateRows=1fr, full content visible', async () => {
    const message = makeMessage({ content: '这是完整的父消息内容，用于验证展开后可见' });
    await act(async () => {
      root.render(<InlineThreadParentMessageCard message={message} getCatById={() => undefined} threadId="thread-2" />);
    });

    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => {
      header.click();
    });

    const expandedHeader = container.querySelector('button[aria-label="折叠父消息"]') as HTMLButtonElement;
    expect(expandedHeader).toBeTruthy();
    expect(expandedHeader.getAttribute('aria-expanded')).toBe('true');

    const detailWrapper = container.querySelector('.grid.transition-\\[grid-template-rows\\]') as HTMLElement;
    expect(detailWrapper?.style.gridTemplateRows).toBe('1fr');
    expect(container.textContent).toContain('这是完整的父消息内容，用于验证展开后可见');
  });

  it('persists collapse state to localStorage keyed by threadId, restored on remount', async () => {
    const message = makeMessage();
    await act(async () => {
      root.render(<InlineThreadParentMessageCard message={message} getCatById={() => undefined} threadId="thread-42" />);
    });

    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    expect(window.localStorage.getItem(parentCardCollapsedStorageKey('thread-42'))).toBe('0');

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<InlineThreadParentMessageCard message={message} getCatById={() => undefined} threadId="thread-42" />);
    });
    expect(container.querySelector('button[aria-label="折叠父消息"]')).toBeTruthy();
  });

  it('without a threadId prop, still defaults collapsed (no persistence attempted)', async () => {
    const message = makeMessage();
    await act(async () => {
      root.render(<InlineThreadParentMessageCard message={message} getCatById={() => undefined} />);
    });
    expect(container.querySelector('button[aria-label="展开父消息"]')).toBeTruthy();
  });
});
