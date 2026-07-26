'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HubIcon } from './hub-icons';

export interface ReactionQuickPick {
  emoji: string;
  /** Whether the current user already reacted with this emoji — highlights the button. */
  active: boolean;
}

interface MessageContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /** Quick-react emoji row along the top (Raft parity). Omitted entirely when no reaction
   * backend is wired up for this surface — see message-reactions.ts. */
  reactions?: ReactionQuickPick[];
  onReact?: (emoji: string) => void;
  onCopyLink: () => void;
  onCopyMarkdown: () => void;
  onSelectMessage: () => void;
  saved?: boolean;
  onSave?: () => void;
  onConvertToTask?: () => void;
  onShare?: () => void;
  onPin?: () => void;
  onEdit?: () => void;
  onSoftDelete?: () => void;
  onHardDelete?: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  onClick: () => void;
  /** cy 2026-07-26 Raft density parity: leading icon name from hub-icons.tsx's ICON_PATHS. */
  icon: string;
}

const MENU_MARGIN = 8;

/**
 * Pure so the "flip near viewport edges" behavior is unit-testable without needing real
 * getBoundingClientRect() measurements from jsdom (which default to 0x0). Flips to open toward
 * the opposite side of the cursor when the menu would overflow, rather than merely clamping —
 * matches how native context menus reposition.
 */
export function computeMenuPosition(input: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { top: number; left: number } {
  const { x, y, menuWidth, menuHeight, viewportWidth, viewportHeight } = input;

  let left = x;
  if (x + menuWidth > viewportWidth) {
    left = Math.max(MENU_MARGIN, x - menuWidth);
  }
  left = Math.min(left, Math.max(MENU_MARGIN, viewportWidth - menuWidth - MENU_MARGIN));

  let top = y;
  if (y + menuHeight > viewportHeight) {
    top = Math.max(MENU_MARGIN, y - menuHeight);
  }
  top = Math.min(top, Math.max(MENU_MARGIN, viewportHeight - menuHeight - MENU_MARGIN));

  return { top, left };
}

export function MessageContextMenu({
  x,
  y,
  onClose,
  reactions,
  onReact,
  onCopyLink,
  onCopyMarkdown,
  onSelectMessage,
  saved,
  onSave,
  onConvertToTask,
  onShare,
  onPin,
  onEdit,
  onSoftDelete,
  onHardDelete,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ top: y, left: x });

  // Raft parity: flip the menu toward the opposite side of the cursor when it would be clipped
  // by the viewport edge, instead of letting it overflow off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    setPos(
      computeMenuPosition({
        x,
        y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y]);

  // Autofocus the first actionable item so ArrowDown/ArrowUp + Enter work immediately for
  // keyboard users, matching the ARIA menu pattern.
  useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  // cy 2026-07-26 Raft density parity: icon choices follow the existing hub-icons.tsx path set
  // (no new dependency). Copy Link/Copy Markdown share the "copy" verb but get visually distinct
  // icons; Pin has no literal thumbtack in the set so "target" (pinpoint) stands in — see commit
  // message for the full mapping rationale.
  const primaryItems: MenuItem[] = [
    { key: 'copy-link', label: 'Copy Link', onClick: onCopyLink, icon: 'external-link' },
    { key: 'copy-markdown', label: 'Copy Markdown', onClick: onCopyMarkdown, icon: 'copy' },
    { key: 'select-message', label: 'Select Message', onClick: onSelectMessage, icon: 'check' },
    {
      key: 'save-message',
      label: saved ? 'Unsave Message' : 'Save Message',
      onClick: () => onSave?.(),
      icon: 'download',
    },
    ...(onConvertToTask
      ? [{ key: 'convert-to-task', label: 'Convert to Task', onClick: onConvertToTask, icon: 'plus' }]
      : []),
  ];

  // Pre-existing actions (pin/edit/share/delete) — kept as an additional group below the
  // Raft-parity items rather than removed, since they're the only UI surface these already
  // shipped features (pin, inline edit, soft/hard delete) have. See handoff notes.
  const secondaryItems: MenuItem[] = [
    ...(onPin ? [{ key: 'pin', label: 'Pin message', onClick: onPin, icon: 'target' }] : []),
    ...(onEdit ? [{ key: 'edit', label: 'Edit message', onClick: onEdit, icon: 'pencil' }] : []),
    { key: 'share', label: 'Share messages...', onClick: () => onShare?.(), icon: 'users' },
    ...(onSoftDelete ? [{ key: 'soft-delete', label: 'Delete message', onClick: onSoftDelete, icon: 'x' }] : []),
    ...(onHardDelete
      ? [{ key: 'hard-delete', label: 'Delete permanently', onClick: onHardDelete, icon: 'trash' }]
      : []),
  ];

  const allItems = [...primaryItems, ...secondaryItems];
  itemRefs.current = itemRefs.current.slice(0, allItems.length);

  function runAndClose(action: () => void) {
    action();
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const focusable = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    if (focusable.length === 0) return;
    const currentIndex = focusable.findIndex((el) => el === document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusable[(currentIndex + 1 + focusable.length) % focusable.length]?.focus();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusable[currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1]?.focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      focusable[currentIndex]?.click();
    }
  }

  // Portal straight to document.body (Raft parity + containing-block safety): `position: fixed`
  // is only viewport-relative when there's no transformed/filtered/contain-ing ancestor between
  // this node and the initial containing block. Surfaces like InlineThreadPanel wrap their
  // content in a `transform`-animated shell (see .thread-panel-motion in globals.css) for the
  // slide-in/out transition — any non-`none` transform value (even `translateX(0)`) makes that
  // ancestor the containing block for fixed descendants, so clientX/clientY-based coordinates
  // land relative to the panel's box instead of the viewport and the menu renders far off to the
  // side. Rendering via a portal at document.body sidesteps any ancestor's containing-block games
  // entirely, regardless of which surface opened the menu.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} aria-hidden="true" />
      <div
        ref={menuRef}
        // cy 2026-07-26 Raft density parity: fixed compact width (~256px, was an unbounded
        // min-w-[180px]) — density/structure only, colors/border/shadow stay on Clowder's own
        // tokens (see task boundary notes in the commit message).
        className="fixed z-[9999] w-64 rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] py-1 shadow-lg"
        style={{ top: pos.top, left: pos.left }}
        role="menu"
        onKeyDown={handleKeyDown}
      >
        {reactions && reactions.length > 0 && onReact && (
          <>
            <div
              role="group"
              aria-label="快速表情回应"
              // Raft parity: tightly clustered + left-aligned, not spread with justify-between
              // (that was stretching ~200px gaps between 6 emoji across the full row width).
              className="flex items-center justify-start gap-1 px-2 py-1.5"
            >
              {reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  onClick={() => runAndClose(() => onReact(reaction.emoji))}
                  aria-pressed={reaction.active}
                  title={reaction.emoji}
                  className={`flex h-7 w-7 items-center justify-center rounded-md text-base transition-colors hover:bg-[var(--cafe-surface-elevated)] ${
                    reaction.active ? 'bg-[var(--cafe-accent)]/10 ring-1 ring-inset ring-[var(--cafe-accent)]/40' : ''
                  }`}
                >
                  {reaction.emoji}
                </button>
              ))}
            </div>
            <div role="separator" className="my-1 h-px bg-[var(--slock-border-color)]" />
          </>
        )}

        {primaryItems.map((item, index) => (
          <button
            key={item.key}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            type="button"
            onClick={() => runAndClose(item.onClick)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--cafe-text)] transition-colors hover:bg-[var(--cafe-surface-elevated)] focus-visible:outline-none focus-visible:bg-[var(--cafe-surface-elevated)]"
            role="menuitem"
          >
            <HubIcon name={item.icon} className="h-4 w-4 shrink-0 text-[var(--cafe-text-secondary)]" />
            <span>{item.label}</span>
          </button>
        ))}

        {secondaryItems.length > 0 && (
          <>
            <div role="separator" className="my-1 h-px bg-[var(--slock-border-color)]" />
            {secondaryItems.map((item, offset) => {
              const index = primaryItems.length + offset;
              return (
                <button
                  key={item.key}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  onClick={() => runAndClose(item.onClick)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--cafe-text)] transition-colors hover:bg-[var(--cafe-surface-elevated)] focus-visible:outline-none focus-visible:bg-[var(--cafe-surface-elevated)]"
                  role="menuitem"
                >
                  <HubIcon name={item.icon} className="h-4 w-4 shrink-0 text-[var(--cafe-text-secondary)]" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
