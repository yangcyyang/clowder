'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

export interface FreshnessHoldSummary {
  id: string;
  catId: string;
  threadId: string;
  status: 'held' | 'reviewing' | 'needs_attention';
  version: number;
  reviewCount: number;
  createdAt: number;
  updatedAt: number;
  reviewDeadlineAt: number;
  attentionReason?: 'timeout' | 'review_limit';
}

export function freshnessHoldLabel(hold: Pick<FreshnessHoldSummary, 'status' | 'attentionReason'>): string {
  if (hold.status === 'reviewing') return '正在结合新消息重新审阅';
  if (hold.status === 'needs_attention') {
    return hold.attentionReason === 'timeout' ? '审阅已超时，等待人工处理' : '多次遇到新消息，等待人工处理';
  }
  return '收到新消息，旧稿已安全扣住';
}

export function FreshnessHoldBar({ threadId }: { threadId: string }) {
  const [holds, setHolds] = useState<FreshnessHoldSummary[]>([]);
  const { getCatById } = useCatData();

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/freshness-holds?threadId=${encodeURIComponent(threadId)}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { holds?: FreshnessHoldSummary[] };
      setHolds(Array.isArray(payload.holds) ? payload.holds : []);
    } catch {
      // Recovery metadata is best-effort; never replace chat with an error state.
    }
  }, [threadId]);

  useEffect(() => {
    setHolds([]);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const visibleHolds = useMemo(() => [...holds].sort((left, right) => right.updatedAt - left.updatedAt), [holds]);
  if (visibleHolds.length === 0) return null;

  return (
    <section aria-label="等待审阅的回答" className="border-t border-conn-amber-ring bg-conn-amber-bg/55 px-4 py-2.5">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        {visibleHolds.map((hold) => {
          const cat = getCatById(hold.catId);
          const catName = cat ? formatCatName(cat) : hold.catId;
          const needsAttention = hold.status === 'needs_attention';
          return (
            <div
              key={hold.id}
              role="status"
              className="flex items-start gap-3 border-l-2 border-conn-amber-text bg-[var(--clowder-action-surface)] px-3 py-2 shadow-[var(--slock-shadow-chip)]"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full bg-conn-amber-text ${needsAttention ? '' : 'animate-pulse'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs font-semibold text-cafe-secondary">{catName}</span>
                  <span className="text-xs text-conn-amber-text">{freshnessHoldLabel(hold)}</span>
                </div>
                <p className="mt-0.5 text-[11px] leading-4 text-cafe-muted">
                  私有草稿没有发送，也不会显示在历史记录中
                  {hold.reviewCount > 0 ? ` · 已复核 ${hold.reviewCount}/2 次` : ''}
                </p>
              </div>
              <span className="shrink-0 border border-conn-amber-ring px-1.5 py-0.5 text-[10px] font-medium text-conn-amber-text">
                {needsAttention ? '需人工处理' : 'Freshness Hold'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
