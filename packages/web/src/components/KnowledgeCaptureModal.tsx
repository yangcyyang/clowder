'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { apiFetch } from '@/utils/api-client';
import { getThreadHref } from './ThreadSidebar/thread-navigation';

type KnowledgeType = 'feature' | 'lesson' | 'decision' | 'vault';

interface KnowledgeCaptureResult {
  type: KnowledgeType;
  path: string;
  id: string;
}

interface VaultStatus {
  available: boolean;
  reason?: string;
}

interface KnowledgeCaptureModalProps {
  open: boolean;
  sourceThreadId: string;
  defaultTitle: string;
  onClose: () => void;
  onCreated: (result: KnowledgeCaptureResult) => void;
}

const TYPE_OPTIONS: Array<{ value: KnowledgeType; label: string; description: string }> = [
  { value: 'feature', label: 'Feature', description: '生成 docs/features/Fxxx-*.md' },
  { value: 'lesson', label: 'Lesson', description: '追加到 docs/public-lessons.md' },
  { value: 'decision', label: 'Decision', description: '生成 docs/decisions/0xx-*.md' },
  {
    value: 'vault',
    label: '知识库',
    description: '投递到 Obsidian 收件夹（00待确认/clowder-inbox），你审核归位后可被全体猫检索。',
  },
];

export function KnowledgeCaptureModal({
  open,
  sourceThreadId,
  defaultTitle,
  onClose,
  onCreated,
}: KnowledgeCaptureModalProps) {
  const [type, setType] = useState<KnowledgeType>('lesson');
  const [title, setTitle] = useState(defaultTitle);
  const [summary, setSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeCaptureResult | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    setType('lesson');
    setTitle(defaultTitle);
    setSummary('');
    setIsSubmitting(false);
    setError(null);
    setResult(null);
    setVaultStatus(null);
  }, [defaultTitle, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/knowledge/vault-status');
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body && typeof body.available === 'boolean') {
          setVaultStatus({ available: body.available, reason: body.reason });
        } else {
          setVaultStatus({ available: false, reason: '无法确认知识库收件夹状态，请稍后重试' });
        }
      } catch {
        if (!cancelled) setVaultStatus({ available: false, reason: '无法确认知识库收件夹状态，请稍后重试' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSubmitting, onClose, open]);

  const isVaultAvailable = vaultStatus?.available === true;
  const canSubmit = useMemo(
    () =>
      title.trim().length > 0 &&
      summary.trim().length > 0 &&
      !isSubmitting &&
      (type !== 'vault' || isVaultAvailable),
    [isSubmitting, isVaultAvailable, summary, title, type],
  );

  if (!open) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const vaultExtras =
        type === 'vault'
          ? {
              sourceThreadTitle: defaultTitle,
              sourceUrl: typeof window !== 'undefined' ? `${window.location.origin}${getThreadHref(sourceThreadId)}` : undefined,
            }
          : {};
      const res = await apiFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          summary: summary.trim(),
          sourceThreadId,
          ...vaultExtras,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body?.error as string) ?? '沉淀失败，请稍后重试');
        return;
      }
      const created = body as KnowledgeCaptureResult;
      setResult(created);
      onCreated(created);
    } catch {
      setError('网络请求未完成，请稍后重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4"
      role="presentation"
    >
      <div className="absolute inset-0" aria-hidden="true" onClick={isSubmitting ? undefined : onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-capture-title"
        className="relative w-full max-w-[520px] rounded-2xl border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="knowledge-capture-title" className="text-xs font-bold tracking-[0.18em] text-[var(--cafe-text)]">
              沉淀为知识
            </h2>
            <p className="mt-1 text-xs leading-[1.5] text-[var(--cafe-text-secondary)]">
              手动把当前讨论沉淀成 Feature、Lesson、Decision 或投递到知识库收件夹。暂不做 AI 自动总结。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg px-2 py-1 text-sm text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] disabled:opacity-50"
            aria-label="关闭沉淀弹窗"
          >
            ×
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <div>
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              类型
            </span>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {TYPE_OPTIONS.map((option) => {
                const isVaultOption = option.value === 'vault';
                const vaultDisabled = isVaultOption && !isVaultAvailable;
                const disabledReason = isVaultOption
                  ? (vaultStatus?.reason ?? (vaultStatus === null ? '正在检查知识库收件夹可用性…' : undefined))
                  : undefined;
                return (
                  <button
                    key={option.value}
                    type="button"
                    data-testid={`knowledge-type-${option.value}`}
                    onClick={() => {
                      if (vaultDisabled) return;
                      setType(option.value);
                    }}
                    disabled={vaultDisabled}
                    aria-disabled={vaultDisabled}
                    title={disabledReason}
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      vaultDisabled
                        ? 'cursor-not-allowed border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] text-[var(--cafe-text-muted)] opacity-50'
                        : type === option.value
                          ? 'border-[var(--cafe-accent)] bg-[var(--console-card-soft-bg)] text-[var(--cafe-text)]'
                          : 'border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] text-[var(--cafe-text-secondary)] hover:bg-[var(--console-hover-bg)]'
                    }`}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-[1.4] text-[var(--cafe-text-muted)]">
                      {option.description}
                    </span>
                    {vaultDisabled && disabledReason && (
                      <span className="mt-1 block text-[10px] leading-[1.3] text-conn-crimson-text">
                        {disabledReason}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              标题 *
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              className="mt-1 w-full rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm text-[var(--cafe-text)] outline-none transition-colors focus:border-[var(--cafe-accent)]"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              摘要 / 描述 *
            </span>
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="写清楚这条知识要沉淀什么，后续 owner 可继续补 AC、根因或决策细节。"
              className="mt-1 min-h-32 w-full resize-none rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm leading-[1.5] text-[var(--cafe-text)] outline-none transition-colors placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--cafe-accent)]"
            />
          </label>

          {error && (
            <div className="rounded-lg border border-conn-crimson-ring bg-conn-crimson-bg px-3 py-2 text-xs text-conn-crimson-text">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-conn-green-ring bg-conn-green-bg px-3 py-2 text-xs leading-[1.5] text-conn-green-text">
              {result.type === 'vault' ? (
                <>
                  已投递收件夹，下次索引重建后可被检索（或手动触发重建）。
                  <br />
                  {result.id} → <code>{result.path}</code>
                </>
              ) : (
                <>
                  已生成：{result.id} → <code>{result.path}</code>
                </>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--cafe-text-secondary)] transition-colors hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
            >
              关闭
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--cafe-accent)] px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (type === 'vault' ? '投递中...' : '生成中...') : type === 'vault' ? '投递到收件夹' : '生成文档'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
