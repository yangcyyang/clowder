'use client';

import type { TaskEvidence, TaskItem, TaskStatus } from '@cat-cafe/shared';
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

const EVIDENCE_FIELDS = [
  { key: 'tests', label: '测试', placeholder: '例：pnpm --filter @cat-cafe/web exec tsc --noEmit 通过' },
  { key: 'build', label: 'Build', placeholder: '例：pnpm --filter @cat-cafe/web build 通过' },
  { key: 'screenshot', label: '截图', placeholder: '例：附件 ID / 截图路径 / 验收截图说明' },
  { key: 'review', label: 'Review', placeholder: '例：@专家-Claude review 通过，发现项已处理' },
  { key: 'lesson', label: 'Lesson', placeholder: '例：已补录 LL-054 或本次无需新增 lesson' },
] as const satisfies ReadonlyArray<{
  key: keyof Omit<TaskEvidence, 'updatedAt'>;
  label: string;
  placeholder: string;
}>;

function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function countEvidence(evidence?: TaskEvidence): number {
  if (!evidence) return 0;
  return EVIDENCE_FIELDS.filter((field) => evidence[field.key]?.trim()).length;
}

interface TasksPanelProps {
  threadId: string;
}

export function TasksPanel({ threadId }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, TaskEvidence>>({});
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  function toggleEvidence(task: TaskItem) {
    setSaveError(null);
    setExpandedTaskId((current) => (current === task.id ? null : task.id));
    setEvidenceDrafts((current) => {
      if (current[task.id]) return current;
      return { ...current, [task.id]: task.evidence ?? {} };
    });
  }

  function updateEvidenceDraft(taskId: string, key: keyof Omit<TaskEvidence, 'updatedAt'>, value: string) {
    setEvidenceDrafts((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] ?? {}),
        [key]: value,
      },
    }));
  }

  async function saveEvidence(taskId: string) {
    const evidence = evidenceDrafts[taskId] ?? {};
    setSavingTaskId(taskId);
    setSaveError(null);

    try {
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidence }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as TaskItem;
      setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
      setEvidenceDrafts((current) => ({ ...current, [updated.id]: updated.evidence ?? {} }));
    } catch {
      setSaveError('证物保存失败，请稍后重试');
    } finally {
      setSavingTaskId(null);
    }
  }

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
              const evidence = task.evidence;
              const evidenceCount = countEvidence(evidence);
              const isExpanded = expandedTaskId === task.id;
              const draft = evidenceDrafts[task.id] ?? evidence ?? {};
              return (
                <article
                  key={task.id}
                  className="border-b border-[var(--slock-border-color)] px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-start gap-3">
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
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-[var(--slock-border-color)] px-2 py-1 text-[11px] font-semibold text-[var(--cafe-text)] transition hover:border-[var(--cafe-accent)]/50 hover:bg-[var(--cafe-accent)]/10"
                      onClick={() => toggleEvidence(task)}
                    >
                      证物 {evidenceCount}/5
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5 pl-14">
                    {EVIDENCE_FIELDS.map((field) => {
                      const filled = Boolean(evidence?.[field.key]?.trim());
                      return (
                        <span
                          key={field.key}
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            filled
                              ? 'border-[var(--cafe-accent)]/35 bg-[var(--cafe-accent)]/10 text-[var(--cafe-accent)]'
                              : 'border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] text-[var(--cafe-text-muted)]'
                          }`}
                        >
                          {field.label}
                        </span>
                      );
                    })}
                  </div>

                  {isExpanded && (
                    <div className="mt-3 rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-[var(--cafe-text)]">交付证物</div>
                          <div className="mt-0.5 text-[11px] text-[var(--cafe-text-muted)]">
                            记录测试、构建、截图、review 和 lesson，方便验收时一眼确认。
                          </div>
                        </div>
                        {evidence?.updatedAt && (
                          <span className="shrink-0 text-[10px] text-[var(--cafe-text-muted)]">
                            更新 {formatTaskTime(evidence.updatedAt)}
                          </span>
                        )}
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        {EVIDENCE_FIELDS.map((field) => (
                          <label key={field.key} className="block">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--cafe-text-muted)]">
                              {field.label}
                            </span>
                            <textarea
                              className="mt-1 min-h-20 w-full resize-y rounded-md border border-[var(--slock-border-color)] bg-[var(--console-panel-bg)] px-3 py-2 text-xs leading-[1.5] text-[var(--cafe-text)] outline-none transition placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--cafe-accent)] focus:ring-1 focus:ring-[var(--cafe-accent)]/30"
                              value={draft[field.key] ?? ''}
                              placeholder={field.placeholder}
                              onChange={(event) => updateEvidenceDraft(task.id, field.key, event.target.value)}
                            />
                          </label>
                        ))}
                      </div>

                      {saveError && <div className="mt-3 text-xs text-conn-amber-text">{saveError}</div>}

                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          className="rounded-md bg-[var(--cafe-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={savingTaskId === task.id}
                          onClick={() => void saveEvidence(task.id)}
                        >
                          {savingTaskId === task.id ? '保存中...' : '保存证物'}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
