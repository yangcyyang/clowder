/**
 * Follow Store Factory (batch 3-D)
 * REDIS_URL 有值 → RedisFollowStore
 * 无 → undefined (follow/Activity requires Redis, same convention as ReadStateStoreFactory)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IFollowStore } from '../ports/FollowStore.js';
import { RedisFollowStore } from '../redis/RedisFollowStore.js';

export function createFollowStore(redis?: RedisClient): IFollowStore | undefined {
  if (!redis) return undefined;
  return new RedisFollowStore(redis);
}
