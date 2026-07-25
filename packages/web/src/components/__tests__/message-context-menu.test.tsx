import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMenuPosition, MessageContextMenu } from '@/components/MessageContextMenu';

function menuItemLabels(container: HTMLDivElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
    (button) => button.textContent ?? '',
  );
}

describe('computeMenuPosition (viewport-edge flip, Raft parity)', () => {
  it('keeps the requested position when there is room', () => {
    expect(
      computeMenuPosition({ x: 100, y: 100, menuWidth: 180, menuHeight: 220, viewportWidth: 1200, viewportHeight: 800 }),
    ).toEqual({ top: 100, left: 100 });
  });

  it('flips horizontally toward the cursor instead of overflowing the right edge', () => {
    const pos = computeMenuPosition({
      x: 1150,
      y: 100,
      menuWidth: 180,
      menuHeight: 220,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    // Flips to open leftward of the cursor (right edge of menu ~= cursor x) rather than
    // clipping off the 1200px-wide viewport.
    expect(pos.left).toBeLessThan(1150);
    expect(pos.left + 180).toBeLessThanOrEqual(1200);
  });

  it('flips vertically toward the cursor instead of overflowing the bottom edge', () => {
    const pos = computeMenuPosition({
      x: 100,
      y: 750,
      menuWidth: 180,
      menuHeight: 220,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(pos.top).toBeLessThan(750);
    expect(pos.top + 220).toBeLessThanOrEqual(800);
  });
});

describe('MessageContextMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  function renderMenu(overrides: Partial<React.ComponentProps<typeof MessageContextMenu>> = {}) {
    const props: React.ComponentProps<typeof MessageContextMenu> = {
      x: 10,
      y: 10,
      onClose: vi.fn(),
      onCopyLink: vi.fn(),
      onCopyMarkdown: vi.fn(),
      onSelectMessage: vi.fn(),
      ...overrides,
    };
    act(() => {
      root.render(<MessageContextMenu {...props} />);
    });
    return props;
  }

  it('renders the Raft-parity item set in order: Copy Link, Copy Markdown, Select Message, Save Message', () => {
    renderMenu();
    // "Share messages..." is a pre-existing item with no onShare-presence gate (see
    // MessageContextMenu.tsx secondaryItems) — always present, unlike Pin/Edit/Delete.
    expect(menuItemLabels(container)).toEqual([
      'Copy Link',
      'Copy Markdown',
      'Select Message',
      'Save Message',
      'Share messages...',
    ]);
  });

  it('shows "Unsave Message" instead when saved=true', () => {
    renderMenu({ saved: true });
    expect(menuItemLabels(container)).toContain('Unsave Message');
    expect(menuItemLabels(container)).not.toContain('Save Message');
  });

  it('includes Convert to Task only when the callback is provided', () => {
    renderMenu({ onConvertToTask: vi.fn() });
    expect(menuItemLabels(container)).toContain('Convert to Task');
  });

  it('omits Convert to Task when no callback is provided (thread-nested message)', () => {
    renderMenu();
    expect(menuItemLabels(container)).not.toContain('Convert to Task');
  });

  it('keeps the pre-existing pin/edit/share/delete actions available as a secondary group', () => {
    renderMenu({ onPin: vi.fn(), onEdit: vi.fn(), onSoftDelete: vi.fn(), onHardDelete: vi.fn() });
    const labels = menuItemLabels(container);
    expect(labels).toEqual(
      expect.arrayContaining(['Pin message', 'Edit message', 'Share messages...', 'Delete message', 'Delete permanently']),
    );
  });

  it('clicking Copy Link invokes onCopyLink and closes the menu', () => {
    const props = renderMenu();
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Copy Link',
    );
    act(() => btn?.click());
    expect(props.onCopyLink).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking Select Message invokes onSelectMessage and closes the menu', () => {
    const props = renderMenu();
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Select Message',
    );
    act(() => btn?.click());
    expect(props.onSelectMessage).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking outside the menu (the overlay) closes it', () => {
    const props = renderMenu();
    const overlay = container.querySelector('.fixed.inset-0.z-\\[9998\\]') as HTMLElement;
    expect(overlay).not.toBeNull();
    act(() => overlay.click());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('Escape closes the menu', () => {
    const props = renderMenu();
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('renders a quick-react emoji row when reactions + onReact are provided', () => {
    renderMenu({
      reactions: [
        { emoji: '👍', active: false },
        { emoji: '❤️', active: true },
      ],
      onReact: vi.fn(),
    });
    const group = container.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain('👍');
    expect(group?.textContent).toContain('❤️');
  });

  it('omits the quick-react row entirely when no reaction backend is wired (no reactions prop)', () => {
    renderMenu();
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it('clicking a reaction emoji calls onReact with that emoji and closes the menu', () => {
    const onReact = vi.fn();
    const props = renderMenu({ reactions: [{ emoji: '👍', active: false }], onReact });
    const emojiBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '👍');
    act(() => emojiBtn?.click());
    expect(onReact).toHaveBeenCalledWith('👍');
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('ArrowDown moves focus to the next menuitem, ArrowUp moves back, Enter activates the focused item', () => {
    const props = renderMenu({ onConvertToTask: vi.fn() });
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

    // First item autofocuses on mount.
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onCopyLink).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
