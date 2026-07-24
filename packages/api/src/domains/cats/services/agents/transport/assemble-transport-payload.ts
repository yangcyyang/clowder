/**
 * ADR-024 D2: single transport seam.
 *
 * `assembleTransportPayload` is the ONE place the four slots are packaged. Each
 * provider adapter maps `TransportPayload` → its own CLI contract:
 *   - Claude 系（Claude/Pi/CatAgent）：`system → 独立 system 通道`；body 内容严格
 *     history → meta → userMsg（不重新 join，直接用 seam 已渲染的 `prompt`）
 *   - Kimi / Codex / Grok / Gemini / OpenCode / Dare / A2A / Antigravity / ACP：
 *     单 blob，无稳定 system 通道，system → history → meta → userMsg 顺序拼接
 *     （Antigravity/ACP 无稳定注入通道，按 ADR 明文降级为整体预拼，顺序不变）
 *
 * ADR 落地设计项 2（不变量）：`TransportPayload` 保留 system/history/meta/userMsg 四个
 * **独立字段**，禁止在 seam 层预 join 成字符串——否则 "adapter 只做映射" 的契约立不住。
 * 本文件只提供一个 rendering 辅助（`renderTransportPromptBody`）给 adapter/兼容通道调用，
 * seam 本身不 join。
 */

import type { ClientId } from '@cat-cafe/shared';

/** The four independent transport slots (ADR-024 D2). Never pre-joined into one string. */
export interface TransportPayload {
  /** Frozen static prefix → provider system channel (Claude: --append-system-prompt). */
  readonly system: string;
  /** Cacheable history prefix (bootstrap + conversation + session-stable instructions). */
  readonly history: string;
  /** Per-turn volatile META block (recomputed every turn, never persisted — D3). */
  readonly meta: string;
  /** Current user / A2A trigger message (tail). */
  readonly userMsg: string;
}

export interface TransportSlots {
  readonly system: string;
  readonly history: string;
  readonly meta: string;
  readonly userMsg: string;
}

/**
 * Separator between blocks inside the `-p` body. Matches the legacy route join
 * (`\n\n---\n\n`) so v1↔v2 byte deltas are limited to slot ordering, not glue.
 */
export const SLOT_SEPARATOR = '\n\n---\n\n';

/**
 * Package the four slots. Deliberately trivial: it keeps the four fields
 * independent and does NOT concatenate them (ADR 落地设计项 2). Normalization is
 * limited to coercing undefined → '' so downstream adapters can rely on strings.
 */
export function assembleTransportPayload(slots: TransportSlots): TransportPayload {
  return {
    system: slots.system ?? '',
    history: slots.history ?? '',
    meta: slots.meta ?? '',
    userMsg: slots.userMsg ?? '',
  };
}

/**
 * Render the `-p` body for adapters/compat channels: strictly history → meta →
 * userMsg (meta 不得在 userMsg 之后). The `system` slot is intentionally excluded —
 * it belongs in the provider's system channel, not the `-p` body.
 *
 * Empty slots are dropped so ordering never introduces stray separators.
 */
export function renderTransportPromptBody(payload: TransportPayload): string {
  return [payload.history, payload.meta, payload.userMsg].filter((s) => s && s.length > 0).join(SLOT_SEPARATOR);
}

/**
 * ADR-024 W2-E: explicit allowlist of clientIds whose provider adapter has been
 * verified to map the four transport slots onto its own CLI/API contract (see
 * W2-E report for the per-provider mapping table). Deliberately an allowlist,
 * not "every ClientId" — grown one adapter at a time as each is wired + tested
 * (宁缺毋滥), so an unverified future clientId fails closed to the v1 prepend
 * path instead of silently getting an unaudited transportPayload.
 */
export const TRANSPORT_SEAM_CLIENT_IDS: ReadonlySet<ClientId> = new Set<ClientId>([
  'anthropic', // W1-B: system → --append-system-prompt; body → prompt (history→meta→userMsg)
  'kimi', // W2-E: single blob, system→history→meta→userMsg (buildKimiPrompt)
  'openai', // W2-E (Codex): single blob prepend, no system flag
  'grok', // W2-E: single blob prepend via -p
  'google', // W2-E (Gemini CLI + GeminiAcpAdapter): single blob prepend
  'pi', // W2-E: system → --append-system-prompt; body → prompt
  'opencode', // W2-E: single blob prepend (no prior system support)
  'dare', // W2-E: single blob prepend via --task (no prior system support)
  'a2a', // W2-E: single blob prepend into JSON-RPC text part (no prior system support)
  'catagent', // W2-E: system → body.system (Anthropic Messages API field)
  'antigravity', // W2-E: 降级 — no stable injection channel (LS prompt), single blob prepend
]);

/** Whether `clientId`'s adapter has been wired to the ADR-024 four-slot transport seam. */
export function supportsTransportSeam(clientId: ClientId | undefined): boolean {
  return !!clientId && TRANSPORT_SEAM_CLIENT_IDS.has(clientId);
}
