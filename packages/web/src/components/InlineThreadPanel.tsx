'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { type ChatMessage as ChatMessageData } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { ResizeHandle } from './workspace/ResizeHandle';

const THREAD_PANEL_DEFAULT_WIDTH = 320;
const THREAD_PANEL_MIN_WIDTH = 280;
const THREAD_PANEL_MAX_WIDTH = 500;

interface InlineThreadPanelProps {
  threadId: string;
  sourceMessage: ChatMessageData;
  onClose: () => void;
  onReplyCountChange?: (sourceMessageId: string, branchThreadId: string, replyCount: number) => void;
}

function formatMessageAuthor(message: ChatMessageData): string {
  if (message.type === 'user' && !message.catId) return '用户';
  return message.catId ?? 'Agent';
}

export function InlineThreadPanel({ threadId, sourceMessage, onClose, onReplyCountChange }: InlineThreadPanelProps) {
  const [panelWidth, setPanelWidth, resetPanelWidth] = usePersistedState(
    'cat-cafe:inlineThreadPanelWidth',
    THREAD_PANEL_DEFAULT_WIDTH,
  );
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handlePanelResize = useCallback(
    (delta: number) => {
      setPanelWidth((prev) => Math.min(THREAD_PANEL_MAX_WIDTH, Math.max(THREAD_PANEL_MIN_WIDTH, prev - delta)));
    },
    [setPanelWidth],
  );

  const loadMessages = useCallback(() => {
    let cancelled = false;
    setLoading(true);

    apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=60`)
      .then(async (res) => {
        if (!res.ok) return { messages: [] };
        return (await res.json()) as { messages?: ChatMessageData[] };
      })
      .then((data) => {
        if (!cancelled) setMessages(data.messages ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => loadMessages(), [loadMessages]);

  const replyMessages = useMemo(() => {
    const sourceIndex = messages.findIndex(
      (msg) =>
        msg.timestamp === sourceMessage.timestamp &&
        msg.content === sourceMessage.content &&
        msg.catId === sourceMessage.catId &&
        msg.type === sourceMessage.type,
    );

    if (sourceIndex >= 0) {
      return messages.slice(sourceIndex + 1);
    }

    return messages.filter((msg) => msg.timestamp > sourceMessage.timestamp);
  }, [messages, sourceMessage.catId, sourceMessage.content, sourceMessage.timestamp, sourceMessage.type]);

  useEffect(() => {
    onReplyCountChange?.(sourceMessage.id, threadId, replyMessages.length);
  }, [onReplyCountChange, replyMessages.length, sourceMessage.id, threadId]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;

    setSending(true);
    setSendError(null);
    try {
      const res = await apiFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          threadId,
          userId: getUserId(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      setInput('');
      onReplyCountChange?.(sourceMessage.id, threadId, replyMessages.length + 1);
      loadMessages();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  }, [input, loadMessages, onReplyCountChange, replyMessages.length, sending, sourceMessage.id, threadId]);

  return (
    <>
      <div className="hidden lg:flex">
        <ResizeHandle direction="horizontal" onResize={handlePanelResize} onDoubleClick={resetPanelWidth} />
      </div>
      <aside
        className="hidden lg:flex h-full flex-shrink-0 flex-col border-l border-[var(--slock-border-color)] bg-[var(--console-panel-bg)]"
        style={{ width: panelWidth }}
      >
      <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--slock-border-color)] px-4 py-3">
        <span className="text-sm font-semibold text-[var(--cafe-text)]">Thread</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)]"
          aria-label="关闭 Thread 面板"
        >
          x
        </button>
      </div>

      <div className="flex-shrink-0 border-b border-[var(--slock-border-color)] p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cafe-text-muted)]">
          原始消息
        </div>
        <div className="rounded-lg bg-[var(--console-card-soft-bg)] px-3 py-2 text-sm">
          <div className="mb-1 text-xs text-[var(--cafe-text-muted)]">{formatMessageAuthor(sourceMessage)}</div>
          <div className="whitespace-pre-wrap break-words text-[var(--cafe-text)]">
            {sourceMessage.content?.trim() || '（无正文）'}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">加载中...</div>
        ) : replyMessages.length === 0 ? (
          <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">暂无回复</div>
        ) : (
          replyMessages.map((msg) => (
            <div key={msg.id} className="mb-3 rounded-lg bg-[var(--console-card-soft-bg)] px-3 py-2 text-sm">
              <div className="mb-1 text-xs text-[var(--cafe-text-muted)]">{formatMessageAuthor(msg)}</div>
              <div className="whitespace-pre-wrap break-words text-[var(--cafe-text)]">
                {msg.content?.trim() || '（无正文）'}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex-shrink-0 border-t border-[var(--slock-border-color)] p-3">
        {sendError && <div className="mb-2 text-xs text-conn-red-text">{sendError}</div>}
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder="回复 Thread..."
          rows={3}
          className="w-full resize-none rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] px-3 py-2 text-sm text-[var(--cafe-text)] outline-none transition-colors placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--color-cafe-accent)]"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-[var(--cafe-text-muted)]">⌘/Ctrl + Enter 发送</span>
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="rounded-md bg-[var(--color-cafe-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? '发送中...' : '发送'}
          </button>
        </div>
      </div>
      </aside>
    </>
  );
}
