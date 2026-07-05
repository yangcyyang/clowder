'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatInvocationInfo, InvocationPhase } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/** F122B AC-B8+B9: Per-cat execution status bar with stop controls.
 *  B8/B9 polish: cat names use formatCatName() — "品种（variant）" format, colors from cat-config. */
export function ThreadExecutionBar() {
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const { getCatById } = useCatData();
  const [, setTick] = useState(0);

  // Extract unique active cats from invocations
  const activeCats = Object.entries(activeInvocations ?? {}).reduce(
    (acc, inv) => {
      const [, slot] = inv;
      if (!acc.some((c) => c.catId === slot.catId)) {
        acc.push({
          catId: slot.catId,
          startedAt: slot.startedAt ?? Date.now(),
          toolPolicy: slot.toolPolicy,
          toolPolicySource: slot.toolPolicySource,
          contextBudget: slot.contextBudget,
          phase: slot.phase,
        });
      }
      return acc;
    },
    [] as Array<{
      catId: string;
      startedAt: number;
      toolPolicy?: 'minimal' | 'standard' | 'full';
      toolPolicySource?: 'agent-default' | 'user-override';
      phase?: InvocationPhase;
      contextBudget?: CatInvocationInfo['contextBudget'];
    }>,
  );

  // Build display info from cat-config (dynamic, not hardcoded)
  const catDisplayMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const { catId } of activeCats) {
      const cat = getCatById(catId);
      if (cat) {
        map.set(catId, {
          label: formatCatName(cat),
          color: cat.color.primary,
        });
      } else {
        map.set(catId, { label: catId, color: 'var(--console-cat-fallback)' });
      }
    }
    return map;
  }, [activeCats, getCatById]);

  // Auto-update elapsed time every second when cats are active
  useEffect(() => {
    if (activeCats.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeCats.length]);

  const handleStopCat = useCallback(
    async (catId: string) => {
      if (!currentThreadId) return;
      await apiFetch(`/api/threads/${currentThreadId}/cancel/${catId}`, { method: 'POST' });
    },
    [currentThreadId],
  );

  const handleStopAll = useCallback(async () => {
    if (!currentThreadId) return;
    await Promise.all(activeCats.map(({ catId }) => handleStopCat(catId)));
  }, [currentThreadId, activeCats, handleStopCat]);

  if (activeCats.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-[var(--slock-border-color)] bg-[var(--clowder-running-bar-bg)] px-4 py-2 text-xs">
      <span className="text-cafe-muted font-medium shrink-0">执行中</span>
      {activeCats.map(({ catId, startedAt, toolPolicy, toolPolicySource, phase, contextBudget }) => {
        const info = catDisplayMap.get(catId) ?? { label: catId, color: 'var(--console-cat-fallback)' };
        return (
          <CatStatusChip
            key={catId}
            catId={catId}
            label={info.label}
            color={info.color}
            startedAt={startedAt}
            toolPolicy={toolPolicy}
            toolPolicySource={toolPolicySource}
            phase={phase}
            contextBudget={contextBudget}
            onStop={handleStopCat}
          />
        );
      })}
      {activeCats.length > 1 && (
        <button
          type="button"
          onClick={handleStopAll}
          className="ml-auto text-xs text-cafe-muted hover:text-conn-red-text transition-colors shrink-0"
        >
          全部停止
        </button>
      )}
    </div>
  );
}

function CatStatusChip({
  catId,
  label,
  color,
  startedAt,
  toolPolicy,
  toolPolicySource,
  phase,
  contextBudget,
  onStop,
}: {
  catId: string;
  label: string;
  color: string;
  startedAt: number;
  toolPolicy?: 'minimal' | 'standard' | 'full';
  toolPolicySource?: 'agent-default' | 'user-override';
  phase?: InvocationPhase;
  contextBudget?: CatInvocationInfo['contextBudget'];
  onStop: (catId: string) => void;
}) {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const policyLabel =
    toolPolicy === 'minimal' ? '轻量' : toolPolicy === 'full' ? '全量' : toolPolicy === 'standard' ? '标准' : undefined;
  const sourceLabel =
    toolPolicySource === 'user-override' ? '用户指定' : toolPolicySource === 'agent-default' ? '默认' : undefined;
  const governanceLabel =
    contextBudget?.governanceTier === 'core'
      ? '家规:核心'
      : contextBudget?.governanceTier === 'operational'
        ? '家规:运营'
        : undefined;
  const phaseLabel = getPhaseLabel(phase);
  const historyGovernanceLabel =
    contextBudget?.historyMode && contextBudget.historyBudgetRatio != null
      ? `历史${Math.round(contextBudget.historyBudgetRatio * 100)}%`
      : undefined;
  const budgetLabel = contextBudget
    ? `${Math.round(contextBudget.estimatedTokens / 1000)}k/${Math.round(contextBudget.maxPromptTokens / 1000)}k · ${contextBudget.historyMessages}条`
    : undefined;
  const contextTitle = contextBudget
    ? [
        `上下文预算：${contextBudget.estimatedTokens} / ${contextBudget.maxPromptTokens} tokens`,
        `历史消息：${contextBudget.historyMessages}${contextBudget.usesFullHistory ? '（全量）' : '（裁剪/摘要）'}`,
        `家规层级：${contextBudget.governanceTier === 'core' ? '核心摘要' : '运营规则'} · ${contextBudget.governanceEstimatedTokens} tokens${
          contextBudget.governanceSourceInjected ? ' · 已按需注入原文' : ''
        }`,
        ...(contextBudget.historyMode
          ? [
              [
                `历史治理：${contextBudget.historyMode}`,
                `full=${contextBudget.historyFullTokens ?? 0} tokens`,
                ...(contextBudget.historySummaryTokens != null
                  ? [`summary=${contextBudget.historySummaryTokens} tokens`]
                  : []),
                `ratio=${Math.round((contextBudget.historyBudgetRatio ?? 0) * 100)}%`,
                ...(contextBudget.summarySegmentId ? [`segment=${contextBudget.summarySegmentId}`] : []),
                ...(contextBudget.historyGovernanceDegraded ? ['degraded'] : []),
              ].join(' · '),
            ]
          : []),
        `加载：${contextBudget.loadedBlocks.join(', ') || '无'}`,
        `跳过：${contextBudget.skippedBlocks.join(', ') || '无'}`,
      ].join('\n')
    : undefined;

  return (
    <span className="flex items-center gap-1.5 rounded-[var(--slock-radius-pill)] border border-[var(--slock-border-color)] bg-[var(--clowder-action-surface)] px-2.5 py-1 shadow-sm">
      <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
      <span className="text-cafe-secondary font-medium">{label}</span>
      {policyLabel ? (
        <span className="text-cafe-muted">
          {policyLabel}
          {sourceLabel ? `·${sourceLabel}` : ''}
        </span>
      ) : null}
      {governanceLabel ? <span className="text-cafe-muted">{governanceLabel}</span> : null}
      {phaseLabel ? <span className="text-cafe-muted">{phaseLabel}</span> : null}
      {budgetLabel ? (
        <span className="text-cafe-muted" title={contextTitle}>
          {budgetLabel}
        </span>
      ) : null}
      {historyGovernanceLabel ? (
        <span className="text-conn-amber-text tabular-nums" title={contextTitle}>
          {historyGovernanceLabel}
        </span>
      ) : null}
      <span className="text-cafe-muted tabular-nums">{timeStr}</span>
      <button
        type="button"
        onClick={() => onStop(catId)}
        className="ml-0.5 text-cafe-muted hover:text-conn-red-text transition-colors"
        aria-label={`Stop ${catId}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </span>
  );
}

function getPhaseLabel(phase: InvocationPhase | undefined): string | undefined {
  switch (phase) {
    case 'queued':
      return '排队';
    case 'context_building':
      return '组上下文';
    case 'runtime_starting':
      return '启动模型';
    case 'first_token_waiting':
      return '等首 token';
    case 'tool_calling':
      return '工具调用';
    case 'persisting':
      return '写回';
    case 'done':
      return '完成';
    default:
      return undefined;
  }
}
