/**
 * Daily Cost Budget Gate — batch 3-E, item 2.
 *
 * Pre-run enforcement of the catalog-level `CatConfig.costBudget.perCatDailyUsd`
 * cap (see packages/shared/src/types/cat-breed.ts `CatCostBudget`). Gated by
 * env `CLOWDER_BUDGET_ENFORCE` (default OFF — see env-registry.ts); when off
 * this module is a pure no-op (`{ allowed: true }` without touching the
 * invocation store), so wiring the dep unconditionally is safe.
 *
 * Design reference: docs/research/maka-absorption.md §5 (maka's three-layer
 * enforceCaps hard-cap pattern, headless/task-run-store.ts) and
 * docs/research/clowder-raft-capability-analysis.md:343 (F128 daily usage →
 * per-cat budget,超限 → failed(budget_exhausted)).
 *
 * Not to be confused with claude-budget-gate.ts (sibling file) — that gate is
 * about *prompt/context size* (visible-prompt token budget before resume);
 * this one is about *USD cost* accumulated so far today.
 *
 * ## Known limitation: costUsd is only reliable for Claude cats
 *
 * `TokenUsage.costUsd` (packages/api/src/domains/cats/services/types.ts) is
 * populated from the Claude CLI's own reported cost; other providers never
 * set it (see usage-aggregator.ts's `usage.costUsd ?? 0` fallback — the same
 * gap already exists in the F128 usage dashboard). Rather than guess a
 * token-based cap from unverified data, this gate takes the conservative
 * choice explicitly requested by the batch 3-E brief: for any cat whose
 * `clientId !== 'anthropic'`, enforcement is SKIPPED (the run is allowed to
 * proceed) and a warning is logged — never silently, but also never a false
 * block. Cats with no `costBudget` configured are likewise always allowed
 * (opt-in field).
 *
 * ## Data source
 *
 * Reuses the same `InvocationRecordStore.scanAll()` + `usageByCat` shape the
 * F128 `/api/usage/daily` route (routes/usage.ts) already aggregates from —
 * no new store or schema. A short in-process cache (15s TTL, same pattern as
 * routes/usage.ts's 60s response cache) keeps a tight queue-draining loop
 * from re-scanning the whole keyspace on every single invocation attempt.
 */

import { catRegistry } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';

const log = createModuleLogger('daily-cost-budget-gate');

export function isBudgetEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_BUDGET_ENFORCE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export interface BudgetGateBlockedCat {
  readonly catId: string;
  readonly spentUsd: number;
  readonly capUsd: number;
}

export interface BudgetGateResult {
  readonly allowed: boolean;
  /** Present only when allowed === false — the first cat whose cap was exceeded. */
  readonly blocked?: BudgetGateBlockedCat;
}

/**
 * Minimal duck-typed seam — only scanAll() is used. Deliberately NOT a
 * `Pick<IInvocationRecordStore, 'scanAll'>` alias: TypeScript's "weak type"
 * excess-property check flags an all-optional Pick when the caller's
 * concrete union type (AnyInvocationRecordStore) doesn't structurally
 * overlap with anything else, even though scanAll itself is a real,
 * optional, and compatible member. A plain local interface avoids that.
 */
export interface DailyCostBudgetGateInvocationStoreLike {
  scanAll?(): Promise<InvocationRecord[]>;
}

export interface DailyCostBudgetGateDeps {
  invocationRecordStore: DailyCostBudgetGateInvocationStoreLike;
}

const SPEND_CACHE_TTL_MS = 15_000;
interface SpendCacheEntry {
  spentUsd: number;
  expiresAt: number;
}
const spendCache = new Map<string, SpendCacheEntry>();

function todayDateString(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** @internal test seam — clears the in-process spend cache between test cases. */
export function _clearDailyCostBudgetCache(): void {
  spendCache.clear();
}

/**
 * Sum today's costUsd for one cat across all InvocationRecords (all users —
 * costBudget is a per-cat persona cap, not per-user). Returns undefined when
 * the store can't report usage at all (in-memory store has no scanAll) —
 * callers treat that the same as "unknown data" (conservative allow).
 */
async function resolveSpentUsdForCatToday(
  catId: string,
  store: DailyCostBudgetGateDeps['invocationRecordStore'],
): Promise<number | undefined> {
  if (typeof store.scanAll !== 'function') return undefined;

  const today = todayDateString();
  const cacheKey = `${catId}:${today}`;
  const now = Date.now();
  const cached = spendCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.spentUsd;

  const records = await store.scanAll();
  let spentUsd = 0;
  for (const record of records) {
    const usage = record.usageByCat?.[catId];
    if (!usage) continue;
    // Same stable bucketing key F128's usage-aggregator uses: usageRecordedAt
    // (set once when usage is first written), falling back to updatedAt for
    // pre-F128 records.
    const recordedAt = record.usageRecordedAt ?? record.updatedAt;
    if (todayDateString(recordedAt) !== today) continue;
    spentUsd += usage.costUsd ?? 0;
  }

  spendCache.set(cacheKey, { spentUsd, expiresAt: now + SPEND_CACHE_TTL_MS });
  return spentUsd;
}

/**
 * Pre-run daily budget check for a set of target cats. No-op (`{allowed:true}`)
 * when CLOWDER_BUDGET_ENFORCE is off. Checks cats in order and returns the
 * FIRST one over budget — callers should treat this as "block the whole run",
 * matching the batch brief ("该 run 以 failureClass='budget_exhausted' 终止").
 */
export async function checkDailyBudgetCap(
  targetCats: readonly string[],
  deps: DailyCostBudgetGateDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BudgetGateResult> {
  if (!isBudgetEnforceEnabled(env)) return { allowed: true };

  for (const catId of targetCats) {
    const config = catRegistry.tryGet(catId)?.config;
    const capUsd = config?.costBudget?.perCatDailyUsd;
    if (capUsd == null) continue; // no cap configured for this cat — always allowed

    // Known limitation (see module doc): costUsd is only reliable for Claude cats.
    // Conservative choice: skip enforcement (allow) + log, rather than guess a
    // token-based cap from unverified data for other providers.
    if (config?.clientId !== 'anthropic') {
      log.warn(
        { catId, clientId: config?.clientId, capUsd },
        '[daily-cost-budget-gate] costUsd unreliable for this provider — skipping enforcement (conservative pass-through)',
      );
      continue;
    }

    const spentUsd = await resolveSpentUsdForCatToday(catId, deps.invocationRecordStore);
    if (spentUsd == null) {
      log.warn(
        { catId, capUsd },
        '[daily-cost-budget-gate] invocation store cannot report usage (no scanAll) — skipping enforcement',
      );
      continue;
    }

    if (spentUsd >= capUsd) {
      return { allowed: false, blocked: { catId, spentUsd, capUsd } };
    }
  }

  return { allowed: true };
}
