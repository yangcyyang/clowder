/**
 * Usage Aggregator — F128
 * 纯函数：将 InvocationRecord[] 按日 × 猫聚合 token 消耗。
 */

import type { InvocationRecord } from './stores/ports/InvocationRecordStore.js';
import type { TokenUsage } from './types.js';

/** Aggregated token stats for a single cat on a single day */
export interface CatDailyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** ADR-024 W1-A: subset of inputTokens written to cache (Claude only; other providers 0). */
  cacheCreationTokens: number;
  /** ADR-024 W1-A: cacheReadTokens / inputTokens, 0 when inputTokens is 0.
   *  This is the cache-hit-rate signal the ADR verification plan tracks
   *  (long session target: <20% at v1 baseline → >70% after v2 layout). */
  cacheReadRatio: number;
  costUsd: number;
  /** Number of times this cat participated (one multi-cat invocation = 1 per cat) */
  participations: number;
}

/** Aggregated totals for a day or grand total */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** ADR-024 W1-A: subset of inputTokens written to cache (Claude only; other providers 0). */
  cacheCreationTokens: number;
  /** ADR-024 W1-A: cacheReadTokens / inputTokens, 0 when inputTokens is 0. */
  cacheReadRatio: number;
  costUsd: number;
  /** True invocation count (one multi-cat invocation = 1) */
  invocations: number;
}

/** One day's aggregated data */
export interface DailyUsageEntry {
  date: string; // YYYY-MM-DD
  cats: Record<string, CatDailyUsage>;
  total: UsageTotals;
}

/** Full aggregation result */
export interface DailyUsageReport {
  period: { from: string; to: string };
  daily: DailyUsageEntry[];
  grandTotal: UsageTotals;
}

export interface AggregateOptions {
  days: number;
  catId?: string;
}

function emptyCatUsage(): CatDailyUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheReadRatio: 0,
    costUsd: 0,
    participations: 0,
  };
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheReadRatio: 0,
    costUsd: 0,
    invocations: 0,
  };
}

/** ADR-024 W1-A: cache-hit-rate signal. 0 when there's no input to divide by
 *  (avoids NaN/Infinity leaking into the API response). Rounded to 4 decimals
 *  (basis-point precision) — matches the granularity costUsd rounding uses. */
function computeCacheReadRatio(cacheReadTokens: number, inputTokens: number): number {
  if (inputTokens <= 0) return 0;
  return Math.round((cacheReadTokens / inputTokens) * 10_000) / 10_000;
}

function roundCostCat(usage: CatDailyUsage): CatDailyUsage {
  return {
    ...usage,
    cacheReadRatio: computeCacheReadRatio(usage.cacheReadTokens, usage.inputTokens),
    costUsd: Math.round(usage.costUsd * 1_000_000) / 1_000_000,
  };
}

function roundCostTotals(usage: UsageTotals): UsageTotals {
  return {
    ...usage,
    cacheReadRatio: computeCacheReadRatio(usage.cacheReadTokens, usage.inputTokens),
    costUsd: Math.round(usage.costUsd * 1_000_000) / 1_000_000,
  };
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function resolveInputTokens(usage: TokenUsage): number {
  if (typeof usage.inputTokens === 'number') return usage.inputTokens;
  if (typeof usage.lastTurnInputTokens === 'number') return usage.lastTurnInputTokens;
  if (typeof usage.contextUsedTokens === 'number') return usage.contextUsedTokens;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  return 0;
}

function resolveOutputTokens(usage: TokenUsage, resolvedInputTokens: number): number {
  if (typeof usage.outputTokens === 'number') return usage.outputTokens;
  if (typeof usage.totalTokens === 'number') {
    return Math.max(0, usage.totalTokens - resolvedInputTokens);
  }
  return 0;
}

/**
 * Aggregate invocation records into a daily-by-cat usage report.
 * Pure function — no side effects, no I/O.
 */
export function aggregateUsageByDay(records: InvocationRecord[], options: AggregateOptions): DailyUsageReport {
  const now = new Date();
  const to = toDateString(now.getTime());
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - options.days + 1);
  const from = toDateString(fromDate.getTime());

  // Bucket: date -> catId -> CatDailyUsage
  const catBuckets = new Map<string, Map<string, CatDailyUsage>>();
  // Track true invocation count per day (record-level, not per-cat)
  const dayInvocations = new Map<string, number>();

  for (const record of records) {
    if (!record.usageByCat) continue;

    // Bucket by usageRecordedAt (stable, set once when usageByCat is first written).
    // Falls back to updatedAt for records created before F128 added this field.
    const date = toDateString(record.usageRecordedAt ?? record.updatedAt);

    // Skip records outside the requested date window
    if (date < from || date > to) continue;

    let contributed = false;
    for (const [catId, usage] of Object.entries(record.usageByCat)) {
      if (options.catId && catId !== options.catId) continue;
      contributed = true;

      let dayBucket = catBuckets.get(date);
      if (!dayBucket) {
        dayBucket = new Map();
        catBuckets.set(date, dayBucket);
      }

      const existing = dayBucket.get(catId) ?? emptyCatUsage();
      const resolvedInputTokens = resolveInputTokens(usage);
      existing.inputTokens += resolvedInputTokens;
      existing.outputTokens += resolveOutputTokens(usage, resolvedInputTokens);
      existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
      // Non-Claude providers have no cache-creation equivalent — usage.cacheCreationTokens
      // stays undefined for them, ?? 0 keeps the field present without fabricating a value.
      existing.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      existing.costUsd += usage.costUsd ?? 0;
      existing.participations += 1;
      dayBucket.set(catId, existing);
    }

    // Count this record as one invocation (regardless of how many cats participated)
    if (contributed) {
      dayInvocations.set(date, (dayInvocations.get(date) ?? 0) + 1);
    }
  }

  // Build sorted daily entries (newest first)
  const dates = [...catBuckets.keys()].sort((a, b) => b.localeCompare(a));
  const grandTotal = emptyTotals();
  const daily: DailyUsageEntry[] = [];

  for (const date of dates) {
    const dayBucket = catBuckets.get(date)!;
    const cats: Record<string, CatDailyUsage> = {};
    const dayTotal = emptyTotals();
    dayTotal.invocations = dayInvocations.get(date) ?? 0;

    for (const [catId, usage] of dayBucket) {
      cats[catId] = roundCostCat(usage);
      dayTotal.inputTokens += usage.inputTokens;
      dayTotal.outputTokens += usage.outputTokens;
      dayTotal.cacheReadTokens += usage.cacheReadTokens;
      dayTotal.cacheCreationTokens += usage.cacheCreationTokens;
      dayTotal.costUsd += usage.costUsd;
    }

    grandTotal.inputTokens += dayTotal.inputTokens;
    grandTotal.outputTokens += dayTotal.outputTokens;
    grandTotal.cacheReadTokens += dayTotal.cacheReadTokens;
    grandTotal.cacheCreationTokens += dayTotal.cacheCreationTokens;
    grandTotal.costUsd += dayTotal.costUsd;
    grandTotal.invocations += dayTotal.invocations;

    daily.push({ date, cats, total: roundCostTotals(dayTotal) });
  }

  return { period: { from, to }, daily, grandTotal: roundCostTotals(grandTotal) };
}
