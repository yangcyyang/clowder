/** Redis available → persistent store; otherwise use the in-memory implementation. */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FreshnessHoldStoreOptions, IFreshnessHoldStore } from '../ports/FreshnessHoldStore.js';
import { FreshnessHoldStore } from '../ports/FreshnessHoldStore.js';
import { RedisFreshnessHoldStore } from '../redis/RedisFreshnessHoldStore.js';

export function createFreshnessHoldStore(
  redis?: RedisClient,
  options?: FreshnessHoldStoreOptions,
): IFreshnessHoldStore {
  return redis ? new RedisFreshnessHoldStore(redis, options) : new FreshnessHoldStore(options);
}
