/**
 * Raft-parity right-click menu on MessageActions: Copy Link, Copy Markdown, Select Message,
 * Save/Unsave Message toggle, and the quick-react emoji row — see MessageContextMenu.tsx for
 * the presentational piece (tested independently in message-context-menu.test.tsx) and
 * message-markdown.ts / messageSelectionStore.ts for the shared logic these delegate to.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageSelectionStore } from '@/stores/messageSelectionStore';
import { SAVED_MESSAGES_STORAGE_KEY } from '@/utils/saved-messages';

const apiFetchMock = vi.hoisted(() => vi.fn());
const patchMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { removeThreadMessage: () => void; patchMessage: typeof patchMessageMock }) => unknown,
  ) => selector({ removeThreadMessage: vi.fn(), patchMessage: patchMessageMock }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: vi.fn() }),
  },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'user-1',
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const { MessageActions } = await import('@/components/MessageActions');

describe('MessageActions — Raft-parity context menu wiring', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    patchMessageMock.mockReset();
    window.localStorage.removeItem(SAVED_MESSAGES_STORAGE_KEY);
    useMessageSelectionStore.setState({ threadId: null, selectedIds: [] });
    window.history.pushState({}, '', '/thread/thread-1');

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

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const message = {
    id: 'msg-1',
    type: 'assistant' as const,
    catId: 'codex',
    content: '## 标题\n\n- 第一项\n- 第二项\n[model=gpt-5.6]',
    timestamp: new Date('2026-07-25T14:50:00').getTime(),
  };

  async function openContextMenu(overrides: Partial<React.ComponentProps<typeof MessageActions>> = {}) {
    await act(async () => {
      root.render(
        <MessageActions message={message} threadId="thread-1" {...overrides}>
          <div>message body</div>
        </MessageActions>,
      );
    });
    const frame = container.querySelector('.slock-message-frame') as HTMLElement;
    await act(async () => {
      frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
    });
  }

  // MessageContextMenu portals to document.body (see MessageContextMenu.tsx) so its own
  // containing block is never hijacked by a transformed ancestor (e.g. InlineThreadPanel's
  // .thread-panel-motion slide animation) — query document.body here, not `container`, since
  // the menu no longer lives inside the component's own subtree.
  function findMenuItem(label: string) {
    return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (button) => button.textContent === label,
    );
  }

  it('right-click opens the context menu with the Raft-parity item set', async () => {
    await openContextMenu();
    expect(findMenuItem('Copy Link')).toBeTruthy();
    expect(findMenuItem('Copy Markdown')).toBeTruthy();
    expect(findMenuItem('Select Message')).toBeTruthy();
    expect(findMenuItem('Save Message')).toBeTruthy();
  });

  it('the "更多操作" button opens the same menu (mobile / no-right-click entry point)', async () => {
    await act(async () => {
      root.render(
        <MessageActions message={message} threadId="thread-1">
          <div>message body</div>
        </MessageActions>,
      );
    });
    const moreButton = container.querySelector('button[title="更多操作"]') as HTMLButtonElement;
    await act(async () => {
      moreButton.click();
    });
    expect(findMenuItem('Copy Link')).toBeTruthy();
  });

  it('Copy Link copies a deep link using the established ?highlight= convention', async () => {
    await openContextMenu();
    await act(async () => {
      findMenuItem('Copy Link')?.click();
    });
    expect(writeTextMock).toHaveBeenCalledWith(`${window.location.origin}/thread/thread-1?highlight=msg-1`);
  });

  it('Copy Markdown copies only the visible Markdown content', async () => {
    await openContextMenu();
    await act(async () => {
      findMenuItem('Copy Markdown')?.click();
    });
    expect(writeTextMock).toHaveBeenCalledWith('## 标题\n\n- 第一项\n- 第二项');
  });

  it('Save Message toggles to Unsave Message and back through repeated menu opens', async () => {
    await openContextMenu();
    expect(findMenuItem('Save Message')).toBeTruthy();

    await act(async () => {
      findMenuItem('Save Message')?.click();
    });

    // Menu closed itself after the click; reopen to check the label flipped.
    await openContextMenu();
    expect(findMenuItem('Unsave Message')).toBeTruthy();
    expect(findMenuItem('Save Message')).toBeUndefined();

    await act(async () => {
      findMenuItem('Unsave Message')?.click();
    });
    await openContextMenu();
    expect(findMenuItem('Save Message')).toBeTruthy();
  });

  it('Select Message starts a selection for this thread, and a checkbox appears on the row', async () => {
    await openContextMenu();
    await act(async () => {
      findMenuItem('Select Message')?.click();
    });

    expect(useMessageSelectionStore.getState()).toMatchObject({ threadId: 'thread-1', selectedIds: ['msg-1'] });

    const checkbox = container.querySelector('[role="checkbox"]');
    expect(checkbox).toBeTruthy();
    expect(checkbox?.getAttribute('aria-checked')).toBe('true');
  });

  it('clicking the selection checkbox toggles the message out of the selection', async () => {
    await openContextMenu();
    await act(async () => {
      findMenuItem('Select Message')?.click();
    });
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLButtonElement;
    await act(async () => {
      checkbox.click();
    });
    expect(useMessageSelectionStore.getState()).toMatchObject({ threadId: null, selectedIds: [] });
  });

  it('renders the quick-react row (reused from the existing reaction backend) and reacting patches the message', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ reactions: [{ emoji: '👍', users: ['user-1'], updatedAt: 1 }] }),
    });
    await openContextMenu();
    const reactionGroup = document.body.querySelector('[role="group"]');
    expect(reactionGroup?.textContent).toContain('👍');

    const thumbButton = Array.from(reactionGroup?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '👍',
    ) as HTMLButtonElement;
    await act(async () => {
      thumbButton.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/messages/msg-1/reactions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(patchMessageMock).toHaveBeenCalledWith('msg-1', {
      extra: { reactions: [{ emoji: '👍', users: ['user-1'], updatedAt: 1 }] },
    });
  });
});
