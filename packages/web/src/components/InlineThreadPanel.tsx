'use client';

import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { useCatData } from '@/hooks/useCatData';
import { usePersistedState } from '@/hooks/usePersistedState';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import type { CatStatusType } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { ChatMessage } from './ChatMessage';
import { buildCatOptions, type CatOption, detectMenuTrigger } from './chat-input-options';
import { MentionPicker } from './MentionPicker';
import { type SlashCommandItem, SlashCommandPicker } from './SlashCommandPicker';
import { ResizeHandle } from './workspace/ResizeHandle';

const THREAD_PANEL_DEFAULT_WIDTH = 320;
const THREAD_PANEL_MIN_WIDTH = 280;
const THREAD_PANEL_FALLBACK_MAX_WIDTH = 720;
const THREAD_PANEL_MAX_VIEWPORT_RATIO = 0.6;

const THREAD_STATUS_LABELS: Record<CatStatusType, string> = {
  spawning: '启动中',
  pending: '排队中',
  streaming: '回复中',
  done: '已完成',
  error: '异常',
  alive_but_silent: '静默等待',
  suspected_stall: '疑似卡住',
};

const THREAD_STATUS_TONE: Record<CatStatusType, string> = {
  spawning: 'text-[var(--cafe-accent)]',
  pending: 'text-cafe-secondary',
  streaming: 'text-conn-emerald-text',
  done: 'text-conn-emerald-text',
  error: 'text-conn-red-text',
  alive_but_silent: 'text-conn-amber-text',
  suspected_stall: 'text-conn-amber-text',
};

type InlineThreadApiMessage = ChatMessageData & { isDraft?: boolean };
type InlineThreadActiveInvocation = { catId: string; mode?: string; startedAt?: number };

export function shouldShowInlineThreadRuntimeStatus(status: CatStatusType): boolean {
  return status !== 'done' && status !== 'alive_but_silent';
}

function getThreadPanelMaxWidth() {
  if (typeof window === 'undefined') return THREAD_PANEL_FALLBACK_MAX_WIDTH;
  return Math.max(THREAD_PANEL_MIN_WIDTH, Math.floor(window.innerWidth * THREAD_PANEL_MAX_VIEWPORT_RATIO));
}

function clampThreadPanelWidth(width: number) {
  return Math.min(getThreadPanelMaxWidth(), Math.max(THREAD_PANEL_MIN_WIDTH, width));
}

export function normalizeInlineThreadMessage(message: InlineThreadApiMessage): ChatMessageData {
  if (!message.isDraft) return message;

  const normalized: InlineThreadApiMessage = {
    ...message,
    isStreaming: true,
  };
  delete normalized.isDraft;
  return normalized;
}

function detectSlashCommand(value: string, cursor: number): string | null {
  if (!value.startsWith('/') || cursor <= 0) return null;
  const token = value.match(/^\/[^\s]*/)?.[0] ?? '';
  if (cursor > token.length) return null;
  return value.slice(1, cursor);
}

interface InlineThreadPanelProps {
  threadId: string;
  sourceMessage: ChatMessageData;
  isClosing?: boolean;
  onClose: () => void;
  onReplyCountChange?: (sourceMessageId: string, branchThreadId: string, replyCount: number) => void;
}

export function InlineThreadPanel({
  threadId,
  sourceMessage,
  isClosing = false,
  onClose,
  onReplyCountChange,
}: InlineThreadPanelProps) {
  const { cats } = useCatData();
  const threadRuntime = useChatStore((state) => state.threadStates[threadId]);
  const [panelWidth, setPanelWidth, resetPanelWidth] = usePersistedState(
    'cat-cafe:inlineThreadPanelWidth',
    THREAD_PANEL_DEFAULT_WIDTH,
  );
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashItems, setSlashItems] = useState<SlashCommandItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [queueActiveInvocations, setQueueActiveInvocations] = useState<InlineThreadActiveInvocation[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);
  const pollBaselineCountRef = useRef<number>(0);
  const latestMessagesRef = useRef<ChatMessageData[]>([]);
  const mountedRef = useRef(false);
  const getCatById = useCallback((catId: string) => cats.find((cat) => cat.id === catId), [cats]);
  const runtimeCats = useMemo(() => {
    const storeActiveEntries = Object.values(threadRuntime?.activeInvocations ?? {});
    const activeEntries = [...storeActiveEntries, ...queueActiveInvocations];
    const activeCatIds = activeEntries.map((entry) => entry.catId).filter(Boolean);
    const statusCatIds = Object.entries(threadRuntime?.catStatuses ?? {})
      .filter(([, status]) => shouldShowInlineThreadRuntimeStatus(status))
      .map(([catId]) => catId);
    return Array.from(new Set([...activeCatIds, ...statusCatIds])).map((catId) => {
      const cat = getCatById(catId);
      const status = threadRuntime?.catStatuses?.[catId] ?? (activeCatIds.includes(catId) ? 'streaming' : 'pending');
      const active = activeEntries.find((entry) => entry.catId === catId);
      return {
        catId,
        label: cat?.displayName ?? cat?.name ?? catId,
        model: cat?.defaultModel ?? '',
        provider: cat?.provider ?? cat?.clientId ?? '',
        color: cat?.color.primary ?? 'var(--console-cat-fallback)',
        status,
        startedAt: active?.startedAt,
      };
    });
  }, [getCatById, queueActiveInvocations, threadRuntime?.activeInvocations, threadRuntime?.catStatuses]);
  const stopScrollPropagation = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);
  const handlePanelResize = useCallback(
    (delta: number) => {
      setPanelWidth((prev) => clampThreadPanelWidth(prev - delta));
    },
    [setPanelWidth],
  );

  useEffect(() => {
    setPanelWidth((prev) => clampThreadPanelWidth(prev));
  }, [setPanelWidth]);

  const catOptions = useMemo(() => buildCatOptions(cats), [cats]);
  const filteredCatOptions = useMemo(() => {
    if (!mentionFilter) return catOptions;
    const lower = mentionFilter.toLowerCase();
    return catOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(lower) ||
        option.insert.toLowerCase().includes(lower) ||
        option.id.toLowerCase().includes(lower),
    );
  }, [catOptions, mentionFilter]);

  const closeMentionPicker = useCallback(() => {
    setShowMentionPicker(false);
    setMentionStart(-1);
    setMentionFilter('');
  }, []);

  const closeSlashPicker = useCallback(() => {
    setShowSlashCommands(false);
    setSlashQuery('');
    setSlashSelectedIdx(0);
  }, []);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  const loadMessages = useCallback(async (options?: { showLoading?: boolean }) => {
    if (options?.showLoading !== false) setLoading(true);

    try {
      const res = await apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=60`);
      if (!res.ok) return [];
      const data = (await res.json()) as { messages?: ChatMessageData[] };
      const normalized = (data.messages ?? []).map((message) => normalizeInlineThreadMessage(message));
      if (mountedRef.current) {
        latestMessagesRef.current = normalized;
        setMessages(normalized);
      }
      return normalized;
    } catch {
      if (mountedRef.current) {
        latestMessagesRef.current = [];
        setMessages([]);
      }
      return [];
    } finally {
      if (mountedRef.current && options?.showLoading !== false) setLoading(false);
    }
  }, [threadId]);

  const loadQueueRuntime = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/queue`);
      if (!res.ok) {
        if (mountedRef.current) setQueueActiveInvocations([]);
        return [];
      }
      const data = (await res.json()) as { activeInvocations?: InlineThreadActiveInvocation[] };
      const activeInvocations = Array.isArray(data.activeInvocations) ? data.activeInvocations : [];
      if (mountedRef.current) setQueueActiveInvocations(activeInvocations);
      return activeInvocations;
    } catch {
      if (mountedRef.current) setQueueActiveInvocations([]);
      return [];
    }
  }, [threadId]);

  const stopReplyPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollStartedAtRef.current = 0;
    pollBaselineCountRef.current = 0;
  }, []);

  const startReplyPolling = useCallback(() => {
    stopReplyPolling();
    pollStartedAtRef.current = Date.now();
    pollBaselineCountRef.current = latestMessagesRef.current.length;

    pollTimerRef.current = setInterval(() => {
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]).then(([nextMessages, active]) => {
        const hasNewCompleteMessage =
          nextMessages.length > pollBaselineCountRef.current && !nextMessages.some((message) => message.isStreaming);
        const elapsed = Date.now() - pollStartedAtRef.current;
        const runtimeStillActive = active.length > 0;
        const timedOutWithoutRuntime = elapsed >= 60_000 && !runtimeStillActive;
        const hardTimedOut = elapsed >= 5 * 60_000;
        if ((hasNewCompleteMessage && !runtimeStillActive) || timedOutWithoutRuntime || hardTimedOut) stopReplyPolling();
      });
    }, 2000);
  }, [loadMessages, loadQueueRuntime, stopReplyPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void loadMessages();
    void loadQueueRuntime();
    return () => {
      mountedRef.current = false;
    };
  }, [loadMessages, loadQueueRuntime]);

  useEffect(() => () => stopReplyPolling(), [stopReplyPolling]);

  useEffect(() => {
    if (runtimeCats.length === 0) return undefined;
    const timer = setInterval(() => {
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]);
    }, 2000);
    return () => clearInterval(timer);
  }, [loadMessages, loadQueueRuntime, runtimeCats.length]);

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

  const sourceThreadMessageId = useMemo(() => {
    const sourceInBranch = messages.find(
      (msg) =>
        msg.timestamp === sourceMessage.timestamp &&
        msg.content === sourceMessage.content &&
        msg.catId === sourceMessage.catId &&
        msg.type === sourceMessage.type,
    );
    return sourceInBranch?.id;
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
          ...(sourceThreadMessageId ? { replyTo: sourceThreadMessageId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      setInput('');
      closeMentionPicker();
      onReplyCountChange?.(sourceMessage.id, threadId, replyMessages.length + 1);
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]).then(() => startReplyPolling());
    } catch (err) {
      setSendError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  }, [
    closeMentionPicker,
    input,
    loadMessages,
    loadQueueRuntime,
    onReplyCountChange,
    replyMessages.length,
    sending,
    sourceThreadMessageId,
    sourceMessage.id,
    startReplyPolling,
    threadId,
  ]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setInput(value);
      const slashQuery = detectSlashCommand(value, event.target.selectionStart);
      if (slashQuery !== null) {
        closeMentionPicker();
        setShowSlashCommands(true);
        setSlashQuery(slashQuery);
        setSlashSelectedIdx(0);
        return;
      }
      closeSlashPicker();

      const trigger = detectMenuTrigger(value, event.target.selectionStart);
      if (trigger?.type === 'mention') {
        setShowMentionPicker(true);
        setMentionStart(trigger.start);
        setMentionFilter(trigger.filter);
        setMentionSelectedIdx(0);
      } else {
        closeMentionPicker();
      }
    },
    [closeMentionPicker, closeSlashPicker],
  );

  const insertMention = useCallback(
    (option: CatOption) => {
      const before = input.slice(0, mentionStart);
      const after = input.slice(mentionStart + mentionFilter.length + 1);
      const next = `${before}${option.insert}${after}`;
      setInput(next);
      closeMentionPicker();
      setTimeout(() => {
        const cursor = before.length + option.insert.length;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [closeMentionPicker, input, mentionFilter.length, mentionStart],
  );

  const insertSlashCommand = useCallback(
    (item: SlashCommandItem) => {
      const rest = input.replace(/^\/[^\s]*/, '');
      const next = `${item.command}${rest}`;
      setInput(next);
      closeSlashPicker();
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(item.command.length, item.command.length);
      }, 0);
    },
    [closeSlashPicker, input],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashCommands) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (slashItems.length > 0) setSlashSelectedIdx((idx) => (idx + 1) % slashItems.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (slashItems.length > 0) setSlashSelectedIdx((idx) => (idx - 1 + slashItems.length) % slashItems.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const item = slashItems[slashSelectedIdx];
          if (item) insertSlashCommand(item);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSlashPicker();
          return;
        }
      }

      if (showMentionPicker) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (filteredCatOptions.length > 0) setMentionSelectedIdx((idx) => (idx + 1) % filteredCatOptions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (filteredCatOptions.length > 0) {
            setMentionSelectedIdx((idx) => (idx - 1 + filteredCatOptions.length) % filteredCatOptions.length);
          }
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const option = filteredCatOptions[mentionSelectedIdx];
          if (option) insertMention(option);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMentionPicker();
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleSend();
      }
    },
    [
      closeMentionPicker,
      closeSlashPicker,
      filteredCatOptions,
      handleSend,
      insertMention,
      insertSlashCommand,
      mentionSelectedIdx,
      showMentionPicker,
      showSlashCommands,
      slashItems,
      slashSelectedIdx,
    ],
  );

  return (
    <div
      className="thread-panel-motion hidden h-full min-h-0 flex-shrink-0 lg:flex"
      data-open={isClosing ? 'false' : 'true'}
    >
      <ResizeHandle direction="horizontal" onResize={handlePanelResize} onDoubleClick={resetPanelWidth} />
      <aside
        className="flex h-full min-h-0 flex-shrink-0 flex-col border-l border-[var(--slock-border-color)] bg-[var(--console-shell-bg)]"
        style={{ width: panelWidth }}
      >
        <div className="flex h-[54px] flex-shrink-0 items-center justify-between border-b border-[var(--slock-border-color)] px-4">
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
        {runtimeCats.length > 0 && (
          <div className="flex flex-shrink-0 flex-col gap-1 border-b border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cafe-text-muted)]">
              当前回复
            </div>
            {runtimeCats.map((item) => (
              <div
                key={item.catId}
                className="flex min-w-0 items-center gap-2 rounded-[var(--slock-radius-lg)] border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-2 py-1.5 text-xs"
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full animate-pulse" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1 truncate font-semibold text-[var(--cafe-text)]">{item.label}</span>
                <span className={`flex-shrink-0 font-medium ${THREAD_STATUS_TONE[item.status]}`}>
                  {THREAD_STATUS_LABELS[item.status]}
                </span>
                {(item.model || item.provider) && (
                  <span className="max-w-[110px] flex-shrink truncate text-[10px] text-[var(--cafe-text-muted)]">
                    {[item.model, item.provider].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3" onWheel={stopScrollPropagation}>
          <div className="mb-4 border-b border-[var(--slock-border-color)] pb-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cafe-text-muted)]">
              原始消息
            </div>
            <div className="px-1 py-1">
              <ChatMessage
                message={sourceMessage}
                getCatById={getCatById}
                disableContentCollapse
                showRuntimeMetadata
              />
            </div>
          </div>
          {loading ? (
            <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">加载中...</div>
          ) : replyMessages.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">暂无回复</div>
          ) : (
            replyMessages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                getCatById={getCatById}
                disableContentCollapse
                showRuntimeMetadata
              />
            ))
          )}
        </div>

        <div className="h-[122px] flex-shrink-0 border-t border-[var(--slock-border-color)] p-3">
          {sendError && <div className="mb-2 text-xs text-conn-red-text">{sendError}</div>}
          <div className="relative">
            {showMentionPicker && (
              <MentionPicker
                options={filteredCatOptions}
                selectedIdx={mentionSelectedIdx}
                onSelectIdx={setMentionSelectedIdx}
                onPick={insertMention}
              />
            )}
            {showSlashCommands && (
              <SlashCommandPicker
                query={slashQuery}
                selectedIdx={slashSelectedIdx}
                onSelectIdx={setSlashSelectedIdx}
                onPick={insertSlashCommand}
                onItemsChange={setSlashItems}
              />
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              placeholder="回复 Thread..."
              rows={2}
              className="h-[64px] w-full resize-none rounded-[var(--slock-radius-lg)] border border-[var(--slock-border-color)] bg-[var(--clowder-input-bg)] px-3 py-2 [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)] text-[var(--cafe-text)] outline-none transition-colors placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--console-input-stroke)] focus:ring-1 focus:ring-[var(--console-input-stroke)]"
            />
          </div>
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
    </div>
  );
}
