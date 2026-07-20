/**
 * 理智线 T3（task #385）：会话理智线绿黄红状态机。
 *
 * 纯函数核心，不碰任何 store/IO——薄接线在 invoke-single-cat.ts（挂在 ContextHealth 计算
 * 旁边，复用同一个已算出的 usedTokens，不重新估算）。
 *
 * 跟 F24/F33 既有的 ContextHealth/shouldTakeAction（session-strategy.ts）是两件不同的事，
 * 不是重复造轮子：
 * - F33 的 fillRatio 分母是 windowTokens——模型真实技术上限（Opus4.8/Sonnet5 实测常态
 *   接近官方 1M 窗口），防的是硬性溢出/账单爆炸。
 * - 这里的分母是 sanityLine——理智线死线（同一批模型只有 200K），防的是"窗口远没满但已经
 *   开始不稳定干活"的软性质量衰减。两个阈值差一个数量级，触发时机完全不同，各自服务不同目的。
 *
 * 口径（provisional，随 commit 报 gate 确认）：分子沿用 ContextHealth 已经算好的
 * usedTokens（本轮注入总量口径：lastTurnInputTokens 优先，含历史注入+工具结果——工具结果
 * 本来就进上下文，漏算会低估真实压力；跟票H v2 缓存测量同字段同数据源，不搞第二把尺）。
 */

export type SanityState = 'green' | 'yellow' | 'red';

export interface SanityThresholds {
  readonly yellowRatio: number;
  readonly redRatio: number;
}

export const DEFAULT_SANITY_THRESHOLDS: SanityThresholds = {
  yellowRatio: 0.7,
  redRatio: 0.95,
};

function parseRatioEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

/** CAT_CAFE_SANITY_YELLOW_RATIO / CAT_CAFE_SANITY_RED_RATIO，缺省或非法值回落默认。 */
export function getSanityThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): SanityThresholds {
  return {
    yellowRatio: parseRatioEnv(env.CAT_CAFE_SANITY_YELLOW_RATIO, DEFAULT_SANITY_THRESHOLDS.yellowRatio),
    redRatio: parseRatioEnv(env.CAT_CAFE_SANITY_RED_RATIO, DEFAULT_SANITY_THRESHOLDS.redRatio),
  };
}

export function classifySanityState(
  usedTokens: number,
  sanityLine: number,
  thresholds: SanityThresholds = DEFAULT_SANITY_THRESHOLDS,
): SanityState {
  if (!(sanityLine > 0) || !(usedTokens >= 0)) return 'green';
  const ratio = usedTokens / sanityLine;
  if (ratio >= thresholds.redRatio) return 'red';
  if (ratio >= thresholds.yellowRatio) return 'yellow';
  return 'green';
}

export interface SanityTransitionEvent {
  readonly from: SanityState;
  readonly to: SanityState;
  readonly ratio: number;
}

export interface SanityTransitionResult {
  readonly state: SanityState;
  /** null when this turn stayed in the same tier as before (no event should be emitted). */
  readonly event: SanityTransitionEvent | null;
}

/**
 * 分类 + 跨档判定。缺失历史状态（新 session 第一轮）视为 green 基线——只有第一轮就已经
 * 是 yellow/red 才会发事件，纯粹的 green→green 不发，防止每轮同档刷屏。
 */
export function computeSanityTransition(
  previousState: SanityState | undefined,
  usedTokens: number,
  sanityLine: number,
  thresholds: SanityThresholds = DEFAULT_SANITY_THRESHOLDS,
): SanityTransitionResult {
  const state = classifySanityState(usedTokens, sanityLine, thresholds);
  const effectivePrevious = previousState ?? 'green';
  const ratio = sanityLine > 0 ? usedTokens / sanityLine : 0;
  if (effectivePrevious === state) {
    return { state, event: null };
  }
  return { state, event: { from: effectivePrevious, to: state, ratio } };
}
