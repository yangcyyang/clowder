/**
 * Redis key patterns for the CooldownStore (理智线 T6, task #388).
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const CooldownKeys = {
  /** Hash with cooldown details: cooldown:{catId} */
  detail: (catId: string) => `cooldown:${catId}`,
  /** Set of catIds with a tracked cooldown entry (may include stale/expired ones the sweep hasn't cleared). */
  ACTIVE: 'cooldowns:active',
} as const;
