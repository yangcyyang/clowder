import type { CatId } from '@cat-cafe/shared';

export const PENDING_MENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function buildA2AIdempotencyKey(input: {
  triggerMessageId: string;
  callerCatId?: CatId | string;
  targetCatId: CatId | string;
}): string {
  const caller = input.callerCatId || 'unknown';
  return `a2a:${input.triggerMessageId}:${caller}:${input.targetCatId}`;
}
