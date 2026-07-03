'use client';

import type { TaskItem, TaskStatus } from '@cat-cafe/shared';
import { useState } from 'react';
import {
  isInvocationCostPanelEnabled,
  readTaskUsageSummaries,
  summarizeTaskUsage,
  type InvocationUsageSummary,
} from '@/utils/invocationCostPanel';
import { getUsageRisk } from '@/utils/usageRisk';
import type { PromptSource, PromptSourceBreakdown } from '@/stores/chat-types';
import { CatAvatar } from './CatAvatar';
import { formatCost, formatDuration, formatTokenCount } from './status-helpers';

const SOURCE_LABELS: Record<PromptSource, string> = {
  history: 'history',
  project: 'project',
  skill: 'skill',
  rules: 'rules',
  memory: 'memory',
};

const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'in_review',
  in_review: 'done',
  blocked: 'doing',
  done: 'todo',
  failed: 'doing',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  in_review: '待验收',
  blocked: '阻塞中',
  done: '已完成',
  failed: '失败',
};

const STATUS_STYLES: Record<TaskStatus, { text: string; border: string; pillBg: string }> = {
  doing: {
    text: 'text-cafe-crosspost',
    border: 'border-l-cafe-crosspost',
    pillBg: 'bg-cafe-crosspost/10 text-cafe-crosspost',
  },
  blocked: {
    text: 'text-conn-red-text',
    border: 'border-l-conn-red-text',
    pillBg: 'bg-conn-red-bg text-conn-red-text',
  },
  in_review: {
    text: 'text-cafe-accent',
    border: 'border-l-cafe-accent',
    pillBg: 'bg-cafe-accent/10 text-cafe-accent',
  },
  todo: {
    text: 'text-cafe-muted',
    border: 'border-l-cafe-muted',
    pillBg: 'bg-cafe-surface-elevated text-cafe-muted',
  },
  done: {
    text: 'text-conn-emerald-text',
    border: 'border-l-green-600',
    pillBg: 'bg-conn-emerald-bg text-conn-emerald-text',
  },
  failed: {
    text: 'text-conn-red-text',
    border: 'border-l-conn-red-text',
    pillBg: 'bg-conn-red-bg text-conn-red-text',
  },
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function UsageChip({ usage }: { usage: InvocationUsageSummary }) {
  const usageRisk = getUsageRisk(usage);
  const historyObservation = formatHistoryObservation(usage);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-cafe-muted">
      {usage.totalTokens != null && (
        <span className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-1.5 py-0.5 tabular-nums">
          {formatTokenCount(usage.totalTokens)} tok
        </span>
      )}
      {usage.costUsd != null && (
        <span className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 text-conn-amber-text tabular-nums">
          {formatCost(usage.costUsd)}
        </span>
      )}
      {usage.durationMs != null && (
        <span className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-1.5 py-0.5 tabular-nums">
          {formatDuration(usage.durationMs)}
        </span>
      )}
      {historyObservation && (
        <span
          className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-1.5 py-0.5 tabular-nums"
          title={usage.historyGovernanceDegraded ? 'history governance observation degraded' : undefined}
        >
          {historyObservation}
        </span>
      )}
      {usageRisk && (
        <span
          className="rounded-full border border-conn-red-text/40 bg-conn-red-bg px-1.5 py-0.5 font-semibold text-conn-red-text"
          title={usageRisk.reason}
        >
          {usageRisk.label}
        </span>
      )}
    </div>
  );
}

function UsageDetailRow({ usage }: { usage: InvocationUsageSummary }) {
  const label = [usage.catId, usage.model].filter(Boolean).join(' · ');
  const usageRisk = getUsageRisk(usage);
  const historyObservation = formatHistoryObservation(usage);
  return (
    <div className="rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-2 py-1.5 text-[10px]">
      <div className="mb-1 flex items-center gap-1 text-cafe-muted">
        <span className="font-semibold text-cafe-secondary">{label || usage.catId}</span>
        {usage.provider && <span>· {usage.provider}</span>}
        {usageRisk && (
          <span className="rounded-full bg-conn-red-bg px-1.5 py-0.5 font-semibold text-conn-red-text" title={usageRisk.reason}>
            {usageRisk.label}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-cafe-muted tabular-nums">
        {usage.inputTokens != null && <span>input {formatTokenCount(usage.inputTokens)}</span>}
        {usage.cacheReadTokens != null && <span>cacheRead {formatTokenCount(usage.cacheReadTokens)}</span>}
        {usage.cacheCreationTokens != null && <span>cacheCreate {formatTokenCount(usage.cacheCreationTokens)}</span>}
        {usage.outputTokens != null && <span>output {formatTokenCount(usage.outputTokens)}</span>}
        {usage.costUsd != null && <span className="text-conn-amber-text">cost {formatCost(usage.costUsd)}</span>}
        {usage.durationMs != null && <span>duration {formatDuration(usage.durationMs)}</span>}
        {historyObservation && (
          <span title={usage.historyGovernanceDegraded ? 'history governance observation degraded' : undefined}>
            {historyObservation}
          </span>
        )}
      </div>
      {usage.sourceBreakdown && <UsageSourceBreakdown breakdown={usage.sourceBreakdown} />}
    </div>
  );
}

function formatHistoryObservation(usage: InvocationUsageSummary): string | null {
  const parts: string[] = [];
  if (usage.historyFullTokens != null) parts.push(`history ${formatTokenCount(usage.historyFullTokens)}`);
  if (usage.historyBudgetRatio != null) parts.push(`${Math.round(usage.historyBudgetRatio * 100)}%`);
  if (usage.historyGovernanceDegraded) parts.push('degraded');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function UsageSourceBreakdown({ breakdown }: { breakdown: PromptSourceBreakdown }) {
  const sources = breakdown.sources
    .filter((source) => source.estimatedTokens > 0)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  if (sources.length === 0 || breakdown.totalEstimatedTokens <= 0) return null;
  return (
    <div className="mt-1.5 border-t border-[var(--console-border-soft)] pt-1.5">
      <div className="mb-1 text-[10px] font-semibold text-cafe-muted">来源估算</div>
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => {
          const ratio = Math.round((source.estimatedTokens / breakdown.totalEstimatedTokens) * 100);
          return (
            <span
              key={source.source}
              className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] text-cafe-muted tabular-nums"
            >
              {SOURCE_LABELS[source.source]} {ratio}% · {formatTokenCount(source.estimatedTokens)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function TaskCard({
  task,
  onStatusChange,
}: {
  task: TaskItem;
  onStatusChange: (taskId: string, newStatus: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = task.status as TaskStatus;
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.todo;
  const showCostPanel = isInvocationCostPanelEnabled();
  const usageEvents = showCostPanel ? readTaskUsageSummaries(task) : [];
  const usageTotal = summarizeTaskUsage(usageEvents);

  return (
    <div
      className={`border-l-4 ${style.border} bg-cafe-surface-elevated border border-[var(--console-border-soft)] rounded-xl p-3 mx-3 mb-1.5 hover:-translate-y-0.5 transition-transform ease-out`}
    >
      <div className="flex items-center gap-2">
        {/* Title */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left text-sm font-medium text-cafe-secondary truncate"
        >
          {task.title}
        </button>

        {/* Owner avatar */}
        {task.ownerCatId && <CatAvatar catId={task.ownerCatId} size={14} />}

        {/* Status pill (clickable to cycle) */}
        <button
          type="button"
          onClick={() => onStatusChange(task.id, STATUS_CYCLE[status])}
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${style.pillBg} transition-colors hover:opacity-80`}
        >
          {STATUS_LABELS[status]}
        </button>
      </div>

      {showCostPanel && usageTotal && <UsageChip usage={usageTotal} />}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-[var(--console-border-soft)]">
          {task.why && <p className="text-xs text-cafe-muted leading-relaxed">{task.why}</p>}
          <p className="text-[10px] text-cafe-muted mt-1">
            {formatRelativeTime(task.createdAt)} · {task.createdBy === 'user' ? '铲屎官' : task.createdBy}
          </p>
          {showCostPanel && usageEvents.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <p className="text-[10px] font-semibold text-cafe-muted">Invocation 成本明细</p>
              {usageEvents.map((usage, index) => (
                <UsageDetailRow key={`${usage.catId}-${index}`} usage={usage} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
