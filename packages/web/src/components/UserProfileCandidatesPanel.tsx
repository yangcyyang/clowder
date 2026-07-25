'use client';

/**
 * 批次 3 F-E: 铲屎官画像人审 UI (docs/prd/PRD-memory-upgrade.md §7.1 画像人审页).
 *
 * Self-contained global entry: fetches its own candidate list/count (poll +
 * refetch-on-open, "选简单的"), so it doesn't need any prop wiring from
 * ChatContainer — placement is purely "render this in the header's icon row".
 *
 * Backend: GET /api/user-profile/candidates, POST .../:id/approve,
 * POST .../:id/reject (routes/user-profile.ts, batch 3 F-E). Owner-only —
 * a 400/403 just surfaces as an inline error, since this entry only renders
 * for the Owner's own UI in practice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface UserProfileCandidateConflict {
  readonly kind: 'closed-decision' | 'fact' | 'preference';
  readonly key: string;
  readonly existingLine: string;
  readonly flagged: boolean;
}

export interface UserProfileCandidate {
  readonly id: string;
  readonly content: string;
  readonly sourceCatId: string | null;
  readonly threadId: string;
  readonly action: string;
  readonly conflict: UserProfileCandidateConflict | null;
  /** 批次 2 (F-B) 冲突消解若给候选附合并/退休建议文案则展示；字段可选，缺省时不渲染。 */
  readonly suggestion?: string;
  readonly createdAt: number;
}

const POLL_INTERVAL_MS = 30_000;

const ACTION_LABELS: Record<string, string> = {
  candidate: '新条目',
  hold: '有冲突',
  promote: '已直写',
  skip: '低置信度',
};

/** Pure, exported for testing. */
export function candidateActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Pure, exported for testing. Same zh-CN short format as CapabilityAuditLog. */
export function formatCandidateTimestamp(createdAt: number): string {
  return new Date(createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ProfileCandidatesIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="4" y="3.5" width="12" height="13" rx="1.5" />
      <path d="M7.5 8h5M7.5 11h3.5" strokeLinecap="round" />
      <path d="M7 3.5V3a1 1 0 011-1h4a1 1 0 011 1v.5" strokeLinecap="round" />
    </svg>
  );
}

interface CandidatesResponse {
  readonly candidates?: UserProfileCandidate[];
  readonly pendingCount?: number;
}

/** Global entry: header icon + pending-count badge + click-to-open review popover. */
export function UserProfileCandidatesEntry() {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<UserProfileCandidate[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/user-profile/candidates');
      if (!res.ok) {
        setError(`加载失败 (${res.status})`);
        return;
      }
      const body = (await res.json().catch(() => null)) as CandidatesResponse | null;
      const list = body?.candidates ?? [];
      setCandidates(list);
      setPendingCount(body?.pendingCount ?? list.length);
    } catch {
      setError('网络请求未完成，请稍后重试');
    } finally {
      setLoading(false);
      hasLoadedRef.current = true;
    }
  }, []);

  // Poll for the badge count regardless of open state — simplest option that
  // still keeps the badge fresh without the user opening the panel.
  useEffect(() => {
    void fetchCandidates();
    const timer = window.setInterval(() => {
      void fetchCandidates();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [fetchCandidates]);

  useEffect(() => {
    if (open) void fetchCandidates();
  }, [open, fetchCandidates]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-user-profile-candidates-root]')) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setDecidingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/user-profile/candidates/${id}/${decision}`, { method: 'POST' });
      if (res.ok) {
        setCandidates((prev) => prev.filter((c) => c.id !== id));
        setPendingCount((prev) => Math.max(0, prev - 1));
      } else {
        // Deliberately does NOT trigger an immediate fetchCandidates() re-fetch
        // here: that function's own `setError(null)` at the top would race
        // this error message and clear it in the same tick. The item stays in
        // the list (still accurate — the decision didn't go through) and the
        // next poll/open naturally resyncs.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `${decision === 'approve' ? '批准' : '驳回'}失败，请稍后重试`);
      }
    } catch {
      setError('网络请求未完成，请稍后重试');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <div className="relative" data-user-profile-candidates-root>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="slock-header-action slock-header-action--icon relative inline-flex"
        title="铲屎官画像候选审阅"
        aria-label="铲屎官画像候选审阅"
        aria-expanded={open}
        data-testid="user-profile-candidates-entry-button"
      >
        <ProfileCandidatesIcon />
        {pendingCount > 0 && (
          <span
            data-testid="user-profile-candidates-badge"
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-conn-red-text px-1 text-[10px] font-semibold leading-none text-[var(--cafe-surface)]"
          >
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="user-profile-candidates-panel"
          className="absolute left-0 top-full z-[80] mt-2 w-[340px] rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-4 py-3">
            <div>
              <p className="text-[13px] font-bold text-cafe">画像候选审阅</p>
              <p className="text-[11px] text-cafe-muted">猫提议的新画像条目，批准后写入 USER.md</p>
            </div>
            {pendingCount > 0 && (
              <span className="rounded-full bg-conn-red-bg px-2 py-0.5 text-[10px] font-semibold text-conn-red-text">
                {pendingCount}
              </span>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto px-2 py-2">
            {loading && !hasLoadedRef.current ? (
              <p className="px-2 py-4 text-center text-xs text-cafe-muted">加载中…</p>
            ) : null}
            {error ? <p className="px-2 py-2 text-xs text-conn-red-text">{error}</p> : null}
            {!loading && candidates.length === 0 && !error ? (
              <p data-testid="user-profile-candidates-empty" className="px-2 py-6 text-center text-xs text-cafe-muted">
                暂无待审候选
              </p>
            ) : null}
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                data-testid={`user-profile-candidate-${candidate.id}`}
                className="mb-2 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-soft-bg)] p-3 last:mb-0"
              >
                <p className="text-xs leading-relaxed text-cafe">{candidate.content}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-cafe-muted">
                  <span className="rounded bg-[var(--console-hover-bg)] px-1.5 py-0.5">
                    来源猫：{candidate.sourceCatId ?? '未知'}
                  </span>
                  <span className="rounded bg-[var(--console-hover-bg)] px-1.5 py-0.5">
                    {candidateActionLabel(candidate.action)}
                  </span>
                  <span>{formatCandidateTimestamp(candidate.createdAt)}</span>
                </div>
                {candidate.suggestion ? (
                  <p className="mt-1.5 rounded-lg bg-conn-amber-bg px-2 py-1 text-[11px] text-conn-amber-text">
                    建议：{candidate.suggestion}
                  </p>
                ) : null}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => decide(candidate.id, 'reject')}
                    disabled={decidingId === candidate.id}
                    aria-label={`驳回候选 ${candidate.id}`}
                    data-testid={`user-profile-candidate-reject-${candidate.id}`}
                    className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1 text-[11px] font-semibold text-cafe-secondary transition hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
                  >
                    驳回
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(candidate.id, 'approve')}
                    disabled={decidingId === candidate.id}
                    aria-label={`批准候选 ${candidate.id}`}
                    data-testid={`user-profile-candidate-approve-${candidate.id}`}
                    className="rounded-lg bg-[var(--cafe-accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
                  >
                    批准
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
