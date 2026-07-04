'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { buildQuickSwitchItems, type QuickSwitchItem } from './quick-switcher';
import { getThreadHref, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

interface QuickSwitchPaletteProps {
  open: boolean;
  pathname: string;
  currentSearch: string;
  onClose: () => void;
}

function itemTypeLabel(type: QuickSwitchItem['type']): string {
  if (type === 'dm') return 'DM';
  if (type === 'search') return '搜索';
  return '频道';
}

function isChatSurface(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/thread/');
}

export function QuickSwitchPalette({ open, pathname, currentSearch, onClose }: QuickSwitchPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const storeThreads = useChatStore((state) => state.threads);
  const clearUnread = useChatStore((state) => state.clearUnread);
  const { cats } = useCatData();
  const [remoteThreads, setRemoteThreads] = useState<Thread[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open || storeThreads.length > 0) return;
    let cancelled = false;
    setIsLoading(true);
    apiFetch('/api/threads')
      .then(async (res) => {
        if (!res.ok) return { threads: [] };
        return (await res.json()) as { threads?: Thread[] };
      })
      .then((data) => {
        if (!cancelled) setRemoteThreads(data.threads ?? []);
      })
      .catch(() => {
        if (!cancelled) setRemoteThreads([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, storeThreads.length]);

  const threads = storeThreads.length > 0 ? storeThreads : remoteThreads;
  const items = useMemo(
    () => buildQuickSwitchItems({ threads, cats, query, pathname, currentSearch }),
    [threads, cats, query, pathname, currentSearch],
  );
  const activeItem = items[Math.min(activeIndex, Math.max(0, items.length - 1))];

  useEffect(() => {
    if (activeIndex < items.length) return;
    setActiveIndex(Math.max(0, items.length - 1));
  }, [activeIndex, items.length]);

  const openItem = useCallback(
    (item: QuickSwitchItem | undefined) => {
      if (!item) return;
      if (item.threadId) {
        clearUnread(item.threadId);
        if (isChatSurface(pathname)) {
          pushThreadRouteWithHistory(item.threadId, typeof window !== 'undefined' ? window : undefined);
        } else {
          router.push(getThreadHref(item.threadId));
        }
      } else {
        router.push(item.href);
      }
      onClose();
    },
    [clearUnread, onClose, pathname, router],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (items.length === 0 ? 0 : (current + 1) % items.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const searchItem = items.find((item) => item.type === 'search');
        openItem(event.shiftKey && searchItem ? searchItem : activeItem);
      }
    },
    [activeItem, items, onClose, openItem],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-[var(--console-overlay-backdrop)] px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      data-testid="quick-switch-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border-2 border-[var(--slock-border-color)] bg-[var(--cafe-surface)] shadow-2xl">
        <div className="border-b border-[var(--console-border-soft)] p-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            className="console-form-input h-10 w-full border-2 text-sm"
            placeholder="跳转到频道、私信或 thread ID..."
            data-testid="quick-switch-input"
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1">
          {isLoading && storeThreads.length === 0 ? (
            <div className="px-4 py-4 text-sm text-[var(--clowder-muted-soft)]">加载中...</div>
          ) : items.length > 0 ? (
            items.map((item, index) => {
              const active = item.id === activeItem?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-active={active ? 'true' : 'false'}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => openItem(item)}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'bg-[var(--clowder-sidebar-active-bg)] text-[var(--clowder-sidebar-row-active-text)]'
                      : 'text-[var(--cafe-text)] hover:bg-[var(--console-hover-bg)]'
                  }`}
                >
                  <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--console-border-soft)] text-[10px] font-bold uppercase text-[var(--clowder-muted-soft)]">
                    {itemTypeLabel(item.type)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{item.label}</span>
                    <span className="block truncate text-xs text-[var(--clowder-muted-soft)]">{item.detail}</span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="px-4 py-4 text-sm text-[var(--clowder-muted-soft)]">没有匹配的对话</div>
          )}
        </div>
      </div>
    </div>
  );
}
