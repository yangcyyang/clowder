/**
 * B1 (2026-07-23 optimization report / task #405): 理智线红区空转修复。
 *
 * 根因（读码独立核实，见 gate 报告）：每次 sanity_critical 强制封存后，新起的
 * SessionRecord 的 `sanityState` 字段从不在 create() 时初始化——只在 patch() 里被写入
 * （SessionChainStore.ts:176）。所以 computeSanityTransition 里 `previousState ?? 'green'`
 * 总是把新 session 的第一轮当成"从绿色开始"，哪怕本轮 usedTokens/sanityLine 依然
 * ≥ 0.95（固定注入开销大，新 session 首轮很容易复现）——于是 green→red 事件立刻再发一次，
 * 直接再触发一次强制封存。没有任何跨 session 的记忆挡住这个循环。
 *
 * 这个 store 只做一件事：给 (catId, threadId) 组合加一个纯内存冷却窗口，在刚发生过一次
 * 强制封存之后的一段时间内，跳过下一次强制封存（自然降级到 F33 自己的 shouldTakeAction，
 * 跟 kill-switch 关闭时同一条降级路径，不是"裸奔"）。
 *
 * 特意不复用 T6 的 CooldownStore（配额冷却）：那个是纯 catId 维度（"这只猫全局别派活"），
 * 语义是"猫整体限流"；这里是"这只猫在这个 thread 刚被理智线封过"，粒度必须是
 * catId+threadId 组合，否则会错误冻结猫在其他 thread 的正常工作。
 *
 * 纯内存、不接 Redis：冷却只是防抖，不是安全语义——进程重启清零最坏结果是"少防一次抖"，
 * 不会导致不安全状态，比照 T6 上 Redis 的必要性低得多，先简单做。
 */

export const DEFAULT_SANITY_SEAL_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

function parseCooldownMsEnv(value: string | undefined): number {
  // `Number('')` and `Number('   ')` both evaluate to `0` in JS — an unset/blank env value must
  // fall back to the default, not silently disable the cooldown (found in review). Only an
  // explicit, normalized "0" means "off".
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_SANITY_SEAL_COOLDOWN_MS;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SANITY_SEAL_COOLDOWN_MS;
}

/** CAT_CAFE_SANITY_SEAL_COOLDOWN_MS: 缺省或非法值回落默认 20 分钟；显式 `0` = 关闭冷却（回滚杆）。 */
export function getSanitySealCooldownMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseCooldownMsEnv(env.CAT_CAFE_SANITY_SEAL_COOLDOWN_MS);
}

function cooldownKey(catId: string, threadId: string): string {
  // A source-level escape (not a raw byte) — keeps the file plain text/git-diffable while still
  // giving an unambiguous separator at runtime, regardless of what characters catId/threadId
  // might ever contain (unlike a printable separator such as ':', which would assume neither ID
  // ever contains one — a NUL byte cannot legitimately appear in either).
  return `${catId}\u0000${threadId}`;
}

export interface SanitySealCooldownCheck {
  readonly cooling: boolean;
  readonly remainingMs: number;
}

export class SanitySealCooldownStore {
  private readonly untilByKey = new Map<string, number>();

  private prune(now: number): void {
    for (const [key, until] of this.untilByKey) {
      if (until <= now) this.untilByKey.delete(key);
    }
  }

  /** Check whether (catId, threadId) is currently within a post-seal cooldown window. */
  check(catId: string, threadId: string, now: number = Date.now()): SanitySealCooldownCheck {
    this.prune(now);
    const until = this.untilByKey.get(cooldownKey(catId, threadId));
    if (until === undefined || until <= now) {
      return { cooling: false, remainingMs: 0 };
    }
    return { cooling: true, remainingMs: until - now };
  }

  /**
   * Record that a forced seal just fired for (catId, threadId), starting a cooldown window.
   * `cooldownMs <= 0` (explicit env `0`) means cooldown is disabled — no record is written,
   * so `check()` always reports not-cooling (today's pre-fix behavior, a rollback lever).
   */
  recordSeal(catId: string, threadId: string, cooldownMs: number, now: number = Date.now()): void {
    this.prune(now);
    if (cooldownMs <= 0) return;
    this.untilByKey.set(cooldownKey(catId, threadId), now + cooldownMs);
  }
}
