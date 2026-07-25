'use client';

import { useCallback } from 'react';
import type { ChatMessage } from '@/stores/chatStore';
import { useMessageSelectionStore } from '@/stores/messageSelectionStore';
import { useToastStore } from '@/stores/toastStore';
import { buildMessagesMarkdownQuote, resolveMessageAuthorLabel } from '@/utils/message-markdown';

interface MessageSelectionBarProps {
  threadId: string;
  messages: readonly ChatMessage[];
  getCatById?: (catId: string) => { displayName: string } | undefined;
}

/**
 * Floating "顶部浮条" for the "Select Message" context-menu action (Raft parity) — appears
 * once at least one message is selected in THIS thread (main channel or an open
 * InlineThreadPanel; see messageSelectionStore.ts for why only one thread selects at a time).
 * `fixed` positioning deliberately keeps this out of each surface's own scroll layout so
 * mounting it doesn't require restructuring either ChatContainer's or InlineThreadPanel's
 * scroll container.
 */
export function MessageSelectionBar({ threadId, messages, getCatById }: MessageSelectionBarProps) {
  const selectionThreadId = useMessageSelectionStore((s) => s.threadId);
  const selectedIds = useMessageSelectionStore((s) => s.selectedIds);
  const clear = useMessageSelectionStore((s) => s.clear);

  const handleCopyMarkdown = useCallback(async () => {
    const byId = new Map(messages.map((message) => [message.id, message]));
    const selected = selectedIds
      .map((id) => byId.get(id))
      .filter((message): message is ChatMessage => !!message)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((message) => ({
        author: resolveMessageAuthorLabel(message, getCatById),
        timestamp: message.timestamp,
        content: message.content,
      }));

    if (selected.length === 0) return;

    try {
      await navigator.clipboard.writeText(buildMessagesMarkdownQuote(selected));
      useToastStore.getState().addToast({
        type: 'success',
        title: 'Markdown 已复制',
        message: `已合并 ${selected.length} 条消息`,
        duration: 1800,
      });
    } catch {
      useToastStore.getState().addToast({ type: 'error', title: '复制失败', message: '请手动复制内容', duration: 2400 });
    } finally {
      clear();
    }
  }, [clear, getCatById, messages, selectedIds]);

  if (selectionThreadId !== threadId || selectedIds.length === 0) return null;

  return (
    <div
      className="fixed left-1/2 top-4 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-[var(--slock-radius-pill)] border border-[var(--slock-border-color)] bg-[var(--clowder-action-surface)] px-4 py-2 shadow-[var(--slock-shadow-chip)]"
      role="toolbar"
      aria-label="消息多选工具栏"
    >
      <span className="text-xs font-semibold text-[var(--cafe-text)]">已选 {selectedIds.length} 条</span>
      <button
        type="button"
        onClick={() => void handleCopyMarkdown()}
        className="rounded-[var(--slock-radius-md)] bg-[var(--cafe-accent)] px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition-opacity hover:opacity-90"
      >
        复制 Markdown
      </button>
      <button
        type="button"
        onClick={clear}
        className="rounded-[var(--slock-radius-md)] border border-[var(--slock-border-color)] px-3 py-1 text-xs font-medium text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--cafe-surface-elevated)]"
      >
        取消
      </button>
    </div>
  );
}
