/**
 * Session Chain Types
 * F24: Thread → N Sessions per cat, with context health tracking.
 *
 * Session lifecycle: active → sealing → sealed
 * - active: currently in use (one per cat per thread)
 * - sealing: writing transcript + generating digest (Phase B)
 * - sealed: immutable snapshot, readable by sub-agents (Phase C+)
 */

import type { CatId } from './ids.js';

export type SessionStatus = 'active' | 'sealing' | 'sealed';

export interface SessionRecord {
  readonly id: string;
  /** CLI-reported session ID (from session_init event) */
  cliSessionId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly userId: string;
  /** Chain sequence number (0-based) */
  readonly seq: number;
  status: SessionStatus;
  /** Latest context health snapshot after last invocation */
  contextHealth?: ContextHealth;
  /**
   * 理智线 T3（task #385）：绿黄红理智线档位，跟 contextHealth 是两个不同的度量
   * （分母是 sanityLine 不是 windowTokens）。用于跨轮判断是否跨档发事件。
   */
  sanityState?: 'green' | 'yellow' | 'red';
  /**
   * 理智线 T4（task #386）：黄/红区触发的 9 字段轻交接包。**独立字段，不复用
   * continuityCapsule**——那个字段是 A2A 路由续接状态（ballState/mode/chainIndex），
   * 在正常 A2A 链路调用中会被写入；塞进同一个字段会跟 A2A 状态互相覆盖。
   */
  sanityHandoff?: SanityHandoffCapsuleV1;
  /** Latest token usage snapshot (persisted for frontend display after reload) */
  lastUsage?: SessionUsageSnapshot;
  messageCount: number;
  /** Seal reason (Phase B) */
  sealReason?: 'threshold' | 'manual' | 'error' | (string & {});
  /** F33: Number of CLI compressions in this session (hybrid strategy) */
  compressionCount?: number;
  /** Structured collaboration control-flow state used across compact/seal/resume boundaries. */
  continuityCapsule?: unknown;
  /** F118 AC-C6: Consecutive restore failures for overflow circuit breaker */
  consecutiveRestoreFailures?: number;
  readonly createdAt: number;
  updatedAt: number;
  sealedAt?: number;
}

/**
 * 理智线 T4（task #386）：黄/红区自动轻交接包，9 个字段（cy 定死）。
 * V0 全部字段走规则化消息内容抽取（跟 AutoSummarizer 同技法，零 LLM 调用）；
 * `goal` 特别标 `goalIsInferred: true`——它是从近期消息推断的近似值，不是精确
 * task 标题（精确关联需要 ITaskStore 反查方法，本批不做，见 follow-up）。
 * 缺源字段显式标"未明确"，不留空字符串。
 */
export interface SanityHandoffCapsuleV1 {
  readonly v: 1;
  readonly threadId: string;
  readonly catId: CatId;
  /** 触发这次生成的理智线档位（黄区首次生成 / 红区更新）。 */
  readonly triggerState: 'yellow' | 'red';
  readonly goal: string;
  /** true = goal 是消息内容推断的近似值，不是精确 task 标题（V0 恒为 true）。 */
  readonly goalIsInferred: true;
  readonly background: string;
  readonly constraints: string;
  readonly completed: string;
  readonly verified: string;
  readonly abandonedApproaches: string;
  readonly openIssues: string;
  readonly nextSteps: string;
  readonly mustReadFiles: string;
  readonly generatedAt: number;
}

/** Slim usage snapshot persisted per session (subset of full TokenUsage). */
export interface SessionUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface ContextHealth {
  /** Current used tokens (= inputTokens from last invocation) */
  usedTokens: number;
  /** Total context window capacity */
  windowTokens: number;
  /** usedTokens / windowTokens (0.0 ~ 1.0) */
  fillRatio: number;
  /** exact = CLI reported; approx = hardcoded fallback */
  source: 'exact' | 'approx';
  measuredAt: number;
}

export interface ContextHealthConfig {
  /** Warning threshold — frontend shows yellow */
  warnThreshold: number;
  /** Seal threshold — triggers auto-seal (Phase B) */
  sealThreshold: number;
  /** Extra budget per turn (tokens) to prevent single-turn overflow */
  turnBudget?: number;
  /** Safety margin above turnBudget (tokens) */
  safetyMargin?: number;
}

export interface SealResult {
  /** Whether the seal request was accepted */
  accepted: boolean;
  /** Current status after the attempt */
  status: SessionStatus;
  /** Session ID that was sealed (if accepted) */
  sessionId?: string;
}

// ── F33: Session Strategy Configurability ──

/** Session lifecycle strategy type */
export type SessionStrategy = 'handoff' | 'compress' | 'hybrid';

/** Per-cat session lifecycle strategy configuration */
export interface SessionStrategyConfig {
  /** Strategy type */
  strategy: SessionStrategy;
  /** Context health thresholds */
  thresholds: {
    /** Frontend warning (yellow) fillRatio */
    warn: number;
    /** Trigger strategy action fillRatio */
    action: number;
  };
  /** handoff strategy parameters */
  handoff?: {
    /** Attempt MEMORY.md dump before seal */
    preSealMemoryDump: boolean;
    /** Bootstrap injection depth */
    bootstrapDepth: 'extractive' | 'generative';
  };
  /** compress strategy parameters */
  compress?: {
    /** Max compressions (unlimited for compress; effective for hybrid) */
    maxCompressions?: number;
    /** Track context_health after compression */
    trackPostCompression: boolean;
  };
  /** hybrid-specific parameters (Phase 1: hook-capable providers only) */
  hybrid?: {
    /** Switch to handoff after N compressions */
    maxCompressions: number;
  };
  /** Per-turn token budget */
  turnBudget?: number;
  /** Safety margin above turnBudget */
  safetyMargin?: number;
}

/** Seal reason for strategy-driven actions */
export type SealReason = 'threshold' | 'budget_exhausted' | 'max_compressions' | 'manual' | 'error' | (string & {});

/** Strategy action returned by shouldTakeAction() */
export type StrategyAction =
  | { type: 'none' }
  | { type: 'warn' }
  | { type: 'seal'; reason: SealReason }
  | { type: 'allow_compress' }
  | { type: 'seal_after_compress'; reason: SealReason };
