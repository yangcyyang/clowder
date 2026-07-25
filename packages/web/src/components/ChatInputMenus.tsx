'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CatStatusType } from '@/stores/chat-types';
import { type CatOption } from './chat-input-options';

interface ChatInputMenusProps {
  catOptions: CatOption[];
  showMentions: boolean;
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  onInsertMention: (opt: CatOption) => void;
  menuRef: RefObject<HTMLDivElement>;
  catStatuses?: Record<string, CatStatusType>;
}

function isWorkingStatus(status?: CatStatusType): boolean {
  return status === 'spawning' || status === 'pending' || status === 'streaming';
}

export function ChatInputMenus({
  catOptions,
  showMentions,
  selectedIdx,
  onSelectIdx,
  onInsertMention,
  menuRef,
  catStatuses = {},
}: ChatInputMenusProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);

  // Auto-scroll selected item into view on keyboard navigation
  const selectedRef = useCallback((node: HTMLButtonElement | null) => {
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Detect if more items are hidden below
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setCanScrollDown(false);
      return;
    }
    const check = () => setCanScrollDown(el.scrollHeight > el.clientHeight + el.scrollTop + 4);
    check();
    el.addEventListener('scroll', check);
    return () => el.removeEventListener('scroll', check);
  }, []);

  return (
    <>
      {showMentions && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 mb-2 bg-cafe-surface rounded-xl shadow-lg border border-[var(--console-border-soft)] overflow-hidden w-72 z-10 max-h-80 flex flex-col"
        >
          <div ref={scrollRef} className="overflow-y-auto flex-1">
            {catOptions.map((opt, i) => {
              const isWorking = isWorkingStatus(catStatuses[opt.id]);
              return (
                <button
                  key={opt.id}
                  ref={i === selectedIdx ? selectedRef : undefined}
                  className={`w-full border-l-2 py-3 pr-4 pl-[14px] text-left flex items-center gap-3 transition-colors ${
                    i === selectedIdx
                      ? 'border-[var(--cafe-accent)] bg-[var(--console-active-bg)]'
                      : 'border-transparent hover:bg-[var(--console-hover-bg)]'
                  }`}
                  onMouseEnter={() => onSelectIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onInsertMention(opt);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={opt.avatar}
                    alt={opt.label}
                    className="w-7 h-7 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: isWorking ? '#eab308' : (opt.color ?? 'var(--console-status-connected)') }}
                        aria-label={isWorking ? '工作中' : '在线'}
                      />
                      <span
                        className={`truncate text-sm font-semibold ${
                          i === selectedIdx ? 'text-[var(--console-active-fg)]' : ''
                        }`}
                        style={i === selectedIdx ? undefined : { color: opt.color }}
                      >
                        {opt.label}
                      </span>
                    </div>
                    <div
                      className={`truncate text-xs ${
                        i === selectedIdx ? 'text-[var(--console-active-muted)]' : 'text-cafe-muted'
                      }`}
                    >
                      {opt.desc}
                    </div>
                  </div>
                  <span
                    className={`ml-2 flex-shrink-0 text-right font-mono text-[11px] ${
                      i === selectedIdx ? 'text-[var(--console-active-muted)]' : 'text-cafe-muted'
                    }`}
                  >
                    {opt.insert.trim()}
                  </span>
                </button>
              );
            })}
          </div>
          {canScrollDown && (
            <div className="px-4 py-1 text-[10px] text-cafe-muted text-center border-t border-[var(--console-border-soft)] bg-gradient-to-t from-cafe-surface shrink-0">
              ↓ 还有更多猫猫
            </div>
          )}
          {catOptions.length === 0 && <div className="px-4 py-2.5 text-xs text-cafe-muted">无匹配猫猫</div>}
          <div className="px-4 py-1.5 text-xs text-cafe-muted border-t border-[var(--console-border-soft)] shrink-0">
            {'↑↓ 选择 · Enter 确认 · Esc 关闭'}
          </div>
        </div>
      )}
    </>
  );
}
