import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMenuPosition, MessageContextMenu } from '@/components/MessageContextMenu';

// MessageContextMenu portals to document.body (see MessageContextMenu.tsx) so a transformed
// ancestor — e.g. InlineThreadPanel's `.thread-panel-motion` slide-in shell, which sets a
// non-`none` `transform` and thereby becomes the containing block for any `position: fixed`
// descendant — can never hijack its viewport coordinates. All queries below therefore look at
// document.body, not the local render `container`, since the menu no longer lives in the
// component's own subtree.
function menuItemLabels(): string[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
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

  it('flips both axes when the click lands in the viewport\'s bottom-right corner', () => {
    // Regression guard for the InlineThreadPanel mis-position bug: a click near the
    // bottom-right corner overflows the menu on BOTH axes simultaneously. Each axis must flip
    // independently and the result must stay fully on-screen in both dimensions at once.
    const pos = computeMenuPosition({
      x: 1180,
      y: 780,
      menuWidth: 180,
      menuHeight: 220,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(pos.left).toBeLessThan(1180);
    expect(pos.top).toBeLessThan(780);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
    expect(pos.left + 180).toBeLessThanOrEqual(1200);
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

  it('mounts the menu as a portal directly on document.body, not inside its own render container', () => {
    renderMenu();
    // Never nested under the local `container` — that's what lets it escape any transformed
    // ancestor (containing-block hijack) between the calling component and the document root.
    expect(container.querySelector('[role="menu"]')).toBeNull();

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);

    const overlay = document.body.querySelector('.fixed.inset-0.z-\\[9998\\]');
    expect(overlay).not.toBeNull();
    expect(overlay?.parentElement).toBe(document.body);
  });

  it('renders the Raft-parity item set in order: Copy Link, Copy Markdown, Select Message, Save Message', () => {
    renderMenu();
    // "Share messages..." is a pre-existing item with no onShare-presence gate (see
    // MessageContextMenu.tsx secondaryItems) — always present, unlike Pin/Edit/Delete.
    expect(menuItemLabels()).toEqual([
      'Copy Link',
      'Copy Markdown',
      'Select Message',
      'Save Message',
      'Share messages...',
    ]);
  });

  it('shows "Unsave Message" instead when saved=true', () => {
    renderMenu({ saved: true });
    expect(menuItemLabels()).toContain('Unsave Message');
    expect(menuItemLabels()).not.toContain('Save Message');
  });

  it('includes Convert to Task only when the callback is provided', () => {
    renderMenu({ onConvertToTask: vi.fn() });
    expect(menuItemLabels()).toContain('Convert to Task');
  });

  it('omits Convert to Task when no callback is provided (thread-nested message)', () => {
    renderMenu();
    expect(menuItemLabels()).not.toContain('Convert to Task');
  });

  it('keeps the pre-existing pin/edit/share/delete actions available as a secondary group', () => {
    renderMenu({ onPin: vi.fn(), onEdit: vi.fn(), onSoftDelete: vi.fn(), onHardDelete: vi.fn() });
    const labels = menuItemLabels();
    expect(labels).toEqual(
      expect.arrayContaining(['Pin message', 'Edit message', 'Share messages...', 'Delete message', 'Delete permanently']),
    );
  });

  it('clicking Copy Link invokes onCopyLink and closes the menu', () => {
    const props = renderMenu();
    const btn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Copy Link',
    );
    act(() => btn?.click());
    expect(props.onCopyLink).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking Select Message invokes onSelectMessage and closes the menu', () => {
    const props = renderMenu();
    const btn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Select Message',
    );
    act(() => btn?.click());
    expect(props.onSelectMessage).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('clicking outside the menu (the overlay) closes it', () => {
    const props = renderMenu();
    const overlay = document.body.querySelector('.fixed.inset-0.z-\\[9998\\]') as HTMLElement;
    expect(overlay).not.toBeNull();
    act(() => overlay.click());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('Escape closes the menu', () => {
    const props = renderMenu();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
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
    const group = document.body.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain('👍');
    expect(group?.textContent).toContain('❤️');
  });

  it('omits the quick-react row entirely when no reaction backend is wired (no reactions prop)', () => {
    renderMenu();
    expect(document.body.querySelector('[role="group"]')).toBeNull();
  });

  it('clicking a reaction emoji calls onReact with that emoji and closes the menu', () => {
    const onReact = vi.fn();
    const props = renderMenu({ reactions: [{ emoji: '👍', active: false }], onReact });
    const emojiBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '👍');
    act(() => emojiBtn?.click());
    expect(onReact).toHaveBeenCalledWith('👍');
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('ArrowDown moves focus to the next menuitem, ArrowUp moves back, Enter activates the focused item', () => {
    const props = renderMenu({ onConvertToTask: vi.fn() });
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    const items = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

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
