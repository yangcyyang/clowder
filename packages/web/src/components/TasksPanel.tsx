'use client';

import type { TaskItem, TaskStatus } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'TODO',
  doing: 'DOING',
  blocked: 'BLOCKED',
  done: 'DONE',
};

const TASK_STATUS_CLASS: Record<TaskStatus, string> = {
  todo: 'border-[var(--cafe-accent)]/30 bg-[var(--cafe-accent)]/10 text-[var(--cafe-accent)]',
  doing: 'border-cafe-crosspost/30 bg-cafe-crosspost/10 text-cafe-crosspost',
  blocked: 'border-conn-amber-text/30 bg-conn-amber-bg text-conn-amber-text',
  done: 'border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text',
};

function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface TasksPanelProps {
  threadId: string;
}

export function TasksPanel({ threadId }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    apiFetch(`/api/tasks?threadId=${encodeURIComponent(threadId)}&kind=work`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { tasks?: TaskItem[] };
      })
      .then((data) => {
        if (cancelled) return;
        setTasks(data.tasks ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setTasks([]);
        setError('任务列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  }, [tasks]);

  return (
    <section className="h-full overflow-y-auto bg-[var(--console-shell-bg)] p-5">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-[var(--cafe-text)]">Tasks</h2>
          <p className="mt-1 text-xs text-[var(--cafe-text-muted)]">当前频道里的任务列表。</p>
        </div>

        {isLoading && <div className="rounded-lg border border-[var(--slock-border-color)] p-4 text-sm text-cafe-muted">加载任务中...</div>}

        {!isLoading && error && (
          <div className="rounded-lg border border-conn-amber-text/30 bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
            {error}
          </div>
        )}

        {!isLoading && !error && sortedTasks.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--slock-border-color)] p-6 text-center text-sm text-cafe-muted">
            当前频道暂无任务。
          </div>
        )}

        {!isLoading && !error && sortedTasks.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-[var(--slock-border-color)] bg-[var(--console-panel-bg)]">
            {sortedTasks.map((task) => {
              const status = task.status;
              return (
                <article
                  key={task.id}
                  className="flex items-start gap-3 border-b border-[var(--slock-border-color)] px-4 py-3 last:border-b-0"
                >
                  <span
                    className={`mt-0.5 inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${
                      TASK_STATUS_CLASS[status] ?? TASK_STATUS_CLASS.todo
                    }`}
                  >
                    {TASK_STATUS_LABELS[status] ?? status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--cafe-text)]" title={task.title}>
                      {task.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--cafe-text-muted)]">
                      <span>{formatTaskTime(task.createdAt)}</span>
                      {task.ownerCatId && <span>Owner: {task.ownerCatId}</span>}
                      <span>#{task.id.slice(0, 6)}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
