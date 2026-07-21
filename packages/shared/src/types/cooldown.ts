/**
 * 理智线 T6（task #388）：配额冷却结构化状态。
 *
 * 一个 provider/CLI 报"额度用尽"类错误时，捕获为结构化冷却记录（含恢复时间），
 * 而不是让整链报错。`reason` 目前只有 `'usage_limit'`——只在错误被明确识别为
 * 配额/额度错误时才写冷却，未识别的错误不写（不能对"任何报错"都套冷却，见
 * RedisCooldownStore 调用点的判别条件）。
 */

import type { CatId } from './ids.js';

const ORIGINAL_ERROR_MAX_CHARS = 200;

export function truncateCooldownOriginalError(text: string): string {
  return text.length > ORIGINAL_ERROR_MAX_CHARS ? `${text.slice(0, ORIGINAL_ERROR_MAX_CHARS)}…` : text;
}

export interface CooldownRecord {
  readonly catId: CatId;
  /** Epoch ms when the cooldown ends. */
  readonly until: number;
  readonly reason: 'usage_limit' | (string & {});
  /** Which provider/CLI reported it, e.g. 'anthropic' | 'openai' | 'kimi'. */
  readonly source: string;
  readonly detectedAt: number;
  /** Truncated to ORIGINAL_ERROR_MAX_CHARS — diagnostic only, not for display parsing. */
  readonly originalError: string;
}

export interface CooldownInput {
  readonly catId: CatId;
  readonly until: number;
  readonly reason: string;
  readonly source: string;
  readonly originalError: string;
  readonly detectedAt?: number;
}
