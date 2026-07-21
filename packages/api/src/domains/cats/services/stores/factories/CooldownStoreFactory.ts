/**
 * CooldownStore Factory
 * 理智线 T6 (task #388): Redis available → RedisCooldownStore (restart-safe), otherwise in-memory.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { CooldownStore } from '../ports/CooldownStore.js';
import { RedisCooldownStore } from '../redis/RedisCooldownStore.js';

export type AnyCooldownStore = CooldownStore | RedisCooldownStore;

export function createCooldownStore(redis?: RedisClient): AnyCooldownStore {
  if (redis) {
    return new RedisCooldownStore(redis);
  }
  return new CooldownStore();
}
