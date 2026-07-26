/**
 * [batch 2-E] Integration — ChatMessage renders a collapsed CliOutputBlock
 * timeline when a message carries toolEvents, alongside (not instead of) its
 * normal text content. This supersedes the earlier "Slock-like CLI suppression"
 * behavior (commit eb5fe913) — see docs/research/maka-absorption.md §2/§4 and
 * docs/research/clowder-raft-thread-task-design.md §3 step 2.3 for the design
 * decision to bring tool-call visibility back, Maka-style: collapsed by
 * default, expand per row to see detail. Messages with NO toolEvents (msg-4)
 * or with empty content and only tool events (msg-5, hidden by
 * isUserVisibleChatMessage regardless of this block) are unaffected.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
  it('renders stream stdout as normal text AND a collapsed CLI Output timeline for its tools', () => {
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
    expect(text).toContain('CLI Output');
    expect(text).not.toContain('💭 心里话');
    // Collapsed by default — the tool's own label is not visible until expanded.
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeNull();
    expect(text).not.toContain('Read foo.ts');
  });

  it('keeps 🧠 Thinking independent from the CLI Output block', () => {
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
    // CLI block also exists, independently of Thinking
    expect(container.textContent).toContain('CLI Output');
  });

  it('callback origin: content text is shown alongside a collapsed CLI Output block', () => {
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
    expect(text).toContain('CLI Output');
  });

  it('stream origin with only content (no toolEvents) renders as normal assistant text, no CLI block', () => {
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

  it('expands to show the tool name + extracted arg + result summary on click', () => {
    const msg = {
      id: 'msg-6',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'reading the file now',
      origin: 'stream' as const,
      toolEvents: [
        { id: 't1', type: 'tool_use' as const, label: 'opus → Read', detail: '{"file_path":"src/foo.ts"}', timestamp: 1000 },
        { id: 'r1', type: 'tool_result' as const, label: 'opus ← result', detail: '200 lines read', timestamp: 1001 },
      ],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    // Collapsed: neither the tool name nor its result summary is visible yet.
    expect(container.textContent).not.toContain('Read src/foo.ts');
    expect(container.textContent).not.toContain('200 lines read');

    // Expand the CLI Output block itself.
    const cliHeaderButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('CLI Output'),
    );
    act(() => {
      cliHeaderButton?.click();
    });
    // Expand the tools section within it.
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    act(() => {
      toolsToggle?.click();
    });
    // Tool name + extracted primary arg now visible (toCliEvents label cleaning).
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('src/foo.ts');

    // Expand the individual tool row to see its result summary.
    const toolRow = container.querySelector('[data-testid="tool-row-t1"]') as HTMLElement | null;
    act(() => {
      toolRow?.click();
    });
    expect(container.textContent).toContain('200 lines read');
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
