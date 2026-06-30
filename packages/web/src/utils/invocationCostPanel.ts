import type { TaskEvent, TaskItem } from '@cat-cafe/shared';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

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
  };
  const hasSignal =
    summary.inputTokens != null ||
    summary.outputTokens != null ||
    summary.totalTokens != null ||
    summary.cacheReadTokens != null ||
    summary.cacheCreationTokens != null ||
    summary.costUsd != null ||
    summary.durationMs != null ||
    summary.durationApiMs != null;
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
  }
  return total;
}
