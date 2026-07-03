import type { TaskEvent, TaskItem } from '@cat-cafe/shared';
import type { PromptSource, PromptSourceBreakdown, PromptSourceBreakdownItem } from '@/stores/chat-types';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const PROMPT_SOURCES = new Set<PromptSource>(['history', 'project', 'skill', 'rules', 'memory']);

export interface InvocationUsageSummary {
  catId: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  sourceBreakdown?: PromptSourceBreakdown;
  historyMode?: 'observe';
  historyFullTokens?: number;
  historyBudgetRatio?: number;
  historyGovernanceDegraded?: boolean;
}

export function isInvocationCostPanelEnabled(): boolean {
  const value =
    process.env.NEXT_PUBLIC_CAT_CAFE_INVOCATION_COST_PANEL ??
    process.env.NEXT_PUBLIC_CAT_CAFE_USAGE_COST_PANEL ??
    '';
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSourceBreakdown(value: unknown): PromptSourceBreakdown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { totalEstimatedTokens?: unknown; sources?: unknown };
  if (!Array.isArray(raw.sources)) return undefined;
  const sources: PromptSourceBreakdownItem[] = raw.sources
    .map((item): PromptSourceBreakdownItem | null => {
      if (!item || typeof item !== 'object') return null;
      const parsed = item as { source?: unknown; chars?: unknown; estimatedTokens?: unknown };
      if (typeof parsed.source !== 'string' || !PROMPT_SOURCES.has(parsed.source as PromptSource)) return null;
      const estimatedTokens = asNumber(parsed.estimatedTokens);
      if (estimatedTokens == null || estimatedTokens <= 0) return null;
      return {
        source: parsed.source as PromptSource,
        chars: asNumber(parsed.chars) ?? 0,
        estimatedTokens,
      };
    })
    .filter((item): item is PromptSourceBreakdownItem => item != null);
  if (sources.length === 0) return undefined;
  const totalEstimatedTokens =
    asNumber(raw.totalEstimatedTokens) ?? sources.reduce((sum, source) => sum + source.estimatedTokens, 0);
  return { totalEstimatedTokens, sources };
}

function mergeSourceBreakdown(
  current: PromptSourceBreakdown | undefined,
  incoming: PromptSourceBreakdown | undefined,
): PromptSourceBreakdown | undefined {
  if (!incoming) return current;
  const bySource = new Map<PromptSource, PromptSourceBreakdownItem>();
  for (const item of [...(current?.sources ?? []), ...incoming.sources]) {
    const existing = bySource.get(item.source);
    bySource.set(item.source, {
      source: item.source,
      chars: (existing?.chars ?? 0) + item.chars,
      estimatedTokens: (existing?.estimatedTokens ?? 0) + item.estimatedTokens,
    });
  }
  const sources = Array.from(bySource.values()).filter((item) => item.estimatedTokens > 0);
  const totalEstimatedTokens = sources.reduce((sum, source) => sum + source.estimatedTokens, 0);
  return totalEstimatedTokens > 0 ? { totalEstimatedTokens, sources } : undefined;
}

function readUsageEvent(event: TaskEvent): InvocationUsageSummary | null {
  if (event.type !== 'usage') return null;
  const data = event.data ?? {};
  const inputTokens = asNumber(data.inputTokens);
  const outputTokens = asNumber(data.outputTokens);
  const totalTokens = asNumber(data.totalTokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0) || undefined);
  const summary: InvocationUsageSummary = {
    catId: event.catId,
    provider: asString(data.provider),
    model: asString(data.model),
    inputTokens,
    cacheReadTokens: asNumber(data.cacheReadTokens),
    cacheCreationTokens: asNumber(data.cacheCreationTokens),
    outputTokens,
    totalTokens,
    costUsd: asNumber(data.costUsd),
    durationMs: asNumber(data.durationMs),
    durationApiMs: asNumber(data.durationApiMs),
    sourceBreakdown: readSourceBreakdown(data.sourceBreakdown),
    historyMode: data.historyMode === 'observe' ? 'observe' : undefined,
    historyFullTokens: asNumber(data.historyFullTokens),
    historyBudgetRatio: asNumber(data.historyBudgetRatio),
    historyGovernanceDegraded:
      typeof data.historyGovernanceDegraded === 'boolean' ? data.historyGovernanceDegraded : undefined,
  };
  const hasSignal =
    summary.inputTokens != null ||
    summary.outputTokens != null ||
    summary.totalTokens != null ||
    summary.cacheReadTokens != null ||
    summary.cacheCreationTokens != null ||
    summary.costUsd != null ||
    summary.durationMs != null ||
    summary.durationApiMs != null ||
    summary.sourceBreakdown != null ||
    summary.historyMode != null;
  return hasSignal ? summary : null;
}

export function readTaskUsageSummaries(task: TaskItem): InvocationUsageSummary[] {
  return (task.events ?? []).map(readUsageEvent).filter((event): event is InvocationUsageSummary => event != null);
}

export function summarizeTaskUsage(events: readonly InvocationUsageSummary[]): InvocationUsageSummary | null {
  if (events.length === 0) return null;
  const total: InvocationUsageSummary = { catId: events.length === 1 ? events[0].catId : `${events.length} turns` };
  for (const event of events) {
    total.inputTokens = (total.inputTokens ?? 0) + (event.inputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
    total.cacheCreationTokens = (total.cacheCreationTokens ?? 0) + (event.cacheCreationTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (event.outputTokens ?? 0);
    total.totalTokens = (total.totalTokens ?? 0) + (event.totalTokens ?? 0);
    total.costUsd = (total.costUsd ?? 0) + (event.costUsd ?? 0);
    total.durationMs = (total.durationMs ?? 0) + (event.durationMs ?? 0);
    total.durationApiMs = (total.durationApiMs ?? 0) + (event.durationApiMs ?? 0);
    total.sourceBreakdown = mergeSourceBreakdown(total.sourceBreakdown, event.sourceBreakdown);
    if (event.historyMode === 'observe') {
      total.historyMode = 'observe';
      total.historyFullTokens = Math.max(total.historyFullTokens ?? 0, event.historyFullTokens ?? 0);
      total.historyBudgetRatio = Math.max(total.historyBudgetRatio ?? 0, event.historyBudgetRatio ?? 0);
      total.historyGovernanceDegraded = Boolean(total.historyGovernanceDegraded || event.historyGovernanceDegraded);
    }
  }
  return total;
}
