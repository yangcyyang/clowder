/**
 * Slock-like mode — ChatMessage keeps CLI/tool execution out of the main chat surface.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));

const { ChatMessage } = await import('../ChatMessage');

let container: HTMLDivElement;
let root: Root;

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
  useChatStore.getState().setUiThinkingExpandedByDefault(false);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const getCatById = () => undefined;

describe('ChatMessage CLI Output integration', () => {
  it('renders stream stdout as normal assistant text and hides CLI Output chrome', () => {
    const msg = {
      id: 'msg-1',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'stream stdout',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read foo.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('stream stdout');
    expect(text).not.toContain('CLI Output');
    expect(text).not.toContain('💭 心里话');
  });

  it('keeps 🧠 Thinking independent from CLI block', () => {
    const msg = {
      id: 'msg-2',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'final answer',
      thinking: 'reasoning here',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Edit bar.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    // Thinking should be independent
    expect(buttons.some((b) => b.textContent?.includes('Thinking'))).toBe(true);
    expect(container.textContent).toContain('final answer');
    expect(container.textContent).not.toContain('CLI Output');
  });

  it('callback origin: content text is shown and CLI Output chrome is hidden', () => {
    const msg = {
      id: 'msg-3',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'Here is the answer',
      origin: 'callback' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read x.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Here is the answer');
    expect(text).not.toContain('CLI Output');
  });

  it('stream origin with only content renders as normal assistant text', () => {
    const msg = {
      id: 'msg-4',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'some CLI output',
      origin: 'stream' as const,
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    expect(container.textContent).toContain('some CLI output');
    expect(container.textContent).not.toContain('CLI Output');
  });

  it('pure tool-only assistant message is hidden from the main chat surface', () => {
    const msg = {
      id: 'msg-5',
      type: 'assistant' as const,
      catId: 'opus',
      content: '',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read foo.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    expect(container.textContent).not.toContain('CLI Output');
    expect(container.textContent).not.toContain('Read foo.ts');
    expect(container.textContent).not.toContain('执行已完成');
    expect(container.textContent).not.toContain('工具事件');
  });
});
