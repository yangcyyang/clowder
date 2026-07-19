/** Rollout-aware factory for the capability receipt v1 store. */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ICapabilityReceiptStore } from '../ports/CapabilityReceiptStore.js';
import { CapabilityReceiptStore } from '../ports/CapabilityReceiptStore.js';
import { RedisCapabilityReceiptStore } from '../redis/RedisCapabilityReceiptStore.js';

export type CapabilityReceiptMode = 'off' | 'observe' | 'enforce';

export interface CapabilityReceiptStoreFactoryOptions {
  mode: CapabilityReceiptMode;
  redis?: RedisClient;
  now?: () => number;
  physicalGraceMs?: number;
}

export function resolveCapabilityReceiptMode(raw: string | undefined): CapabilityReceiptMode {
  if (raw === undefined || raw === '') return 'off';
  if (raw === 'off' || raw === 'observe' || raw === 'enforce') return raw;
  throw new Error(`Invalid capability receipt mode: ${raw}`);
}

/**
 * Observe may fall back to process-local memory because it cannot authorize a
 * real execution. Enforce deliberately refuses that fallback.
 */
export function createCapabilityReceiptStore(
  options: CapabilityReceiptStoreFactoryOptions,
): ICapabilityReceiptStore | undefined {
  if (options.mode === 'off') return undefined;

  if (options.redis) {
    return new RedisCapabilityReceiptStore(options.redis, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.physicalGraceMs !== undefined
        ? { physicalGraceMs: options.physicalGraceMs }
        : {}),
    });
  }

  if (options.mode === 'enforce') {
    throw new Error('Capability receipt enforce mode requires Redis');
  }

  return new CapabilityReceiptStore(options.now ? { now: options.now } : undefined);
}
