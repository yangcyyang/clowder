export interface FreshnessHoldRolloutPolicy {
  readonly enabled: boolean;
  readonly cats: ReadonlySet<string>;
  readonly threads: ReadonlySet<string>;
}

function parseAllowlist(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function loadFreshnessHoldRollout(env: Record<string, string | undefined>): FreshnessHoldRolloutPolicy {
  return {
    enabled: env.CAT_CAFE_FRESHNESS_HOLD_ENABLED === 'true',
    cats: parseAllowlist(env.CAT_CAFE_FRESHNESS_HOLD_CATS),
    threads: parseAllowlist(env.CAT_CAFE_FRESHNESS_HOLD_THREADS),
  };
}

export function isFreshnessHoldEnabledFor(
  policy: FreshnessHoldRolloutPolicy,
  threadId: string,
  catId: string,
): boolean {
  if (!policy.enabled) return false;
  if (policy.cats.size > 0 && !policy.cats.has(catId)) return false;
  if (policy.threads.size > 0 && !policy.threads.has(threadId)) return false;
  return true;
}
