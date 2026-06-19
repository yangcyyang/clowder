'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, type CatData } from '@/hooks/useCatData';
import type { CatInvocationInfo, CatStatusType, InvocationPhase, ThreadState } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

type ActiveInvocationMap = ThreadState['activeInvocations'];

interface AgentStatusIndicatorProps {
  threadId: string;
  activeInvocations: ActiveInvocationMap;
  catStatuses: Record<string, CatStatusType>;
  catInvocations: Record<string, CatInvocationInfo>;
  getCatById: (catId: string) => CatData | undefined;
}

interface AgentStatusRow {
  catId: string;
  label: string;
  color: string;
  startedAt: number;
  status?: CatStatusType;
  phase?: InvocationPhase;
}

const ACTIVE_STATUSES = new Set<CatStatusType>([
  'spawning',
  'pending',
  'streaming',
  'alive_but_silent',
  'suspected_stall',
]);

function formatElapsed(startedAt: number, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function getAgentStatusLabel(status: CatStatusType | undefined, phase: InvocationPhase | undefined): string {
  switch (phase) {
    case 'queued':
      return '排队中';
    case 'context_building':
      return '正在整理上下文';
    case 'runtime_starting':
      return '正在启动模型';
    case 'first_token_waiting':
      return '正在思考';
    case 'tool_calling':
      return '正在执行工具';
    case 'persisting':
      return '正在整理回复';
    case 'done':
      return '已完成';
    default:
      break;
  }

  switch (status) {
    case 'spawning':
      return '正在启动';
    case 'pending':
      return '排队中';
    case 'streaming':
      return '正在生成';
    case 'alive_but_silent':
      return '仍在处理';
    case 'suspected_stall':
      return '可能卡住';
    default:
      return '正在思考';
  }
}

function buildRows({
  activeInvocations,
  catStatuses,
  catInvocations,
  getCatById,
  now,
}: Pick<AgentStatusIndicatorProps, 'activeInvocations' | 'catStatuses' | 'catInvocations' | 'getCatById'> & {
  now: number;
}): AgentStatusRow[] {
  const rows = new Map<string, AgentStatusRow>();

  for (const slot of Object.values(activeInvocations ?? {})) {
    if (!slot?.catId || rows.has(slot.catId)) continue;
    const cat = getCatById(slot.catId);
    rows.set(slot.catId, {
      catId: slot.catId,
      label: cat ? formatCatName(cat) : slot.catId,
      color: cat?.color.primary ?? 'var(--console-cat-fallback)',
      startedAt: slot.startedAt ?? catInvocations[slot.catId]?.startedAt ?? now,
      status: catStatuses[slot.catId],
      phase: slot.phase ?? catInvocations[slot.catId]?.phase,
    });
  }

  for (const [catId, status] of Object.entries(catStatuses ?? {})) {
    if (rows.has(catId) || !ACTIVE_STATUSES.has(status)) continue;
    const cat = getCatById(catId);
    const invocation = catInvocations[catId];
    rows.set(catId, {
      catId,
      label: cat ? formatCatName(cat) : catId,
      color: cat?.color.primary ?? 'var(--console-cat-fallback)',
      startedAt: invocation?.startedAt ?? now,
      status,
      phase: invocation?.phase,
    });
  }

  return Array.from(rows.values());
}

export function AgentStatusIndicator({
  threadId,
  activeInvocations,
  catStatuses,
  catInvocations,
  getCatById,
}: AgentStatusIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());

  const rows = useMemo(
    () => buildRows({ activeInvocations, catStatuses, catInvocations, getCatById, now }),
    [activeInvocations, catStatuses, catInvocations, getCatById, now],
  );

  useEffect(() => {
    if (rows.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [rows.length]);

  const handleStop = useCallback(
    async (catId: string) => {
      await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cancel/${encodeURIComponent(catId)}`, {
        method: 'POST',
      });
    },
    [threadId],
  );

  if (rows.length === 0) return null;

  return (
    <div
      className="mx-4 mb-2 flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
      data-testid="agent-status-indicator"
      aria-live="polite"
    >
      {rows.map((row) => {
        const statusLabel = getAgentStatusLabel(row.status, row.phase);
        return (
          <span
            key={row.catId}
            className="inline-flex items-center gap-1.5 border border-[var(--slock-border-color)] bg-[var(--clowder-action-surface)] px-2 py-1"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-medium text-[var(--cafe-text)]">{row.label}</span>
            <span className="text-[var(--cafe-text-muted)]">{statusLabel}</span>
            <span className="tabular-nums text-[var(--cafe-text-muted)]">{formatElapsed(row.startedAt, now)}</span>
            <button
              type="button"
              onClick={() => void handleStop(row.catId)}
              className="ml-1 text-[var(--cafe-text-muted)] transition-colors hover:text-conn-red-text"
              aria-label={`停止 ${row.label}`}
            >
              停止
            </button>
          </span>
        );
      })}
    </div>
  );
}
