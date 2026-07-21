/**
 * Cooldown Store
 * 理智线 T6（task #388）：per-cat 配额冷却结构化状态。
 *
 * 一个 catId 同一时刻最多一条冷却记录（覆盖式，不是队列）。再次探测到冷却时
 * `until` 取 max(现有, 新解析值)——不能被一条"未知恢复时间"的探测把已知的更长
 * 冷却时钟缩短。
 */

import type { CatId, CooldownInput, CooldownRecord } from '@cat-cafe/shared';
import { truncateCooldownOriginalError } from '@cat-cafe/shared';

export interface ICooldownStore {
  /** Set/refresh a cat's cooldown. `until` is max(existing active until, input.until). */
  set(input: CooldownInput): CooldownRecord | Promise<CooldownRecord>;
  get(catId: CatId): CooldownRecord | null | Promise<CooldownRecord | null>;
  clear(catId: CatId): void | Promise<void>;
  /** All currently-tracked cooldowns (may include already-past-`until` entries the sweep hasn't cleared yet). */
  listActive(): CooldownRecord[] | Promise<CooldownRecord[]>;
}

const DEFAULT_MAX = 500;

export class CooldownStore implements ICooldownStore {
  private records = new Map<string, CooldownRecord>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX;
  }

  set(input: CooldownInput): CooldownRecord {
    const existing = this.records.get(input.catId);
    const until = existing ? Math.max(existing.until, input.until) : input.until;
    const record: CooldownRecord = {
      catId: input.catId,
      until,
      reason: input.reason,
      source: input.source,
      detectedAt: input.detectedAt ?? Date.now(),
      originalError: truncateCooldownOriginalError(input.originalError),
    };
    if (!existing && this.records.size >= this.maxRecords) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) this.records.delete(oldestKey);
    }
    this.records.set(input.catId, record);
    return record;
  }

  get(catId: CatId): CooldownRecord | null {
    return this.records.get(catId) ?? null;
  }

  clear(catId: CatId): void {
    this.records.delete(catId);
  }

  listActive(): CooldownRecord[] {
    return [...this.records.values()];
  }
}
