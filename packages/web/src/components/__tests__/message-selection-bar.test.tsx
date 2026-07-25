import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSelectionBar } from '@/components/MessageSelectionBar';
import { useMessageSelectionStore } from '@/stores/messageSelectionStore';

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: vi.fn() }),
  },
}));

const messages = [
  { id: 'm1', type: 'user' as const, content: 'first message', timestamp: 100 },
  { id: 'm2', type: 'assistant' as const, catId: 'codex', content: 'second message', timestamp: 200 },
];

describe('MessageSelectionBar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    useMessageSelectionStore.setState({ threadId: null, selectedIds: [] });
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders nothing when no selection is active for this thread', () => {
    act(() => {
      root.render(<MessageSelectionBar threadId="thread-1" messages={messages} />);
    });
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('renders nothing when the active selection belongs to a different thread', () => {
    useMessageSelectionStore.getState().start('thread-OTHER', 'm1');
    act(() => {
      root.render(<MessageSelectionBar threadId="thread-1" messages={messages} />);
    });
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('shows the selected count once a selection targeting this thread is active', () => {
    useMessageSelectionStore.getState().start('thread-1', 'm1');
    act(() => {
      root.render(<MessageSelectionBar threadId="thread-1" messages={messages} />);
    });
    expect(container.querySelector('[role="toolbar"]')?.textContent).toContain('已选 1 条');
  });

  it('取消 clears the selection', () => {
    useMessageSelectionStore.getState().start('thread-1', 'm1');
    act(() => {
      root.render(<MessageSelectionBar threadId="thread-1" messages={messages} />);
    });
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '取消');
    act(() => cancelBtn?.click());
    expect(useMessageSelectionStore.getState().threadId).toBeNull();
  });

  it('复制 Markdown merges selected messages in chronological order and clears the selection', async () => {
    useMessageSelectionStore.getState().start('thread-1', 'm2');
    useMessageSelectionStore.getState().toggle('thread-1', 'm1');
    act(() => {
      root.render(
        <MessageSelectionBar
          threadId="thread-1"
          messages={messages}
          getCatById={(id) => (id === 'codex' ? { displayName: 'Codex' } : undefined)}
        />,
      );
    });

    const copyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '复制 Markdown');
    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledOnce();
    const copied = writeTextMock.mock.calls[0][0] as string;
    // m1 (timestamp 100) sorted before m2 (timestamp 200) regardless of selection order.
    expect(copied.indexOf('first message')).toBeLessThan(copied.indexOf('second message'));
    expect(copied).toContain('> **Codex**');
    expect(useMessageSelectionStore.getState().threadId).toBeNull();
  });
});
