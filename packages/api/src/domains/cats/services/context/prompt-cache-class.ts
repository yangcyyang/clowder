/**
 * ADR-024 D5: cache-boundary type convention (`cacheClass`).
 *
 * Every prompt section declares a cache class so the transport layer knows which
 * slot it may live in. This module establishes the TYPES and the initial section
 * registry (W1-B). CI enforcement ("every new section must be classified") is
 * deferred to W2-D — this is the scaffolding it will build on.
 *
 *   | cacheClass      | 语义                                   | 位置规则                          |
 *   |-----------------|----------------------------------------|-----------------------------------|
 *   | `static`        | session 内不写的冻结段                 | system prompt                     |
 *   | `volatile`      | session 内会写（任何频率）             | **禁止进 system**，只进队尾 meta  |
 *   | `deterministic` | 仅由已投递消息决定、同状态同字节       | 可留在 history 段（append-only）  |
 *
 * (ADR-024 v2 说明：v1 的 `epoch` 类取消——"低频"不是免死牌，session 内会写就下放。)
 */

/** The three cache classes from ADR-024 D5. */
export type CacheClass = 'static' | 'volatile' | 'deterministic';

/** The four transport slots from ADR-024 D2. */
export type TransportSlot = 'system' | 'history' | 'meta' | 'userMsg';

/**
 * Allowed slot for each cache class (ADR-024 D5 position rules).
 * `volatile` is hard-banned from `system`.
 */
export const CACHE_CLASS_ALLOWED_SLOTS: Record<CacheClass, readonly TransportSlot[]> = {
  static: ['system'],
  // deterministic content lives in the cacheable history prefix (append-only)
  deterministic: ['history'],
  // volatile content is recomputed every turn and must sit AFTER the cacheable
  // prefix (never in system, never in history). D5 hard rule: 禁止进 system.
  // The non-cacheable tail is the META block and the current user message.
  volatile: ['meta', 'userMsg'],
};

export interface PromptSectionMeta {
  /** Stable identifier for the section. */
  readonly id: string;
  /** Cache class — determines which slot it may occupy. */
  readonly cacheClass: CacheClass;
  /** The slot this section is assigned to in the v2 layout. */
  readonly slot: TransportSlot;
  /** Short human description. */
  readonly description: string;
}

/**
 * Registry of prompt sections with their cacheClass + slot assignment.
 *
 * This is the W1-B baseline. W2-C/W2-D extend it (transport-layer evidence /
 * coverageMap / anchors, persistence-exclusion invariants) and wire CI so every
 * newly-added section must appear here with a valid class→slot mapping.
 */
export const PROMPT_SECTION_REGISTRY: readonly PromptSectionMeta[] = [
  // --- STATIC SYSTEM (frozen, session-stable) ---
  {
    id: 'static-identity',
    cacheClass: 'static',
    slot: 'system',
    description: '角色/家规/名册/治理摘要/reviewer/session-sanity（session 内逐字节稳定）',
  },
  {
    id: 'f042-identity-line',
    cacheClass: 'static',
    slot: 'system',
    description: 'F042 身份行（catId/model，config 级稳定）——D1 明文例外，钉在 system',
  },
  // --- META (per-turn / session-writable volatile) ---
  {
    id: 'turn-meta',
    cacheClass: 'volatile',
    slot: 'meta',
    description:
      'A2A 来源/乒乓球警告/当前模式/Task Gate/Skill Router 命中/contextUsageWarning/voiceMode/bootcamp/guide/world/signals',
  },
  {
    id: 'cross-session-memory',
    cacheClass: 'volatile',
    slot: 'meta',
    description: '跨 Session 记忆摘要（工作单元完成即回写，session 内会写）→ D1 下放 meta',
  },
  {
    id: 'lessons-context',
    cacheClass: 'volatile',
    slot: 'meta',
    description: '公共踩坑记录 LESSONS.md（低优先级，session 内可写）→ D1 下放 meta',
  },
  {
    id: 'project-context',
    cacheClass: 'volatile',
    slot: 'meta',
    description: '项目事实源四件套 + shouldInjectProjectContext 条件产物 → D1 下放 meta',
  },
  {
    id: 'user-profile',
    cacheClass: 'volatile',
    slot: 'meta',
    description:
      '批次 2-D 共享铲屎官画像 (.cat-cafe/memory/USER.md，偏好/硬约束/账号级事实)，全猫可见，仅 v2 meta 槽注入',
  },
  {
    id: 'agent-status-bar',
    cacheClass: 'volatile',
    slot: 'meta',
    description: 'ADR-024 §2.6 [Agent Status] 统一状态栏（时间/模式/上下文水位/任务门/收件箱），META 头之后首渲染',
  },
  // --- W2-C: transport (B层) 产物治理（D4）— route-helpers.ts:3256-3264 assembleSmartWindowContext ---
  {
    id: 'evidence-recall',
    cacheClass: 'volatile',
    slot: 'meta',
    description:
      'recallEvidence 每轮 hybrid 检索（evidenceStore.search + timeout race）——非确定性，D4 明文 → meta',
  },
  {
    id: 'coverage-map',
    cacheClass: 'volatile',
    slot: 'meta',
    description:
      'buildCoverageMap：本体（omitted/burst/anchorIds/threadMemory）确定性，但 retrievalHints 字段直接引用 ' +
      'evidenceLines（每轮 hybrid 检索结果），非确定性经 JSON.stringify 传染全体 → 判定 meta（W2-C 核查）',
  },
  {
    id: 'thread-memory',
    cacheClass: 'deterministic',
    slot: 'history',
    description:
      'threadStore.getThreadMemory 读取：仅由已封存 session 的存储状态决定，格式化无时间戳/随机排序 → ' +
      '同状态同字节，append-only（W2-C 核查；写入时机属 SessionSealer/W2-D 范围，不在本次改动内）',
  },
  {
    id: 'context-anchors',
    cacheClass: 'deterministic',
    slot: 'history',
    description:
      'selectAnchors：纯函数评分 + 稳定排序（V8 Array.sort 自 ES2019 起稳定），queryTerms 来自已投递消息 → ' +
      '同状态同字节（W2-C 核查）',
  },
  {
    id: 'context-tombstone',
    cacheClass: 'deterministic',
    slot: 'history',
    description:
      'buildTombstone：词频统计 + 消息自带 timestamp（非 Date.now()），无随机排序 → 同状态同字节（W2-C 核查）',
  },
  {
    id: 'navigation-header',
    cacheClass: 'volatile',
    slot: 'meta',
    description: 'formatNavigationHeader（传球/活跃毛线球/最近产物/真相源）→ D4 明文 meta（route-helpers.ts:2656）',
  },
  {
    id: 'agent-inbox-snapshot',
    cacheClass: 'volatile',
    slot: 'meta',
    description: 'formatAgentIntentSnapshot [Agent Inbox Snapshot] → D4 明文 meta（route-helpers.ts:1663）',
  },
  // --- HISTORY (deterministic / stable-within-session prefix) ---
  {
    id: 'session-bootstrap',
    cacheClass: 'deterministic',
    slot: 'history',
    description: 'Session #2+ bootstrap 续接摘要（由已封存 session 决定，session 内稳定）',
  },
  {
    id: 'conversation-history',
    cacheClass: 'deterministic',
    slot: 'history',
    description: '对话历史 burst（真历史，append-only 稳定前缀）',
  },
  // --- CURRENT MSG ---
  {
    id: 'current-user-message',
    cacheClass: 'volatile',
    slot: 'userMsg',
    description: '当前用户/派工消息（每轮不同，位于队尾）',
  },
];

/** True if a section's cacheClass is allowed to occupy the given slot. */
export function isSlotAllowedForCacheClass(cacheClass: CacheClass, slot: TransportSlot): boolean {
  return CACHE_CLASS_ALLOWED_SLOTS[cacheClass].includes(slot);
}

/**
 * Validate every registered section against the class→slot rules.
 * Returns the list of violations (empty = clean). Used by tests now; W2-D wires CI.
 */
export function findCacheClassViolations(
  registry: readonly PromptSectionMeta[] = PROMPT_SECTION_REGISTRY,
): { id: string; cacheClass: CacheClass; slot: TransportSlot }[] {
  return registry
    .filter((s) => !isSlotAllowedForCacheClass(s.cacheClass, s.slot))
    .map((s) => ({ id: s.id, cacheClass: s.cacheClass, slot: s.slot }));
}
