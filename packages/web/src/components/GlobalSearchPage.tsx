'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getThreadHref } from './ThreadSidebar/thread-navigation';

interface MessageSearchResult {
  id: string;
  threadId: string;
  threadTitle?: string;
  content: string;
  timestamp: number;
  catId: string | null;
  type: 'user' | 'assistant' | 'connector' | 'system';
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function formatExcerpt(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= 180) return text;
  return `${text.slice(0, 180)}...`;
}

function getThreadDisplayTitle(thread: Pick<Thread, 'id' | 'title' | 'isDM'>): string {
  if (thread.title) return thread.title;
  if (thread.id === 'default') return '大厅';
  return thread.isDM ? '私信' : '未命名对话';
}

export function GlobalSearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryParam = searchParams.get('q') ?? '';
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<MessageSearchResult[]>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [isSearchingMessages, setIsSearchingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      handleBack();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBack]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingThreads(true);
    apiFetch('/api/threads')
      .then(async (res) => {
        if (!res.ok) return { threads: [] };
        return (await res.json()) as { threads?: Thread[] };
      })
      .then((data) => {
        if (!cancelled) setThreads(data.threads ?? []);
      })
      .catch(() => {
        if (!cancelled) setThreads([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingThreads(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matchingThreads = useMemo(() => {
    const needle = normalize(submittedQuery);
    if (!needle) return [];
    return threads
      .filter((thread) => {
        const title = normalize(getThreadDisplayTitle(thread));
        const id = normalize(thread.id);
        const project = normalize(thread.projectPath);
        return title.includes(needle) || id.includes(needle) || project.includes(needle);
      })
      .slice(0, 12);
  }, [submittedQuery, threads]);

  const runSearch = useCallback(async (nextQuery: string) => {
    const trimmed = nextQuery.trim();
    setSubmittedQuery(trimmed);
    setMessages([]);
    setError(null);
    if (!trimmed) return;

    setIsSearchingMessages(true);
    try {
      const res = await apiFetch(`/api/messages/search?q=${encodeURIComponent(trimmed)}&limit=50`);
      if (!res.ok) throw new Error(`搜索失败：${res.status}`);
      const data = (await res.json()) as { messages?: MessageSearchResult[] };
      setMessages(data.messages ?? []);
    } catch {
      setError('消息搜索失败，请稍后重试。');
      setMessages([]);
    } finally {
      setIsSearchingMessages(false);
    }
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setQuery(queryParam);
    void runSearch(queryParam);
  }, [queryParam, runSearch]);

  const openThread = useCallback(
    (threadId: string, messageId?: string) => {
      const href = messageId
        ? `${getThreadHref(threadId)}?highlight=${encodeURIComponent(messageId)}`
        : getThreadHref(threadId);
      router.push(href);
    },
    [router],
  );

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--cafe-bg)] text-[var(--cafe-text)]">
      <header className="border-b-2 border-[var(--slock-border-color)] bg-[var(--cafe-surface)] px-5 py-3">
        <form
          className="flex items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
        >
          <span className="flex h-9 w-9 items-center justify-center border-2 border-[var(--slock-border-color)] bg-[var(--console-rail-active)] text-lg">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索频道、私信、消息或 ID..."
            className="console-form-input h-10 flex-1 border-2 text-sm"
            data-testid="global-search-input"
          />
          <button type="submit" className="console-button-primary h-10 px-4 text-sm">
            搜索
          </button>
          <button
            type="button"
            className="console-button h-10 px-3 text-xs"
            onClick={handleBack}
            title="返回"
            aria-label="返回上一页"
          >
            ESC
          </button>
        </form>
      </header>

      <section className="flex-1 overflow-y-auto px-5 py-5">
        {!submittedQuery && (
          <div className="mx-auto mt-32 max-w-md text-center text-[var(--clowder-muted-soft)]">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center border-2 border-[var(--slock-border-color)] bg-[var(--cafe-surface)] text-3xl">
              ⌕
            </div>
            <div className="font-semibold text-[var(--cafe-text)]">搜索全部内容</div>
            <p className="mt-2 text-sm">输入关键词后，可检索频道、私信和历史消息。快捷键：⌘K / Ctrl+K。</p>
          </div>
        )}

        {submittedQuery && (
          <div className="mx-auto flex max-w-5xl flex-col gap-5">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--clowder-muted-soft)]">
                  频道与私信
                </h2>
                <span className="text-xs text-[var(--clowder-muted-soft)]">
                  {isLoadingThreads ? '加载中...' : `${matchingThreads.length} 个结果`}
                </span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {matchingThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => openThread(thread.id)}
                    className="border-2 border-[var(--slock-border-color)] bg-[var(--cafe-surface)] px-3 py-2 text-left shadow-[var(--shadow-chip)] transition-colors hover:bg-[var(--clowder-sidebar-active-bg)]"
                  >
                    <div className="truncate font-semibold"># {getThreadDisplayTitle(thread)}</div>
                    <div className="mt-1 truncate text-xs text-[var(--clowder-muted-soft)]">
                      {thread.projectPath ?? thread.id}
                    </div>
                  </button>
                ))}
                {!isLoadingThreads && matchingThreads.length === 0 && (
                  <div className="border border-[var(--console-border-soft)] bg-[var(--cafe-surface)] px-3 py-3 text-sm text-[var(--clowder-muted-soft)]">
                    没有匹配的频道或私信
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--clowder-muted-soft)]">
                  消息
                </h2>
                <span className="text-xs text-[var(--clowder-muted-soft)]">
                  {isSearchingMessages ? '搜索中...' : `${messages.length} 个结果`}
                </span>
              </div>
              <div className="space-y-2">
                {error && (
                  <div className="border-2 border-[var(--conn-red-text)] bg-[var(--cafe-surface)] px-3 py-2 text-sm text-[var(--conn-red-text)]">
                    {error}
                  </div>
                )}
                {messages.map((message) => (
                  <button
                    key={message.id}
                    type="button"
                    onClick={() => openThread(message.threadId, message.id)}
                    className="w-full border-2 border-[var(--slock-border-color)] bg-[var(--cafe-surface)] px-3 py-2 text-left transition-colors hover:bg-[var(--clowder-sidebar-active-bg)]"
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-[var(--clowder-muted-soft)]">
                      <span className="font-semibold text-[var(--cafe-text)]">
                        #{' '}
                        {message.threadTitle ??
                          getThreadDisplayTitle({ id: message.threadId, title: null, isDM: false })}
                      </span>
                      <span>{message.type}</span>
                    </div>
                    <div className="line-clamp-3 text-sm leading-6">{formatExcerpt(message.content)}</div>
                  </button>
                ))}
                {!isSearchingMessages && messages.length === 0 && !error && (
                  <div className="border border-[var(--console-border-soft)] bg-[var(--cafe-surface)] px-3 py-3 text-sm text-[var(--clowder-muted-soft)]">
                    没有匹配的消息
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
