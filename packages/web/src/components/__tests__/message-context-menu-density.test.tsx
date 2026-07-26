/**
 * cy 2026-07-26: 右键菜单密度紧凑化，照抄 Raft 的密度/结构（不是配色/边框皮肤）。
 * 铲屎官原话："我觉得那个分间隔太疏散了，参考一下 raft"。
 *
 * 现状问题（截图实况）：
 * 1. 菜单被 `min-w-[180px]`（无上限）撑宽，表情行用 `justify-between` 把 6 个表情撒满
 *    整行，间隔近 200px；
 * 2. 菜单项纯文字，无前置图标；
 * 3. （行高本身 py-1.5 已经是目标值，不用再收）。
 *
 * 边界：只改密度/结构，颜色/边框/阴影继续走 Clowder 现有 CSS 变量——本文件不断言任何
 * 具体颜色/边框类，只断言宽度类、表情行对齐方式、菜单项是否带图标元素，以及功能零回归。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageContextMenu } from '@/components/MessageContextMenu';

describe('MessageContextMenu — Raft density parity (cy 2026-07-26)', () => {
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

  it('renders the menu at a compact fixed width, not the old unbounded min-w', () => {
    renderMenu();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    // Old behavior: `min-w-[180px]` with no upper bound — menu could grow arbitrarily wide.
    expect(menu.className).not.toMatch(/min-w-/);
    // New: a single fixed-width utility in the ~240-280px range (w-64 = 256px).
    expect(menu.className).toMatch(/\bw-64\b/);
  });

  it('lays out the quick-react row tightly left-aligned, not spread with justify-between', () => {
    renderMenu({
      reactions: [
        { emoji: '👍', active: false },
        { emoji: '❤️', active: false },
        { emoji: '😂', active: false },
        { emoji: '🎉', active: false },
        { emoji: '👀', active: false },
        { emoji: '🙏', active: false },
      ],
      onReact: vi.fn(),
    });
    const group = document.body.querySelector('[role="group"]') as HTMLElement;
    expect(group).toBeTruthy();
    // Old behavior: `justify-between` spread the 6 emoji across the full row width.
    expect(group.className).not.toMatch(/justify-between/);
    expect(group.className).toMatch(/justify-start/);
  });

  it('every menu item renders a leading icon element alongside its label text', () => {
    renderMenu({
      onConvertToTask: vi.fn(),
      onPin: vi.fn(),
      onEdit: vi.fn(),
      onSoftDelete: vi.fn(),
      onHardDelete: vi.fn(),
    });
    const items = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.querySelector('svg'), `menu item "${item.textContent}" should have a leading icon`).toBeTruthy();
    }
  });

  it('icons do not leak into the accessible label text — textContent stays exactly the item label', () => {
    renderMenu({ onPin: vi.fn() });
    const pinItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Pin message',
    );
    expect(pinItem).toBeTruthy();
  });

  it('does not drop any existing menu item while compacting the layout', () => {
    renderMenu({
      reactions: [{ emoji: '👍', active: false }],
      onReact: vi.fn(),
      onConvertToTask: vi.fn(),
      onPin: vi.fn(),
      onEdit: vi.fn(),
      onSoftDelete: vi.fn(),
      onHardDelete: vi.fn(),
      saved: false,
    });
    const labels = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual([
      'Copy Link',
      'Copy Markdown',
      'Select Message',
      'Save Message',
      'Convert to Task',
      'Pin message',
      'Edit message',
      'Share messages...',
      'Delete message',
      'Delete permanently',
    ]);
    expect(document.body.querySelector('[role="group"]')?.textContent).toContain('👍');
  });

  it('keeps the same two separators (reactions | primary group | secondary group) — no new group lines added', () => {
    renderMenu({
      reactions: [{ emoji: '👍', active: false }],
      onReact: vi.fn(),
      onPin: vi.fn(),
    });
    expect(document.body.querySelectorAll('[role="separator"]').length).toBe(2);
  });

  it('a menu item click still fires its callback and closes the menu (zero functional regression)', () => {
    const props = renderMenu({ onPin: vi.fn() });
    const pinItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (b) => b.textContent === 'Pin message',
    );
    act(() => pinItem?.click());
    expect(props.onPin).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
