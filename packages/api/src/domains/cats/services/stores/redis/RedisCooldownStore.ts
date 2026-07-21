/**
 * Redis Cooldown Store
 * 理智线 T6（task #388）：per-cat 配额冷却结构化状态，重启不丢（Redis 持久，非内存 Map）。
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 */

import type { CatId, CooldownInput, CooldownRecord } from '@cat-cafe/shared';
import { truncateCooldownOriginalError } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ICooldownStore } from '../ports/CooldownStore.js';
import { CooldownKeys } from '../redis-keys/cooldown-keys.js';

const DEFAULT_BUFFER_SECONDS = 5 * 60;

/**
 * Atomic max-merge write: `until` never regresses even under a concurrent write
 * with an older/shorter expiry. Returns the final `until` used.
 * KEYS[1] = cooldown:{catId} hash, KEYS[2] = cooldowns:active set
 * ARGV[1]=catId ARGV[2]=until ARGV[3]=reason ARGV[4]=source ARGV[5]=detectedAt
 * ARGV[6]=originalError ARGV[7]=ttlSeconds
 */
const SET_MAX_UNTIL_LUA = `
local existingUntil = tonumber(redis.call('HGET', KEYS[1], 'until'))
local newUntil = tonumber(ARGV[2])
if existingUntil and existingUntil > newUntil then
  newUntil = existingUntil
end
redis.call('HSET', KEYS[1], 'catId', ARGV[1], 'until', tostring(newUntil), 'reason', ARGV[3], 'source', ARGV[4], 'detectedAt', ARGV[5], 'originalError', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('SADD', KEYS[2], ARGV[1])
return tostring(newUntil)
`;

export class RedisCooldownStore implements ICooldownStore {
  private readonly redis: RedisClient;
  private readonly bufferSeconds: number;

  constructor(redis: RedisClient, options?: { bufferSeconds?: number }) {
    this.redis = redis;
    this.bufferSeconds = options?.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
  }

  async set(input: CooldownInput): Promise<CooldownRecord> {
    const detectedAt = input.detectedAt ?? Date.now();
    const originalError = truncateCooldownOriginalError(input.originalError);
    const key = CooldownKeys.detail(input.catId);
    const ttlSeconds = Math.max(1, Math.ceil((input.until - Date.now()) / 1000) + this.bufferSeconds);

    const finalUntilRaw = (await this.redis.eval(
      SET_MAX_UNTIL_LUA,
      2,
      key,
      CooldownKeys.ACTIVE,
      input.catId,
      String(input.until),
      input.reason,
      input.source,
      String(detectedAt),
      originalError,
      String(ttlSeconds),
    )) as string;

    return {
      catId: input.catId,
      until: Number(finalUntilRaw),
      reason: input.reason,
      source: input.source,
      detectedAt,
      originalError,
    };
  }

  async get(catId: CatId): Promise<CooldownRecord | null> {
    const data = await this.redis.hgetall(CooldownKeys.detail(catId));
    if (!data || !data.catId) return null;
    return this.hydrateRecord(data);
  }

  async clear(catId: CatId): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.del(CooldownKeys.detail(catId));
    pipeline.srem(CooldownKeys.ACTIVE, catId);
    await pipeline.exec();
  }

  async listActive(): Promise<CooldownRecord[]> {
    const catIds = await this.redis.smembers(CooldownKeys.ACTIVE);
    if (catIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const catId of catIds) pipeline.hgetall(CooldownKeys.detail(catId));
    const results = await pipeline.exec();
    if (!results) return [];

    const records: CooldownRecord[] = [];
    const staleCatIds: string[] = [];
    for (let i = 0; i < catIds.length; i++) {
      const entry = results[i];
      const err = entry?.[0];
      const data = entry?.[1] as Record<string, string> | undefined;
      if (err || !data || !data.catId) {
        staleCatIds.push(catIds[i]!);
        continue;
      }
      records.push(this.hydrateRecord(data));
    }
    if (staleCatIds.length > 0) {
      await this.redis.srem(CooldownKeys.ACTIVE, ...staleCatIds);
    }
    return records;
  }

  private hydrateRecord(data: Record<string, string>): CooldownRecord {
    return {
      catId: data.catId as CatId,
      until: Number(data.until),
      reason: data.reason as CooldownRecord['reason'],
      source: data.source ?? '',
      detectedAt: Number(data.detectedAt),
      originalError: data.originalError ?? '',
    };
  }
}
