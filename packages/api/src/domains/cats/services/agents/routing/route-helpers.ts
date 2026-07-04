/**
 * Route Helpers
 * Shared types, interfaces, and helper functions for route-serial and route-parallel.
 */

import type { CatId, ContextBudget, MessageContent, RichBlock, RichBlockBase, TaskItem, ToolPolicy } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { DEFAULT_HIERARCHICAL_CONTEXT } from '../../../../../config/hierarchical-context-config.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('context-transport');

import { estimateTokens } from '../../../../../utils/token-counter.js';
import type { IThreadHistorySummaryStore, ThreadHistorySummarySegment } from '../../../../memory/index.js';
import { formatMessage } from '../../context/ContextAssembler.js';
import { checkContextBudget, type DegradationResult } from '../../orchestration/DegradationPolicy.js';
import { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import { isDelivered, type IMessageStore, type StoredMessage, type StoredToolEvent } from '../../stores/ports/MessageStore.js';
import type { Thread } from '../../stores/ports/ThreadStore.js';
import { canViewMessage } from '../../stores/visibility.js';
import type { AgentMessage, AgentService } from '../../types.js';
import type { InvocationDeps } from '../invocation/invoke-single-cat.js';
import { extractRecentArtifacts, mergeLedger, sortAndCapArtifacts } from './artifact-tracking.js';
import type { CoverageMap } from './context-transport.js';
import {
  buildCoverageMap,
  buildTombstone,
  detectRecentBurst,
  formatAnchors,
  formatTombstone,
  recallEvidence,
  scrubToolPayloads,
  selectAnchors,
} from './context-transport.js';
import { extractBatonContext, formatNavigationHeader, summarizeActiveTasks } from './navigation-context.js';
import { rankArtifactSources } from './source-ranking.js';

/** Minimal broadcast interface — avoids coupling routing layer to SocketManager concrete class */
export interface RouteBroadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export interface RuntimeContextBudgetSnapshot {
  surface: 'thread';
  threadId: string;
  toolPolicy: ToolPolicy;
  toolPolicySource: 'agent-default' | 'user-override';
  mode: 'serial' | 'parallel';
  estimatedTokens: number;
  historyMessages: number;
  loadedBlocks: string[];
  skippedBlocks: string[];
  governanceTier: 'core' | 'operational';
  governanceEstimatedTokens: number;
  governanceSourceInjected: boolean;
  usesFullHistory: boolean;
  maxPromptTokens: number;
  maxContextTokens: number;
  historyMode?: 'observe' | 'shadow-summary' | 'summary-active';
  historyFullTokens?: number;
  historySummaryTokens?: number;
  historyBudgetRatio?: number;
  summarySegmentId?: string;
  historyGovernanceDegraded?: boolean;
}

export interface HistoryGovernanceObservation {
  historyMode: 'observe';
  historyFullTokens: number;
  historyBudgetRatio: number;
  historyGovernanceDegraded: boolean;
}

export type HistoryGovernanceMode = 'legacy' | 'observe' | 'shadow-summary' | 'summary-active';

export interface HistorySummaryObservation {
  mode: 'shadow-summary' | 'summary-active';
  tokens: number;
  segmentIds: readonly string[];
  messageCount: number;
  watermarkMessageId?: string;
}

export interface FormattedThreadHistorySummary extends HistorySummaryObservation {
  text: string;
}

export interface HistoryGovernanceThresholds {
  observeRatio: number;
  shadowRatio: number;
  activeRatio: number;
  criticalRatio: number;
  recentMessages: number;
  criticalRecentMessages: number;
}

export interface HistoryGovernanceDecision {
  mode: HistoryGovernanceMode;
  recentMessageLimit?: number;
  thresholds: HistoryGovernanceThresholds;
  reason:
    | 'disabled'
    | 'no-observation'
    | 'observe'
    | 'shadow'
    | 'active-threshold'
    | 'active-debounce'
    | 'quality-gate';
}

export type HistorySummaryQualityIssue =
  | 'empty_summary'
  | 'summary_missing_structure'
  | 'summary_overlaps_recent_window'
  | 'summary_token_bloat'
  | 'summary_contains_secret'
  | 'summary_recall_failed';

export interface HistorySummaryQualityReport {
  ok: boolean;
  issues: readonly HistorySummaryQualityIssue[];
}

export interface RuntimeContextSurfaceHint {
  isDM?: boolean | undefined;
  title?: string | null | undefined;
}

export interface ContextUsageWarning {
  ratio: number;
  estimatedTokens: number;
  maxPromptTokens: number;
  level: 'caution' | 'high' | 'critical';
  action: 'memory-writeback';
}

const CONTEXT_RATIONAL_LINE_RATIO = 0.7;
const HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS: HistoryGovernanceThresholds = {
  observeRatio: 0.6,
  shadowRatio: 0.7,
  activeRatio: 0.8,
  criticalRatio: 0.9,
  recentMessages: 24,
  criticalRecentMessages: 12,
};
const activeSummaryWatermarks = new Map<string, string>();
const SECRET_LIKE_CONTENT_RE =
  /\b(?:sk|ghp|gho|xox[abprs])-[A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/=-]{6,}|\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\b\s*[:=]\s*[^\s,;}]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const SUMMARY_SMOKE_PATTERNS = [
  /当前(?:状态|任务)|正在推进|current\s+status/i,
  /决策|约束|已确认|decision|constraint/i,
  /下一步|next\s+action/i,
  /风险|不确定|锚点|回看原文|risk|anchor/i,
];

export function getContextPressureLevel(ratio: number): 'none' | 'caution' | 'high' | 'critical' {
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.85) return 'high';
  if (ratio >= 0.7) return 'caution';
  return 'none';
}

function normalizeEnvValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isEnabledValue(value: string | undefined): boolean {
  const normalized = normalizeEnvValue(value);
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'observe' ||
    normalized === 'shadow-summary' ||
    normalized === 'summary-active'
  );
}

function isDisabledValue(value: string | undefined): boolean {
  const normalized = normalizeEnvValue(value);
  return (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === 'disabled' ||
    normalized === 'legacy'
  );
}

function getRequestedHistoryGovernanceMode(env: NodeJS.ProcessEnv): HistoryGovernanceMode {
  const normalized = normalizeEnvValue(env.CAT_CAFE_HISTORY_GOVERNANCE);
  if (normalized === 'observe' || normalized === 'shadow-summary' || normalized === 'summary-active') {
    return normalized;
  }
  if (isDisabledValue(normalized)) return 'legacy';
  if (isEnabledValue(normalized)) return 'observe';
  return 'legacy';
}

export function isHistoryGovernanceObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const requestedMode = getRequestedHistoryGovernanceMode(env);
  return isEnabledValue(env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE) || requestedMode !== 'legacy';
}

export function isHistorySummaryShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isDisabledValue(env.CAT_CAFE_HISTORY_GOVERNANCE)) return false;
  const requestedMode = getRequestedHistoryGovernanceMode(env);
  return (
    isEnabledValue(env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY) ||
    requestedMode === 'shadow-summary' ||
    requestedMode === 'summary-active'
  );
}

function readRatioEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getHistoryGovernanceThresholds(env: NodeJS.ProcessEnv = process.env): HistoryGovernanceThresholds {
  return {
    observeRatio: readRatioEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE_RATIO',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.observeRatio,
    ),
    shadowRatio: readRatioEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_SHADOW_RATIO',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.shadowRatio,
    ),
    activeRatio: readRatioEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_ACTIVE_RATIO',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.activeRatio,
    ),
    criticalRatio: readRatioEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_CRITICAL_RATIO',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.criticalRatio,
    ),
    recentMessages: readPositiveIntEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_RECENT_MESSAGES',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.recentMessages,
    ),
    criticalRecentMessages: readPositiveIntEnv(
      env,
      'CAT_CAFE_HISTORY_GOVERNANCE_CRITICAL_RECENT_MESSAGES',
      HISTORY_GOVERNANCE_DEFAULT_THRESHOLDS.criticalRecentMessages,
    ),
  };
}

function listMatches(value: string | undefined, candidate: string | undefined): boolean {
  if (!value || !candidate) return false;
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => item === '*' || item === candidate);
}

function hasConfiguredList(value: string | undefined): boolean {
  return Boolean(value?.split(/[\s,]+/).some((item) => item.trim().length > 0));
}

function isHistoryGovernanceCanaryEnabled(input: {
  threadId: string;
  catId?: string | undefined;
  env: NodeJS.ProcessEnv;
}): boolean {
  const threadList = input.env.CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS;
  const catList = input.env.CAT_CAFE_HISTORY_GOVERNANCE_CANARY_CATS;
  const hasThreadList = hasConfiguredList(threadList);
  const hasCatList = hasConfiguredList(catList);
  if (!hasThreadList && !hasCatList) return false;
  const threadAllowed = hasThreadList ? listMatches(threadList, input.threadId) : true;
  const catAllowed = hasCatList ? listMatches(catList, input.catId) : true;
  return threadAllowed && catAllowed;
}

function getSummaryWatermark(summary: HistorySummaryObservation | undefined): string | undefined {
  return summary?.watermarkMessageId ?? summary?.segmentIds.join(',');
}

function getActiveRecentMessageLimit(ratio: number, thresholds: HistoryGovernanceThresholds): number {
  return ratio >= thresholds.criticalRatio
    ? Math.min(thresholds.recentMessages, thresholds.criticalRecentMessages)
    : thresholds.recentMessages;
}

function wouldActivateSummaryIfAvailable(input: {
  threadId: string;
  catId?: string | undefined;
  historyObservation?: HistoryGovernanceObservation | undefined;
  env: NodeJS.ProcessEnv;
}): boolean {
  const thresholds = getHistoryGovernanceThresholds(input.env);
  return (
    getRequestedHistoryGovernanceMode(input.env) === 'summary-active' &&
    Boolean(input.historyObservation) &&
    isHistoryGovernanceCanaryEnabled({ threadId: input.threadId, catId: input.catId, env: input.env }) &&
    (input.historyObservation?.historyBudgetRatio ?? 0) >= thresholds.activeRatio
  );
}

export function __resetHistoryGovernanceDecisionStateForTests(): void {
  activeSummaryWatermarks.clear();
}

function clearActiveSummaryWatermark(threadId: string, catId: string | undefined): void {
  activeSummaryWatermarks.delete(`${threadId}:${catId ?? '*'}`);
}

function containsSecretLikeContent(text: string): boolean {
  return SECRET_LIKE_CONTENT_RE.test(text);
}

function modeAfterSummaryQualityFailure(
  decision: HistoryGovernanceDecision,
  historyObservation: HistoryGovernanceObservation | undefined,
): HistoryGovernanceDecision {
  if (decision.mode === 'legacy' || decision.mode === 'observe') return decision;
  return {
    mode: historyObservation ? 'observe' : 'legacy',
    thresholds: decision.thresholds,
    reason: 'quality-gate',
  };
}

export function validateThreadHistorySummaryQuality(input: {
  summary: HistorySummaryObservation | undefined;
  mode: HistoryGovernanceMode;
  historyObservation?: HistoryGovernanceObservation | undefined;
  recentMessages?: readonly StoredMessage[] | undefined;
  recentMessageLimit?: number | undefined;
}): HistorySummaryQualityReport {
  if (!input.summary || input.mode === 'legacy' || input.mode === 'observe') {
    return { ok: true, issues: [] };
  }

  const issues: HistorySummaryQualityIssue[] = [];
  const summaryText = 'text' in input.summary ? String(input.summary.text ?? '') : '';
  if (!summaryText.trim() || input.summary.messageCount <= 0) {
    issues.push('empty_summary');
  }
  if (containsSecretLikeContent(summaryText)) {
    issues.push('summary_contains_secret');
  }

  const historyFullTokens = input.historyObservation?.historyFullTokens ?? 0;
  if (historyFullTokens > 0 && input.summary.tokens >= historyFullTokens) {
    issues.push('summary_token_bloat');
  }

  if (input.mode === 'summary-active') {
    const recentLimit = Math.max(1, Math.floor(input.recentMessageLimit ?? 24));
    const recentWindow = input.recentMessages?.slice(-recentLimit) ?? [];
    const firstRecent = recentWindow[0];
    if (input.summary.watermarkMessageId && firstRecent && input.summary.watermarkMessageId >= firstRecent.id) {
      issues.push('summary_overlaps_recent_window');
    }
    if (!/范围|Scope:/i.test(summaryText)) {
      issues.push('summary_missing_structure');
    }
    if (!SUMMARY_SMOKE_PATTERNS.every((pattern) => pattern.test(summaryText))) {
      issues.push('summary_recall_failed');
    }
  }

  return { ok: issues.length === 0, issues };
}

export function formatHistoryRecallSmoke(): string {
  return [
    '[History Recall Smoke]',
    'Before relying on the compressed summary, verify these four facts from the current prompt:',
    '1. 你是谁？当前身份/边界是什么？',
    '2. 当前任务是什么？验收标准是什么？',
    '3. 最近一个已确认决策是什么？',
    '4. 下一步应该做什么？有什么风险？',
    'If any answer is missing or ambiguous, request the original message range instead of guessing.',
    '[/History Recall Smoke]',
  ].join('\n');
}

export function resolveHistoryGovernanceDecision(input: {
  threadId: string;
  catId?: string | undefined;
  summary?: HistorySummaryObservation | undefined;
  historyObservation?: HistoryGovernanceObservation | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  forceShadow?: boolean | undefined;
}): HistoryGovernanceDecision {
  const env = input.env ?? process.env;
  const thresholds = getHistoryGovernanceThresholds(env);
  const requestedMode = getRequestedHistoryGovernanceMode(env);
  const ratio = input.historyObservation?.historyBudgetRatio ?? 0;
  const baseMode: HistoryGovernanceMode = input.historyObservation ? 'observe' : 'legacy';
  const summaryWatermark = getSummaryWatermark(input.summary);
  const shadowRequested =
    input.forceShadow ||
    isEnabledValue(env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY) ||
    requestedMode === 'shadow-summary' ||
    requestedMode === 'summary-active';

  if (isDisabledValue(env.CAT_CAFE_HISTORY_GOVERNANCE)) {
    activeSummaryWatermarks.delete(`${input.threadId}:${input.catId ?? '*'}`);
    return { mode: 'legacy', thresholds, reason: 'disabled' };
  }

  if (!input.historyObservation && requestedMode === 'legacy' && !shadowRequested) {
    return { mode: 'legacy', thresholds, reason: 'no-observation' };
  }

  if (requestedMode === 'summary-active' && input.summary && summaryWatermark) {
    const canaryAllowed = isHistoryGovernanceCanaryEnabled({
      threadId: input.threadId,
      catId: input.catId,
      env,
    });
    const debounceKey = `${input.threadId}:${input.catId ?? '*'}`;
    const previousWatermark = activeSummaryWatermarks.get(debounceKey);
    if (previousWatermark && previousWatermark !== summaryWatermark) {
      activeSummaryWatermarks.delete(debounceKey);
    }
    if (canaryAllowed && previousWatermark === summaryWatermark) {
      return {
        mode: 'summary-active',
        recentMessageLimit: getActiveRecentMessageLimit(ratio, thresholds),
        thresholds,
        reason: 'active-debounce',
      };
    }
    if (canaryAllowed && ratio >= thresholds.activeRatio) {
      activeSummaryWatermarks.set(debounceKey, summaryWatermark);
      return {
        mode: 'summary-active',
        recentMessageLimit: getActiveRecentMessageLimit(ratio, thresholds),
        thresholds,
        reason: 'active-threshold',
      };
    }
  }

  if (
    input.summary &&
    (shadowRequested || ratio >= thresholds.shadowRatio)
  ) {
    return { mode: 'shadow-summary', thresholds, reason: 'shadow' };
  }

  if (input.historyObservation && (requestedMode === 'observe' || ratio >= thresholds.observeRatio)) {
    return { mode: 'observe', thresholds, reason: 'observe' };
  }

  return { mode: baseMode, thresholds, reason: baseMode === 'legacy' ? 'no-observation' : 'observe' };
}

export function estimateFullHistoryTokens(messages: readonly StoredMessage[] | undefined): number {
  if (!messages || messages.length === 0) return 0;
  const delivered = messages.filter(
    (m) => isDelivered(m) && m.userId !== 'system' && !(m.catId && m.content?.startsWith('[错误]')),
  );
  if (delivered.length === 0) return 0;
  const lines = delivered.map((m) => `[${m.id}] ${formatMessage(m)}`);
  return estimateTokens(`[对话历史 - 全量观测 ${lines.length} 条]\n${lines.join('\n')}\n[/对话历史]`);
}

export function buildHistoryGovernanceObservation(input: {
  enabled?: boolean;
  historyFullTokens: number;
  maxPromptTokens: number;
  degraded?: boolean;
}): HistoryGovernanceObservation | undefined {
  if (!input.enabled) return undefined;
  const historyFullTokens = Math.max(0, Math.ceil(input.historyFullTokens));
  const maxPromptTokens = Math.max(0, Math.floor(input.maxPromptTokens));
  return {
    historyMode: 'observe',
    historyFullTokens,
    historyBudgetRatio: maxPromptTokens > 0 ? historyFullTokens / maxPromptTokens : 0,
    historyGovernanceDegraded: Boolean(input.degraded) || maxPromptTokens <= 0,
  };
}

const MAX_THREAD_HISTORY_SUMMARY_SEGMENTS = 4;

function formatSummaryScope(segments: readonly ThreadHistorySummarySegment[]): string {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return '';
  return `Scope: ${first.threadId}, messages ${first.fromMessageId}..${last.toMessageId}, generated_at=${last.generatedAt}`;
}

export function formatThreadHistorySummary(
  segments: readonly ThreadHistorySummarySegment[],
): FormattedThreadHistorySummary | undefined {
  const usable = segments.filter((segment) => segment.summary.trim().length > 0);
  if (usable.length === 0) return undefined;

  const segmentLines = usable.map((segment, index) => {
    const summary = sanitizeInjectedContent(segment.summary).trim();
    const range = `${segment.fromMessageId}..${segment.toMessageId}`;
    return [`Segment ${index + 1}: ${segment.id} (${range}, ${segment.messageCount} messages)`, summary].join('\n');
  });
  const text = [
    '[Thread History Summary]',
    formatSummaryScope(usable),
    'This is a compressed, provenance-backed summary of older delivered messages.',
    '需要精确引用、文件路径、命令输出或敏感凭据细节时，请申请回看原文范围，不要凭摘要猜测。',
    '',
    segmentLines.join('\n\n'),
    '[/Thread History Summary]',
  ].join('\n');

  return {
    mode: 'shadow-summary',
    text,
    tokens: estimateTokens(text),
    segmentIds: usable.map((segment) => segment.id),
    messageCount: usable.reduce((sum, segment) => sum + Math.max(0, segment.messageCount), 0),
    watermarkMessageId: usable[usable.length - 1]?.toMessageId,
  };
}

export async function readThreadHistorySummaryForContext(
  store: IThreadHistorySummaryStore | undefined,
  threadId: string,
): Promise<FormattedThreadHistorySummary | undefined> {
  if (!store) return undefined;
  try {
    const segments = await store.listLatestByThread(threadId, MAX_THREAD_HISTORY_SUMMARY_SEGMENTS);
    return formatThreadHistorySummary(segments);
  } catch (err) {
    log.warn({ err, threadId }, 'history summary formatter failed to read summary_segments');
    return undefined;
  }
}

export function buildContextUsageWarning(input: {
  estimatedTokens: number;
  maxPromptTokens: number;
  thresholdRatio?: number;
}): ContextUsageWarning | undefined {
  const estimatedTokens = Math.max(0, Math.ceil(input.estimatedTokens));
  const maxPromptTokens = Math.max(0, Math.floor(input.maxPromptTokens));
  if (maxPromptTokens <= 0 || estimatedTokens <= 0) return undefined;

  const ratio = estimatedTokens / maxPromptTokens;
  const thresholdRatio = input.thresholdRatio ?? CONTEXT_RATIONAL_LINE_RATIO;
  if (ratio < thresholdRatio) return undefined;
  const level = getContextPressureLevel(ratio);
  if (level === 'none') return undefined;

  return {
    ratio,
    estimatedTokens,
    maxPromptTokens,
    level,
    action: 'memory-writeback',
  };
}

const STANDARD_CONTEXT_BUDGET_CAP: Pick<ContextBudget, 'maxContextTokens' | 'maxMessages' | 'maxContentLengthPerMsg'> =
  {
    maxContextTokens: 12_000,
    maxMessages: 10,
    maxContentLengthPerMsg: 4_000,
  };

const FOCUSED_SURFACE_CONTEXT_BUDGET_CAP: Pick<
  ContextBudget,
  'maxContextTokens' | 'maxMessages' | 'maxContentLengthPerMsg'
> = {
  maxContextTokens: 8_000,
  maxMessages: 10,
  maxContentLengthPerMsg: 3_000,
};

function isFocusedSurface(surface: RuntimeContextSurfaceHint | undefined): boolean {
  if (!surface) return false;
  if (surface.isDM) return true;
  const title = surface.title?.trim();
  return Boolean(title && (title.includes('(分支)') || title === '分支对话'));
}

function capBudget(
  base: ContextBudget,
  cap: Pick<ContextBudget, 'maxContextTokens' | 'maxMessages' | 'maxContentLengthPerMsg'>,
): ContextBudget {
  return {
    maxPromptTokens: base.maxPromptTokens,
    maxContextTokens: Math.min(base.maxContextTokens, cap.maxContextTokens),
    maxMessages: Math.min(base.maxMessages, cap.maxMessages),
    maxContentLengthPerMsg: Math.min(base.maxContentLengthPerMsg, cap.maxContentLengthPerMsg),
  };
}

/**
 * Slock-like "成熟秘书"预算：
 * - minimal: 当前消息为主，不带历史窗口
 * - standard: 只带最近必要窗口，避免普通任务背 160k+ 历史包
 * - full: 保留原始大上下文能力，给深度调研/工程重任务使用
 */
export function getEffectiveRuntimeContextBudget(
  catId: CatId,
  policy: ToolPolicy,
  surface?: RuntimeContextSurfaceHint,
): ContextBudget {
  const base = getCatContextBudget(catId as string);
  if (policy === 'minimal') {
    return {
      maxPromptTokens: base.maxPromptTokens,
      maxContextTokens: 0,
      maxMessages: 0,
      maxContentLengthPerMsg: Math.min(base.maxContentLengthPerMsg, 1_500),
    };
  }
  if (policy === 'standard') {
    return capBudget(
      base,
      isFocusedSurface(surface) ? FOCUSED_SURFACE_CONTEXT_BUDGET_CAP : STANDARD_CONTEXT_BUDGET_CAP,
    );
  }
  return base;
}

export function buildRuntimeContextBudgetSnapshot(input: {
  threadId: string;
  toolPolicy: ToolPolicy;
  toolPolicySource: 'agent-default' | 'user-override';
  mode: 'serial' | 'parallel';
  prompt: string;
  staticIdentity?: string;
  historyCount?: number;
  includedHistoryCount?: number;
  loadStandardContext: boolean;
  loadFullContext: boolean;
  hasPackBlocks: boolean;
  hasWorldContext: boolean;
  hasSessionBootstrap: boolean;
  hasSignalArticles: boolean;
  hasAlwaysOnDocs: boolean;
  hasSopHint: boolean;
  hasGuideContext: boolean;
  hasMcpInstructions: boolean;
  hasAgentMemory: boolean;
  hasLessonsContext: boolean;
  hasProjectContext?: boolean;
  projectContextDeferred?: boolean;
  skillRouterMatchedSkills?: readonly string[];
  governanceTier: 'core' | 'operational';
  governanceEstimatedTokens: number;
  hasGovernanceSourceContext: boolean;
  catBudget: ReturnType<typeof getCatContextBudget>;
  historyObservation?: HistoryGovernanceObservation;
  historySummary?: HistorySummaryObservation;
  historyGovernanceDegraded?: boolean;
}): RuntimeContextBudgetSnapshot {
  const loadedBlocks = ['current-message', 'static-identity'];
  loadedBlocks.push(input.governanceTier === 'core' ? 'governance-core' : 'governance-operational');
  if (input.hasGovernanceSourceContext) loadedBlocks.push('governance-source');
  if (input.hasAgentMemory) loadedBlocks.push('agent-memory');
  if (input.hasLessonsContext) loadedBlocks.push('lessons');
  if (input.hasProjectContext) loadedBlocks.push('project-progress');
  if (input.projectContextDeferred) loadedBlocks.push('project-progress:on-demand');
  if (input.hasMcpInstructions) loadedBlocks.push('mcp-callback-instructions');
  if (input.hasPackBlocks) loadedBlocks.push('pack-blocks');
  if (input.hasWorldContext) loadedBlocks.push('world-context');
  if (input.hasSessionBootstrap) loadedBlocks.push('session-bootstrap');
  if (input.hasSignalArticles) loadedBlocks.push('signal-articles');
  if (input.hasAlwaysOnDocs) loadedBlocks.push('always-on-docs');
  if (input.hasSopHint) loadedBlocks.push('sop-hint');
  if (input.hasGuideContext) loadedBlocks.push('guide-context');
  if (input.historySummary) loadedBlocks.push('history-summary');
  if (input.skillRouterMatchedSkills) {
    loadedBlocks.push('skill-router');
    for (const skillName of input.skillRouterMatchedSkills) {
      loadedBlocks.push(`skill:${skillName}`);
    }
  }

  const skippedBlocks: string[] = [];
  if (!input.loadStandardContext) {
    skippedBlocks.push('pack-blocks', 'world-context', 'session-bootstrap', 'lessons', 'project-progress');
  }
  if (input.projectContextDeferred) {
    skippedBlocks.push('project-progress');
  }
  if (!input.loadFullContext) {
    skippedBlocks.push('signal-articles', 'always-on-docs', 'sop-hint', 'guide-context');
  }

  const historyCount = Math.max(0, input.historyCount ?? 0);
  const includedHistoryCount = Math.max(0, input.includedHistoryCount ?? 0);
  return {
    surface: 'thread',
    threadId: input.threadId,
    toolPolicy: input.toolPolicy,
    toolPolicySource: input.toolPolicySource,
    mode: input.mode,
    estimatedTokens: estimateTokens([input.staticIdentity, input.prompt].filter(Boolean).join('\n\n')),
    historyMessages: includedHistoryCount,
    loadedBlocks,
    skippedBlocks,
    governanceTier: input.governanceTier,
    governanceEstimatedTokens: input.governanceEstimatedTokens,
    governanceSourceInjected: input.hasGovernanceSourceContext,
    usesFullHistory: historyCount > 0 && includedHistoryCount >= historyCount,
    maxPromptTokens: input.catBudget.maxPromptTokens,
    maxContextTokens: input.catBudget.maxContextTokens,
    ...(input.historyObservation ?? {}),
    ...(input.historySummary
      ? {
          historyMode: input.historySummary.mode,
          historySummaryTokens: Math.max(0, Math.ceil(input.historySummary.tokens)),
          summarySegmentId: input.historySummary.segmentIds[0],
        }
      : {}),
    ...(input.historyGovernanceDegraded !== undefined || input.historyObservation?.historyGovernanceDegraded !== undefined
      ? {
          historyGovernanceDegraded: Boolean(
            input.historyObservation?.historyGovernanceDegraded || input.historyGovernanceDegraded,
          ),
        }
      : {}),
  };
}

/** Dependencies shared across route strategies */
export interface RouteStrategyDeps {
  services: Record<string, AgentService>;
  invocationDeps: InvocationDeps;
  messageStore: IMessageStore;
  deliveryCursorStore?: DeliveryCursorStore;
  /** #80: Streaming draft persistence store */
  draftStore?: IDraftStore;
  /** F079 Bug 2: Optional broadcaster for real-time vote result delivery */
  socketManager?: RouteBroadcaster;
  /** F129: Pack store for loading active packs at invocation time */
  packStore?: import('../../../../packs/PackStore.js').PackStore;
  /** F148: Evidence store for context recall (optional, fail-open) */
  evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
  /** Phase 3B: read-only summary_segments source for shadow summary formatting. */
  threadHistorySummaryStore?: IThreadHistorySummaryStore;
  /** F150: Tool usage counter (fire-and-forget INCR on tool_use events) */
  toolUsageCounter?: import('../../tool-usage/ToolUsageCounter.js').ToolUsageCounter;
  /** F148 Phase F: Task store for navigation context (optional, fail-open) */
  taskStore?: import('../../stores/ports/TaskStore.js').ITaskStore;
  /** F093: World context provider for world-building mode (optional, fail-open) */
  worldContextProvider?: import('../../../../world/WorldContextProvider.js').WorldContextProvider;
  /** F093: World store for thread→world lookup (optional, fail-open) */
  worldStore?: import('../../../../world/interfaces.js').IWorldStore;
}

export interface HistoryGovernanceHistorySnapshot {
  messages: readonly StoredMessage[];
  degraded: boolean;
}

export interface CompactBoundarySignal {
  preTokens?: number;
}

export function parseCompactBoundarySystemInfo(content: string): CompactBoundarySignal | null {
  try {
    const parsed = JSON.parse(content) as { type?: unknown; preTokens?: unknown };
    if (parsed.type !== 'compact_boundary') return null;
    return {
      ...(typeof parsed.preTokens === 'number' && Number.isFinite(parsed.preTokens)
        ? { preTokens: parsed.preTokens }
        : {}),
    };
  } catch {
    return null;
  }
}

async function findSourceTaskForRouteLedger(input: {
  deps: RouteStrategyDeps;
  threadId: string;
  currentUserMessageId?: string;
}): Promise<TaskItem | null> {
  const taskStore = input.deps.taskStore ?? input.deps.invocationDeps.taskStore;
  if (!taskStore) return null;
  const tasks = await Promise.resolve(taskStore.listByThread(input.threadId));
  const byMessage = input.currentUserMessageId
    ? tasks.find((task) => task.sourceMessageId === input.currentUserMessageId)
    : undefined;
  if (byMessage) return byMessage;
  const byTaskThread = tasks.find((task) => task.taskThreadId === input.threadId);
  if (byTaskThread) return byTaskThread;
  if (typeof taskStore.listByKind === 'function') {
    const workTasks = await Promise.resolve(taskStore.listByKind('work'));
    return workTasks.find((task) => task.taskThreadId === input.threadId) ?? null;
  }
  return null;
}

export async function appendCompactBoundaryTaskEvent(
  deps: RouteStrategyDeps,
  input: {
    threadId: string;
    currentUserMessageId?: string;
    catId: string;
    invocationId?: string;
    timestamp?: number;
    preTokens?: number;
  },
): Promise<void> {
  const taskStore = deps.taskStore ?? deps.invocationDeps.taskStore;
  if (!taskStore) return;
  try {
    const sourceTask = await findSourceTaskForRouteLedger({
      deps,
      threadId: input.threadId,
      currentUserMessageId: input.currentUserMessageId,
    });
    if (!sourceTask) return;
    const updated = await taskStore.update(sourceTask.id, {
      events: [
        {
          ts: new Date(input.timestamp ?? Date.now()).toISOString(),
          catId: input.catId,
          ...(input.invocationId ? { invocationId: input.invocationId } : {}),
          type: 'compact_boundary',
          data: {
            boundary: 'compact_boundary',
            source: 'provider',
            ...(input.preTokens !== undefined ? { preTokens: input.preTokens } : {}),
          },
        },
      ],
    });
    if (updated && deps.socketManager) {
      deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    }
  } catch (err) {
    log.warn({ err, threadId: input.threadId, catId: input.catId }, 'append compact boundary task event failed');
  }
}

export async function readHistoryForGovernanceObservation(
  deps: RouteStrategyDeps,
  threadId: string,
  userId: string,
  history: readonly StoredMessage[] | undefined,
): Promise<HistoryGovernanceHistorySnapshot> {
  try {
    const messages = await deps.messageStore.getByThreadAfter(threadId, undefined, undefined, userId);
    return { messages, degraded: false };
  } catch (err) {
    log.warn({ err, threadId, userId }, 'history governance observation failed to read full thread history');
    return { messages: history ?? [], degraded: true };
  }
}

/** Mutable context for tracking persistence failures across the generator boundary.
 *  Caller creates the object, passes it in RouteOptions, and checks after generator exhausts. */
export interface PersistenceContext {
  /** Set to true by route strategies when any messageStore.append() call fails */
  failed: boolean;
  /** Error details for diagnostics */
  errors: Array<{ catId: string; error: string }>;
  /** F088-P3: Rich blocks consumed during this invocation, for outbound delivery */
  richBlocks?: import('@cat-cafe/shared').RichBlock[];
}

/** Common options for both strategies */
export interface RouteOptions {
  contentBlocks?: readonly MessageContent[] | undefined;
  uploadDir?: string | undefined;
  signal?: AbortSignal | undefined;
  promptTags?: readonly string[] | undefined;
  /** Pre-assembled context (deprecated: use history for per-cat budget) */
  contextHistory?: string | undefined;
  /** Raw thread history for per-cat context assembly */
  history?: StoredMessage[] | undefined;
  /** Current user message ID (enables exact incremental context delivery path) */
  currentUserMessageId?: string | undefined;
  /** Same-thread message that agent stream/callback output should visually reply to. */
  replyToMessageId?: string | undefined;
  /** Max A2A chain depth for routeSerial (default: MAX_A2A_DEPTH env or 2) */
  maxA2ADepth?: number | undefined;
  /** A2A routing mode.
   *  legacy: final response text line-start @mention extends the hidden worklist.
   *  slock: only explicit callback / visible message routing may dispatch another cat. */
  a2aRoutingMode?: 'legacy' | 'slock' | undefined;
  /** Queue fairness hook: when true for current thread, routeSerial must stop extending A2A chain. */
  queueHasQueuedMessages?: ((threadId: string) => boolean) | undefined;
  /** A2A dedup hook: skip text-scan @mention if cat already dispatched via callback path. */
  hasQueuedOrActiveAgentForCat?: ((threadId: string, catId: string) => boolean) | undefined;
  /** ADR-008 S3: When provided, cursor boundaries are collected here instead of acking immediately.
   *  Caller acks after invocation succeeds. If absent, legacy immediate ack behavior. */
  cursorBoundaries?: Map<string, string>;
  /** P1-2: When provided, persistence failures are recorded here instead of silently swallowed.
   *  Caller checks after generator exhausts to determine invocation status. */
  persistenceContext?: PersistenceContext;
  /** F11: Mode-specific system prompt section (appended after identity prompt) */
  modeSystemPrompt?: string | undefined;
  /** F11: Per-cat mode prompt override (takes precedence over modeSystemPrompt) */
  modeSystemPromptByCat?: Record<string, string> | undefined;
  /** Thinking visibility: play = cats don't see each other's thinking, debug = cats share thinking. Default: play */
  thinkingMode?: 'debug' | 'play' | undefined;
  /** F108: Unique invocation ID for WorklistRegistry isolation in concurrent execution.
   *  When provided, worklist is keyed by this ID instead of threadId. */
  parentInvocationId?: string | undefined;
  /** Parent invocation controller used to keep A2A worklist slots tied to the same cancel signal. */
  invocationController?: AbortController | undefined;
  /** Queue-backed A2A text-scan dispatch. When present, routeSerial should not grow the in-memory worklist. */
  enqueueA2ATargets?:
    | ((input: {
        threadId: string;
        userId: string;
        callerCatId: CatId;
        targetCats: CatId[];
        content: string;
        triggerMessageId?: string;
      }) => Promise<readonly CatId[]>)
    | undefined;
  /** Queue-backed A2A caller identity for a single-cat dispatch. */
  directMessageFrom?: CatId | undefined;
  /** Queue-backed A2A trigger message id for a single-cat dispatch. */
  a2aTriggerMessageId?: string | undefined;
  /** Register an A2A worklist target with the outer invocation tracker before it executes. */
  trackA2ASlot?: ((threadId: string, catId: CatId, userId: string, controller: AbortController) => void) | undefined;
  /** Cleanup registered A2A worklist slots if the route exits before every target emits done. */
  completeA2ASlots?: ((threadId: string, catIds: readonly CatId[], controller: AbortController) => void) | undefined;
  /** F153 Phase E: Root route span — invocation spans become children of this. */
  routeSpan?: import('@opentelemetry/api').Span | undefined;
}

export async function persistSilentCompletionNotice(
  deps: RouteStrategyDeps,
  args: {
    threadId: string;
    catId: string;
    displayName?: string;
    toolCount?: number;
    provider?: string;
    model?: string;
    invocationId?: string;
  },
): Promise<boolean> {
  const displayName = args.displayName ?? args.catId;
  const source = {
    connector: 'silent-completion',
    label: '执行提醒',
    icon: '⚠️',
    meta: { presentation: 'system_notice', noticeTone: 'warning' },
  } as const;
  const diagnostics = [
    args.toolCount && args.toolCount > 0 ? `工具调用 ${args.toolCount} 次` : '',
    args.provider || args.model ? `模型 ${[args.provider, args.model].filter(Boolean).join('/')}` : '',
    args.invocationId ? `调用 ${args.invocationId.slice(0, 8)}` : '',
  ].filter(Boolean);
  const content =
    `[执行提醒]: ${displayName} 已完成本轮调用，但没有返回可展示文本。` +
    '这通常是 CLI/模型返回了 thinking、工具事件或空结果；请换一种问法重试，或检查该 Agent 的运行日志。' +
    '\n\n建议下一步：直接追问「请总结刚才读取/检查到的内容，并输出结论」。' +
    (diagnostics.length > 0 ? `\n\n${diagnostics.join(' · ')}` : '');

  try {
    const stored = await deps.messageStore.append({
      userId: 'system',
      catId: null,
      threadId: args.threadId,
      content,
      mentions: [],
      timestamp: Date.now(),
      source,
    });
    deps.socketManager?.broadcastToRoom(`thread:${args.threadId}`, 'connector_message', {
      threadId: args.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: stored.content,
        source,
        timestamp: stored.timestamp,
      },
    });
    return true;
  } catch (err) {
    log.warn({ err, catId: args.catId, threadId: args.threadId }, 'persist silent completion notice failed');
    return false;
  }
}

export interface IncrementalContextResult {
  contextText: string;
  boundaryId?: string;
  includedHistoryCount?: number;
  includesCurrentUserMessage: boolean;
  /** True when the current user message exists in unseen but was filtered out
   *  (e.g. whisper not intended for this cat). Callers must NOT inject the raw
   *  message text as fallback when this is true — doing so would leak whisper content. */
  currentMessageFilteredOut: boolean;
  /** GAP-1: User-facing message when incremental batch was truncated by budget cap */
  degradation?: string;
  /** Phase E: Coverage map for context briefing surface (only present when smart window triggered) */
  coverageMap?: CoverageMap;
  /** Phase E: Briefing context data for AC-E4 expanded view */
  briefingContext?: {
    threadMemorySummary?: string;
    anchorSummaries?: string[];
    baton?: import('./navigation-context.js').BatonContext;
    activeTasks?: import('./navigation-context.js').TaskSummary[];
    recentArtifacts?: import('./artifact-tracking.js').RecentArtifact[];
    rankedSources?: import('./source-ranking.js').RankedSource[];
  };
  /** F148 Phase F: Navigation context header (injected on ALL paths — KD-7) */
  navigationHeader?: string;
  /** Phase 3B: summary_segments shadow formatter diagnostics. */
  historySummary?: HistorySummaryObservation;
  /** Phase 3D/B3: true when summary governance fell back because a guard failed. */
  historyGovernanceDegraded?: boolean;
  historyGovernanceQualityIssues?: readonly HistorySummaryQualityIssue[];
  /** Slock-like Agent Inbox snapshot for latest user intent in the current surface. */
  intentSnapshot?: AgentIntentSnapshot;
}

export type AgentIntentType = 'discussion' | 'action' | 'correction' | 'approval' | 'stage-input';

export interface AgentIntentSnapshotMessage {
  id: string;
  type: AgentIntentType;
  content: string;
}

export interface AgentIntentSnapshot {
  surface: 'thread';
  messageCount: number;
  intentType: AgentIntentType;
  latestInstruction: string;
  latestMessageId?: string;
  supersededMessageIds: string[];
  requiresTask: boolean;
  requiresUserConfirmation: boolean;
  stage?: 'requirement' | 'outline' | 'plan' | 'draft' | 'export' | 'unknown';
  toolPolicyHint: ToolPolicy;
  recentMessages: AgentIntentSnapshotMessage[];
}

export interface AgentStageGate {
  stage: NonNullable<AgentIntentSnapshot['stage']>;
  mode: 'hold-for-confirmation' | 'resume-after-approval';
  instruction: string;
}

const ACTION_INTENT_RE = /(修复|推进|执行|构建|导出|检查|排查|改造|写入|备份|push|提交|实现|处理|你来做|帮我做|开始做|继续做)/i;
const CORRECTION_INTENT_RE =
  /(先别|别急|等等|暂停|停止|不要做|先不做|不是这个|换方向|先讨论|先确认|先看方案|先给.*方案|确认后再执行)/i;
const APPROVAL_INTENT_RE = /^(ok|OK|确认|可以|同意|按这个|开始吧|开始做吧|继续|推进吧|执行吧)[。！!\s]*$/i;
const STAGE_INPUT_RE = /(补充|资料|材料|需求|大纲|策划稿|布局|排版|设计稿|初稿|调整|修改|改成|换成)/i;

function classifyIntent(content: string): AgentIntentType {
  const normalized = content.trim();
  if (!normalized) return 'discussion';
  if (CORRECTION_INTENT_RE.test(normalized)) return 'correction';
  if (APPROVAL_INTENT_RE.test(normalized)) return 'approval';
  if (ACTION_INTENT_RE.test(normalized)) return 'action';
  if (STAGE_INPUT_RE.test(normalized)) return 'stage-input';
  return 'discussion';
}

function inferIntentStage(content: string): AgentIntentSnapshot['stage'] {
  if (/(需求|诉求|追问|调研|确认需求)/.test(content)) return 'requirement';
  if (/(大纲|目录|章节)/.test(content)) return 'outline';
  if (/(策划稿|页面策划|封面|目录页|内容页)/.test(content)) return 'plan';
  if (/(初稿|设计稿|布局|排版|卡片|HTML|SVG)/i.test(content)) return 'draft';
  if (/(导出|PPTX|下载|产物)/i.test(content)) return 'export';
  return 'unknown';
}

function inferToolPolicyHint(intentType: AgentIntentType, content: string): ToolPolicy {
  if (/(PPT|设计|调研|资料|Design|Figma|HTML|SVG)/i.test(content)) return 'full';
  if (intentType === 'action') return 'standard';
  return 'minimal';
}

function truncateIntentLine(content: string, limit = 180): string {
  const normalized = sanitizeInjectedContent(content).replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

export function buildAgentIntentSnapshot(
  messages: readonly StoredMessage[],
  currentUserMessageId?: string,
): AgentIntentSnapshot | undefined {
  const userMessages = messages.filter(
    (m) => m.catId === null && m.userId !== 'system' && !m.deletedAt && isDelivered(m),
  );
  if (userMessages.length === 0) return undefined;

  const recentSource = userMessages.slice(-20);
  const recentMessages = recentSource.map((m) => ({
    id: m.id,
    type: classifyIntent(m.content),
    content: truncateIntentLine(m.content),
  }));
  const latest = recentMessages[recentMessages.length - 1]!;
  const current = currentUserMessageId ? recentMessages.find((m) => m.id === currentUserMessageId) : undefined;
  const selected = latest ?? current;
  const combinedContent = recentMessages.map((m) => m.content).join('\n');
  const intentType = selected.type;

  return {
    surface: 'thread',
    messageCount: userMessages.length,
    intentType,
    latestInstruction: selected.content,
    latestMessageId: selected.id,
    supersededMessageIds:
      intentType === 'correction' ? recentMessages.slice(0, -1).map((m) => m.id).slice(-5) : [],
    requiresTask: intentType === 'action',
    requiresUserConfirmation: intentType === 'stage-input' || intentType === 'correction',
    stage: inferIntentStage(combinedContent),
    toolPolicyHint: inferToolPolicyHint(intentType, combinedContent),
    recentMessages,
  };
}

export function buildAgentStageGate(snapshot: AgentIntentSnapshot | undefined): AgentStageGate | undefined {
  if (!snapshot) return undefined;
  const stage = snapshot.stage ?? 'unknown';
  if (snapshot.requiresUserConfirmation) {
    return {
      stage,
      mode: 'hold-for-confirmation',
      instruction:
        'Do not execute the next irreversible stage yet. First summarize the buffered inputs, state what will happen next, and ask the user to confirm before generating, exporting, writing files, or changing code.',
    };
  }
  if (snapshot.intentType === 'approval') {
    return {
      stage,
      mode: 'resume-after-approval',
      instruction:
        'The latest user message is an approval signal. Continue the next stage only if the recent thread messages contain a clear pending stage; otherwise ask one concise clarification question.',
    };
  }
  return undefined;
}

export function formatAgentStageGate(gate: AgentStageGate | undefined): string {
  if (!gate) return '';
  return [
    '[Agent Stage Gate]',
    `mode: ${gate.mode}`,
    `stage: ${gate.stage}`,
    `instruction: ${gate.instruction}`,
    '[/Agent Stage Gate]',
  ].join('\n');
}

export function formatAgentIntentSnapshot(snapshot: AgentIntentSnapshot | undefined): string {
  if (!snapshot) return '';
  const recentLines = snapshot.recentMessages
    .slice(-5)
    .map((m) => `- id=${m.id} ${m.type}: ${m.content}`)
    .join('\n');
  const stageGateText = formatAgentStageGate(buildAgentStageGate(snapshot));
  const superseded =
    snapshot.supersededMessageIds.length > 0 ? snapshot.supersededMessageIds.join(', ') : 'none';
  return [
    '[Agent Inbox Snapshot]',
    'Scope: current thread only. Treat this as the latest user intent before acting.',
    `intentType: ${snapshot.intentType}`,
    `latestInstruction: ${snapshot.latestInstruction}`,
    `requiresTask: ${snapshot.requiresTask ? 'yes' : 'no'}`,
    `requiresUserConfirmation: ${snapshot.requiresUserConfirmation ? 'yes' : 'no'}`,
    `stage: ${snapshot.stage ?? 'unknown'}`,
    `toolPolicyHint: ${snapshot.toolPolicyHint}`,
    `supersededMessageIds: ${superseded}`,
    'Rule: later correction/approval messages override earlier instructions in this same thread.',
    'Recent user messages:',
    recentLines,
    '[/Agent Inbox Snapshot]',
    stageGateText,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Decide whether the routing layer should append the raw current user message
 * outside the incremental context envelope.
 *
 * The normal path is:
 * - append when the current message is genuinely absent from unseen history
 * - do NOT append when the message was filtered out for privacy
 *
 * Defensive guard:
 * some smart-window / metadata paths can still surface the current message ID
 * inside `contextText` even when `includesCurrentUserMessage` is false.
 * In that case, appending the raw message would duplicate it in the same prompt.
 */
export function shouldAppendExplicitCurrentMessage(
  inc: Pick<IncrementalContextResult, 'contextText' | 'includesCurrentUserMessage' | 'currentMessageFilteredOut'>,
  currentUserMessageId: string | undefined,
): boolean {
  if (inc.includesCurrentUserMessage || inc.currentMessageFilteredOut) return false;
  if (currentUserMessageId && inc.contextText.includes(currentUserMessageId)) return false;
  return true;
}

/**
 * Keep cursor boundary monotonic within one invocation.
 * When the same cat is invoked multiple times (A2A re-entry), later passes may
 * observe fewer relevant messages and produce an older boundary; this helper
 * prevents regressing the deferred ack boundary.
 *
 * Assumes message IDs are lexicographically monotonic (timestamp+seq prefix).
 */
export function upsertMaxBoundary(cursorBoundaries: Map<string, string>, catId: string, boundaryId: string): void {
  const current = cursorBoundaries.get(catId);
  if (!current || boundaryId > current) {
    cursorBoundaries.set(catId, boundaryId);
  }
}

/** Get the agent service for a given cat ID */
export function getService(services: Record<string, AgentService>, catId: CatId): AgentService {
  const service = services[catId];
  if (!service) throw new Error(`Unknown cat ID: ${catId as string}`);
  return service;
}

export function getThreadBootcampMemberCount(thread: Thread | null | undefined): number | undefined {
  if (!thread?.bootcampState) return undefined;
  const members = new Set<string>(thread.participants);
  if (thread.bootcampState.leadCat) {
    members.add(thread.bootcampState.leadCat);
  }
  return members.size;
}

export function shouldHandleCompletedGuide(
  guideCompletionOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallbackCatId: string | undefined,
  catId: string,
): boolean {
  if (!guideCompletionOwner) return true;
  if (guideCompletionOwner === catId) return true;
  if (!targetCatIds.has(guideCompletionOwner)) return fallbackCatId === catId;
  return false;
}

export function shouldHandleOfferedGuide(
  guideOfferOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallbackCatId: string | undefined,
  catId: string,
  hasUserSelection: boolean,
  allowOwnerMissingFallback = false,
): boolean {
  if (!guideOfferOwner) return true;
  if (guideOfferOwner === catId) return true;
  if ((hasUserSelection || allowOwnerMissingFallback) && !targetCatIds.has(guideOfferOwner)) {
    return fallbackCatId === catId;
  }
  return false;
}

export function detectContextDegradation(
  historyCount: number,
  includedCount: number,
  budget: ReturnType<typeof getCatContextBudget>,
): DegradationResult | null {
  // Existing count-based degradation logic
  const byCount = checkContextBudget(historyCount, budget);
  if (byCount.degraded) return byCount;

  // Additional char-budget degradation: history count is within budget, but content still got truncated.
  const maxCountCandidate = Math.min(historyCount, budget.maxMessages);
  if (includedCount < maxCountCandidate) {
    return {
      degraded: true,
      strategy: 'truncated',
      reason: `Token 预算限制，历史从 ${maxCountCandidate} 条截断到 ${includedCount} 条`,
      adjustedMaxMessages: includedCount,
    };
  }

  return null;
}

/** Truncate a string for tool event detail preview */
export function truncateDetail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Build a StoredToolEvent from a streaming AgentMessage */
export function toStoredToolEvent(msg: AgentMessage): StoredToolEvent | null {
  if (msg.type === 'tool_use') {
    const toolName = msg.toolName ?? 'unknown';
    let detail: string | undefined;
    if (msg.toolInput) {
      try {
        detail = truncateDetail(JSON.stringify(msg.toolInput), 200);
      } catch {
        detail = '[unserializable]';
      }
    }
    return {
      id: `tool-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'tool_use',
      label: `${msg.catId as string} → ${toolName}`,
      ...(detail ? { detail } : {}),
      timestamp: msg.timestamp,
    };
  }
  if (msg.type === 'tool_result') {
    const raw = (msg.content ?? '').trimEnd();
    const detail = raw.length > 0 ? truncateDetail(raw, 1500) : '(no output)';
    return {
      id: `toolr-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'tool_result',
      label: `${msg.catId as string} ← result`,
      detail,
      timestamp: msg.timestamp,
    };
  }
  return null;
}

const USER_FACING_SYSTEM_INFO_TYPES = new Set([
  'a2a_followup_available',
  'governance_blocked',
  'invocation_preempted',
  'mode_switch_proposal',
  'session_seal_requested',
  'silent_completion',
  'warning',
]);

/**
 * Return true when a system_info payload already produces a user-visible notice in the UI.
 * Route strategies use this to avoid appending a misleading silent_completion after an
 * actionable blocker/warning has already been surfaced.
 */
export function isUserFacingSystemInfoContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: unknown };
    return typeof parsed.type === 'string' && USER_FACING_SYSTEM_INFO_TYPES.has(parsed.type);
  } catch {
    return true;
  }
}

function isInternalToolRecipientName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('functions.') || value.startsWith('mcp__') || value.startsWith('multi_tool_use.'))
  );
}

function looksLikeLeakedToolCallPayload(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(trimmed) as {
      tool_uses?: Array<{ recipient_name?: unknown }>;
      recipient_name?: unknown;
    };
    if (Array.isArray(parsed.tool_uses)) {
      return parsed.tool_uses.some((item) => isInternalToolRecipientName(item?.recipient_name));
    }
    return isInternalToolRecipientName(parsed.recipient_name);
  } catch {
    return false;
  }
}

const LEAKED_TOOL_CALL_SIGNATURES = [
  '{"tool_uses":[{"recipient_name":"functions.',
  '{"tool_uses":[{"recipient_name":"mcp__',
  '{"tool_uses":[{"recipient_name":"multi_tool_use.',
  '{"recipient_name":"functions.',
  '{"recipient_name":"mcp__',
  '{"recipient_name":"multi_tool_use.',
];

const INTENTIONAL_JSON_EXAMPLE_LINE_RE =
  /^(?:(?:(?:文档|JSON)\s*)?示例|for\s+example|example|json\s+example|例如|比如)\s*(?:[:：]\s*)?$/i;

function looksLikePotentialLeakedToolCallPayloadPrefix(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{')) return false;

  const compact = trimmed.replace(/\s+/g, '');
  return LEAKED_TOOL_CALL_SIGNATURES.some(
    (signature) => signature.startsWith(compact) || compact.startsWith(signature),
  );
}

function findLineStartPayloadIndex(
  content: string,
  predicate: (candidate: string) => boolean,
): { index: number; candidate: string } | null {
  const lines = content.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('{')) {
      offset += line.length + 1;
      continue;
    }

    const leadingWhitespace = line.length - trimmed.length;
    const candidate = lines.slice(i).join('\n');
    if (predicate(candidate)) {
      return { index: offset + leadingWhitespace, candidate };
    }
    offset += line.length + 1;
  }

  return null;
}

function isIntentionalJsonExamplePrefix(prefix: string): boolean {
  const trimmed = prefix.trimEnd();
  if (!trimmed) return false;

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    if (/^```(?:json)?$/i.test(line)) return true;
    return INTENTIONAL_JSON_EXAMPLE_LINE_RE.test(line);
  }

  return false;
}

export function stripLeakedToolCallPayload(content: string): string {
  if (!content) return content;

  const match = findLineStartPayloadIndex(content, looksLikeLeakedToolCallPayload);
  if (match) {
    const prefix = content.slice(0, match.index);
    if (isIntentionalJsonExamplePrefix(prefix)) {
      return content;
    }
    return prefix.replace(/\s+$/, '');
  }

  return content;
}

export interface RoutedMessageTransform {
  transform(msg: AgentMessage): AgentMessage[];
}

export interface LeakedToolCallStreamStripper {
  push(content: string): string;
  flush(): string;
}

export function createLeakedToolCallStreamStripper(): LeakedToolCallStreamStripper {
  let pending = '';
  let pendingEmittedLength = 0;

  return {
    push(content: string): string {
      if (!content) return content;

      const combined = pending + content;
      const alreadyEmittedLength = pendingEmittedLength;
      pending = '';
      pendingEmittedLength = 0;

      const stripped = stripLeakedToolCallPayload(combined);
      if (stripped !== combined) {
        return stripped.slice(alreadyEmittedLength);
      }

      const match = findLineStartPayloadIndex(combined, looksLikePotentialLeakedToolCallPayloadPrefix);
      if (!match) {
        return combined.slice(alreadyEmittedLength);
      }

      const emittedPrefix = combined.slice(0, match.index).replace(/\s+$/, '');
      pending = combined;
      pendingEmittedLength = emittedPrefix.length;
      return emittedPrefix.slice(alreadyEmittedLength);
    },
    flush(): string {
      if (!pending) return '';

      const remaining = pending;
      const alreadyEmittedLength = pendingEmittedLength;
      pending = '';
      pendingEmittedLength = 0;
      return stripLeakedToolCallPayload(remaining).slice(alreadyEmittedLength);
    },
  };
}

export function createRoutingMessageTransform(explicitCatId?: CatId): RoutedMessageTransform {
  const leakedPayloadStripper = createLeakedToolCallStreamStripper();

  return {
    transform(msg: AgentMessage): AgentMessage[] {
      if (msg.type === 'text') {
        const content = msg.content ? leakedPayloadStripper.push(msg.content) : msg.content;
        return content ? [{ ...msg, content }] : [];
      }

      if (msg.type === 'done') {
        const transformed: AgentMessage[] = [];
        const flushedText = leakedPayloadStripper.flush();
        if (flushedText) {
          transformed.push({
            type: 'text',
            catId: msg.catId ?? explicitCatId,
            content: flushedText,
            timestamp: msg.timestamp,
          });
        }
        transformed.push(msg);
        return transformed;
      }

      return [msg];
    },
  };
}

export function sanitizeInjectedContent(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skippingHistoryEnvelope = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHistoryHeader =
      line.startsWith('[对话历史 - 最近 ') ||
      line.startsWith('[对话历史增量 - 未发送过 ') ||
      line.startsWith('[对话历史增量 - 智能窗口');

    if (!skippingHistoryEnvelope && isHistoryHeader) {
      // Drop known injected history envelopes only.
      skippingHistoryEnvelope = true;
      continue;
    }

    if (skippingHistoryEnvelope) {
      // Use unique terminator to avoid false matches with markdown `---`
      if (trimmed === '[/对话历史]' || trimmed === '---') {
        skippingHistoryEnvelope = false;
      }
      continue;
    }

    kept.push(line);
  }

  return stripLeakedToolCallPayload(kept.join('\n')).trim();
}

/**
 * Route content blocks to the target cat.
 * All cats receive the full content blocks including images —
 * each AgentService (Claude/Codex/Gemini) handles image paths
 * via its own CLI bridge (--add-dir / --image / --include-directories).
 */
export function routeContentBlocksForCat(
  _catId: CatId,
  contentBlocks: readonly MessageContent[] | undefined,
): readonly MessageContent[] | undefined {
  return contentBlocks ?? undefined;
}

/**
 * F22: Summarize rich blocks for context injection.
 * Replaces verbose rich block JSON with compact digests so cats know
 * what was previously rendered without wasting tokens.
 */
function digestRichBlock(b: RichBlock): string {
  switch (b.kind) {
    case 'card':
      return `[卡片: ${b.title ?? '无标题'}]`;
    case 'diff':
      return `[代码 diff: ${b.filePath ?? '未知文件'}]`;
    case 'checklist':
      return `[清单: ${b.title ?? `${Array.isArray(b.items) ? b.items.length : 0} 项`}]`;
    case 'media_gallery':
      return `[图片: ${Array.isArray(b.items) ? b.items.length : 0} 张]`;
    default:
      return `[富块: ${(b as RichBlockBase).kind}]`;
  }
}

export function digestRichBlocks(msg: StoredMessage): string {
  if (!msg.extra?.rich?.blocks?.length) return msg.content;
  const digests = msg.extra.rich.blocks.map(digestRichBlock);
  return `${msg.content}\n${digests.join(' ')}`;
}

export async function fetchAfterCursor(
  messageStore: IMessageStore,
  threadId: string,
  afterId: string | undefined,
  userId: string,
): Promise<StoredMessage[]> {
  return messageStore.getByThreadAfter(threadId, afterId, undefined, userId);
}

/** Options for caller-specified budget overrides */
export interface IncrementalContextOptions {
  /**
   * When provided, overrides budget.maxContextTokens for the token-trim pass.
   * The routing layer should calculate this as:
   *   maxPromptTokens - systemPartsTokens - messageTokens - guard
   * so the assembled context + system parts never exceed the model's input limit.
   */
  effectiveMaxContextTokens?: number;
  contextBudget?: ContextBudget;
  recentFilesTouched?: Array<{ path: string; ops: string[] }>;
  canonicalFeatureId?: string;
  threadTitle?: string;
  /** Test/route override for Phase 3B shadow summary. Defaults to env flag. */
  historySummaryEnabled?: boolean;
  /** Phase 3A observation used by Phase 3C to switch canary threads to summary-active. */
  historyObservation?: HistoryGovernanceObservation;
  /** Test/route override for governance env flags. Defaults to process.env. */
  historyGovernanceEnv?: NodeJS.ProcessEnv;
}

export async function assembleIncrementalContext(
  deps: RouteStrategyDeps,
  userId: string,
  threadId: string,
  catId: CatId,
  currentUserMessageId?: string,
  thinkingMode?: 'debug' | 'play',
  options?: IncrementalContextOptions,
): Promise<IncrementalContextResult> {
  if (!deps.deliveryCursorStore) {
    return { contextText: '', includesCurrentUserMessage: false, currentMessageFilteredOut: false };
  }

  const cursor = await deps.deliveryCursorStore.getCursor(userId, catId, threadId);
  const unseen = await fetchAfterCursor(deps.messageStore, threadId, cursor, userId);

  // Debug mode: cats see all whispers (full transparency). Play mode: cats only see their own whispers.
  const viewer = (thinkingMode ?? 'play') === 'play' ? { type: 'cat' as const, catId } : { type: 'user' as const };
  const relevant = unseen.filter((m) => {
    // System-generated messages (persisted error badges) are display-only — never enter prompt
    if (m.userId === 'system') return false;
    // F148 Phase E: briefing messages are non-routing — never enter incremental context (AC-E2)
    if (m.origin === 'briefing') return false;
    // F35: Exclude whispers not intended for this cat (play mode only)
    if (!canViewMessage(m, viewer)) return false;
    // Exclude own messages (only include user messages and other cats' messages)
    // F052 fix: exempt cross-posted messages — same catId from another thread must be visible
    if (!m.extra?.crossPost && m.catId !== null && m.catId === catId) return false;
    // In play mode, hide other cats' stream (thinking) messages.
    // Legacy messages (no origin) are visible for backward compatibility —
    // all new writes are tagged, so untagged = legacy callback data.
    if ((thinkingMode ?? 'play') === 'play' && m.catId !== null && m.origin === 'stream') return false;
    return true;
  });
  const intentSnapshot = buildAgentIntentSnapshot(relevant, currentUserMessageId);
  const intentSnapshotText = formatAgentIntentSnapshot(intentSnapshot);

  // F35 fix: detect when the current message was present but filtered out by visibility
  // (e.g. whisper not intended for this cat). Must NOT fallback-inject in that case.
  // Computed on `unseen` — independent of budget cap (砚砚 review: don't mix budget and visibility semantics).
  const currentMessageFilteredOut = Boolean(
    currentUserMessageId &&
      !relevant.some((m) => m.id === currentUserMessageId) &&
      unseen.some((m) => m.id === currentUserMessageId),
  );

  // F148 Phase F (KD-7): Navigation context — injected on ALL paths (cold + warm)
  // P1 fix: extract baton from unseen (pre-stream-filter) so cat→cat @ mentions via stream are visible
  const batonCandidates = unseen.filter(
    (m) => (m.userId !== 'system' || m.catId !== null) && m.origin !== 'briefing' && canViewMessage(m, viewer),
  );
  const baton = extractBatonContext(batonCandidates, catId);
  let activeTasks: import('./navigation-context.js').TaskSummary[] = [];
  let allThreadTasks: import('./artifact-tracking.js').ArtifactExtractionInput['prTasks'] = [];
  if (deps.taskStore) {
    try {
      const tasks = await Promise.resolve(deps.taskStore.listByThread(threadId));
      activeTasks = summarizeActiveTasks(tasks);
      allThreadTasks = tasks;
    } catch {
      // fail-open: tasks stay empty
    }
  }

  const recentArtifacts = extractRecentArtifacts({
    filesTouched: options?.recentFilesTouched ?? [],
    prTasks: allThreadTasks,
    catId,
  });

  // G1→G2 bridge: read stored ledger from threadMemory to merge with current-invocation artifacts
  let storedLedgerArtifacts: import('./artifact-tracking.js').RecentArtifact[] = [];
  const threadStore = deps.invocationDeps.threadStore;
  if (threadStore) {
    try {
      const mem = await Promise.resolve(threadStore.getThreadMemory(threadId));
      if (mem && Array.isArray(mem.recentArtifacts) && mem.recentArtifacts.length > 0) {
        storedLedgerArtifacts = mem.recentArtifacts as import('./artifact-tracking.js').RecentArtifact[];
      }
    } catch {
      // fail-open: ranking degrades to current-invocation only
    }
  }
  const mergedLedger = mergeLedger(storedLedgerArtifacts, recentArtifacts);

  const rankedSources = rankArtifactSources(
    mergedLedger,
    allThreadTasks.map((t) => ({ kind: t.kind, subjectKey: t.subjectKey ?? null, title: t.title, status: t.status })),
    { canonicalFeatureId: options?.canonicalFeatureId, threadTitle: options?.threadTitle },
  );
  const topSource = rankedSources[0] ?? null;
  const bestNextSource = topSource ? `先看 ${topSource.label}: ${topSource.ref}` : undefined;
  const navigationHeader = formatNavigationHeader({
    baton,
    tasks: activeTasks,
    artifacts: recentArtifacts,
    truthSource: topSource ? { label: topSource.label, ref: topSource.ref, provenance: topSource.provenance } : null,
    bestNextSource,
  });

  log.info({
    f148: 'navigation-header',
    threadId,
    catId,
    hasBaton: baton !== null,
    batonFrom: baton?.fromSpeakerDisplay ?? null,
    taskCount: activeTasks.length,
    artifactCount: recentArtifacts.length,
    headerLength: navigationHeader.length,
    unseenCount: unseen.length,
    batonCandidateCount: batonCandidates.length,
  });

  const historyGovernanceEnv = options?.historyGovernanceEnv ?? process.env;
  const threadHistorySummary =
    (options?.historySummaryEnabled ?? isHistorySummaryShadowEnabled(historyGovernanceEnv))
      ? await readThreadHistorySummaryForContext(deps.threadHistorySummaryStore, threadId)
      : undefined;
  const historyGovernanceDecision = resolveHistoryGovernanceDecision({
    threadId,
    catId: catId as string,
    summary: threadHistorySummary,
    historyObservation: options?.historyObservation,
    env: historyGovernanceEnv,
    forceShadow: options?.historySummaryEnabled === true,
  });
  const summaryQuality = validateThreadHistorySummaryQuality({
    summary: threadHistorySummary,
    mode: historyGovernanceDecision.mode,
    historyObservation: options?.historyObservation,
    recentMessages: relevant,
    recentMessageLimit: historyGovernanceDecision.recentMessageLimit,
  });
  const missingActiveSummary = !threadHistorySummary
    ? wouldActivateSummaryIfAvailable({
        threadId,
        catId: catId as string,
        historyObservation: options?.historyObservation,
        env: historyGovernanceEnv,
      })
    : false;
  const historyGovernanceQualityIssues = missingActiveSummary
    ? (['empty_summary'] as const)
    : summaryQuality.issues;
  const historyGovernanceDegraded = missingActiveSummary || !summaryQuality.ok;
  const effectiveHistoryGovernanceDecision = historyGovernanceDegraded
    ? modeAfterSummaryQualityFailure(historyGovernanceDecision, options?.historyObservation)
    : historyGovernanceDecision;
  if (historyGovernanceDegraded) {
    clearActiveSummaryWatermark(threadId, catId as string);
    log.warn(
      { threadId, catId, issues: historyGovernanceQualityIssues, mode: historyGovernanceDecision.mode },
      'history governance summary quality gate failed; falling back',
    );
  }
  const includedThreadHistorySummary =
    effectiveHistoryGovernanceDecision.mode === 'summary-active' && threadHistorySummary
      ? ({ ...threadHistorySummary, mode: 'summary-active' as const } satisfies FormattedThreadHistorySummary)
      : effectiveHistoryGovernanceDecision.mode === 'shadow-summary'
        ? threadHistorySummary
        : undefined;

  // F148: Smart window — cold mention detection
  // P1-review: short-circuit on count first — avoid O(n) tokenize when count already triggers
  const hcConfig =
    effectiveHistoryGovernanceDecision.mode === 'summary-active' && effectiveHistoryGovernanceDecision.recentMessageLimit
      ? {
          ...DEFAULT_HIERARCHICAL_CONTEXT,
          maxBurstMessages: effectiveHistoryGovernanceDecision.recentMessageLimit,
          minBurstMessages: Math.min(
            DEFAULT_HIERARCHICAL_CONTEXT.minBurstMessages,
            effectiveHistoryGovernanceDecision.recentMessageLimit,
          ),
        }
      : DEFAULT_HIERARCHICAL_CONTEXT;
  const countTrigger = relevant.length > hcConfig.coldMentionThreshold;
  // Gap-1: only estimate tokens when count doesn't trigger (the "few but fat" path)
  const tokenTrigger =
    !countTrigger &&
    relevant.reduce((sum, m) => sum + estimateTokens(m.content), 0) > hcConfig.coldMentionTokenThreshold;
  const isColdMention = countTrigger || tokenTrigger;

  // F148 OQ-3 telemetry: warm/cold path decision
  log.info({
    f148: 'path-decision',
    threadId,
    catId,
    messageCount: relevant.length,
    isColdMention,
    trigger: countTrigger ? 'count' : tokenTrigger ? 'token' : 'none',
    thresholds: { count: hcConfig.coldMentionThreshold, token: hcConfig.coldMentionTokenThreshold },
  });

  if (isColdMention) {
    return assembleSmartWindowContext(
      deps,
      relevant,
      catId,
      threadId,
      currentUserMessageId,
      currentMessageFilteredOut,
      hcConfig,
      cursor,
      options,
      navigationHeader,
      intentSnapshot,
      intentSnapshotText,
      baton,
      activeTasks,
      recentArtifacts,
      rankedSources,
      storedLedgerArtifacts,
      includedThreadHistorySummary,
      historyGovernanceDegraded,
      historyGovernanceQualityIssues,
    );
  }

  // --- Warm path: existing behavior unchanged ---

  // GAP-1: Unconditional budget cap — protects both first-time cats (cursor=undefined)
  // and stale cursor scenarios where large unseen batches accumulate.
  const budget = options?.contextBudget ?? getCatContextBudget(catId as string);
  const maxRecentMessages =
    effectiveHistoryGovernanceDecision.mode === 'summary-active' && effectiveHistoryGovernanceDecision.recentMessageLimit
      ? Math.min(budget.maxMessages, effectiveHistoryGovernanceDecision.recentMessageLimit)
      : budget.maxMessages;
  const wasCapped = relevant.length > maxRecentMessages;
  const capped = maxRecentMessages <= 0 ? [] : wasCapped ? relevant.slice(-maxRecentMessages) : relevant;

  // Metadata must be based on the FINAL capped set, not pre-cap `relevant`
  const includesCurrentUserMessage = Boolean(currentUserMessageId && capped.some((m) => m.id === currentUserMessageId));

  if (capped.length === 0) {
    const contextText = [navigationHeader, intentSnapshotText].filter(Boolean).join('\n');
    return cursor
      ? {
          contextText,
          boundaryId: cursor,
          includedHistoryCount: 0,
          includesCurrentUserMessage,
          currentMessageFilteredOut,
          navigationHeader,
          historyGovernanceDegraded,
          historyGovernanceQualityIssues,
          intentSnapshot,
        }
      : {
          contextText,
          includedHistoryCount: 0,
          includesCurrentUserMessage,
          currentMessageFilteredOut,
          navigationHeader,
          historyGovernanceDegraded,
          historyGovernanceQualityIssues,
          intentSnapshot,
        };
  }

  const truncateLimit = budget.maxContentLengthPerMsg;
  const lines = capped.map((m) => {
    // F22: Digest rich blocks into compact summaries for context
    const contentWithDigest = digestRichBlocks(m);
    const cleanContent = sanitizeInjectedContent(contentWithDigest);
    const normalized: StoredMessage = cleanContent === m.content ? m : { ...m, content: cleanContent };
    const rendered = formatMessage(normalized, { truncate: truncateLimit });
    return `[${m.id}] ${rendered}`;
  });

  // 第二刀: Aggregate token budget — trim oldest lines until within effective token limit.
  // A+ fix: routing layer can pass effectiveMaxContextTokens (= maxPromptTokens minus system parts)
  // to prevent the assembled context + system prompt from exceeding the model's input limit.
  const effectiveTokenBudget = options?.effectiveMaxContextTokens ?? budget.maxContextTokens;

  // effectiveMaxContextTokens === 0 can mean two different things:
  // - minimal toolPolicy intentionally disables history context (maxContextTokens=0)
  // - system parts actually exhausted the prompt budget while history was allowed
  // Only the second case should warn the user.
  if (effectiveTokenBudget <= 0) {
    const intentionalNoContext = budget.maxContextTokens <= 0;
    const zeroBudgetDegradation = intentionalNoContext
      ? undefined
      : `⚠️ 增量上下文预算耗尽: 系统提示已占满 prompt 预算，${capped.length} 条未读消息全部丢弃`;
    const zeroBoundaryId = capped[capped.length - 1]?.id;
    return {
      contextText: [navigationHeader, intentSnapshotText].filter(Boolean).join('\n'),
      boundaryId: zeroBoundaryId,
      includedHistoryCount: 0,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: zeroBudgetDegradation,
      navigationHeader,
      historyGovernanceDegraded,
      historyGovernanceQualityIssues,
      intentSnapshot,
    };
  }

  let tokenTrimmed = false;
  let tokenTrimStart = 0;
  if (effectiveTokenBudget > 0) {
    const perLineTokens = lines.map((l) => estimateTokens(l));
    const totalTokens = perLineTokens.reduce((a, b) => a + b, 0);
    if (totalTokens > effectiveTokenBudget) {
      tokenTrimmed = true;
      // Scan from oldest: accumulate tokens to drop until remainder fits budget
      let dropTokens = 0;
      for (let i = 0; i < perLineTokens.length - 1; i++) {
        dropTokens += perLineTokens[i];
        if (totalTokens - dropTokens <= effectiveTokenBudget) {
          tokenTrimStart = i + 1;
          break;
        }
      }
      if (totalTokens - dropTokens > effectiveTokenBudget) {
        tokenTrimStart = perLineTokens.length - 1;
      }
    }
  }

  let includedHistorySummary = includedThreadHistorySummary;
  let historySummaryText = includedHistorySummary?.text ?? '';
  let finalLines = tokenTrimmed ? lines.slice(tokenTrimStart) : lines;
  const finalCapped = tokenTrimmed ? capped.slice(tokenTrimStart) : capped;

  if (historySummaryText && estimateTokens([historySummaryText, ...finalLines].join('\n')) > effectiveTokenBudget) {
    historySummaryText = '';
    includedHistorySummary = undefined;
  }

  // Recompute metadata on FINAL post-token-trim set
  const finalIncludesCurrentUserMessage = tokenTrimmed
    ? Boolean(currentUserMessageId && finalCapped.some((m) => m.id === currentUserMessageId))
    : includesCurrentUserMessage;

  if (finalCapped.length === 0) {
    const contextText = [navigationHeader, intentSnapshotText].filter(Boolean).join('\n');
    return cursor
      ? {
          contextText,
          boundaryId: cursor,
          includedHistoryCount: 0,
          includesCurrentUserMessage: false,
          currentMessageFilteredOut,
          navigationHeader,
          historyGovernanceDegraded,
          historyGovernanceQualityIssues,
          intentSnapshot,
        }
      : {
          contextText,
          includedHistoryCount: 0,
          includesCurrentUserMessage: false,
          currentMessageFilteredOut,
          navigationHeader,
          historyGovernanceDegraded,
          historyGovernanceQualityIssues,
          intentSnapshot,
        };
  }

  let degradation: string | undefined;
  if (wasCapped && tokenTrimmed) {
    degradation = `⚠️ 增量上下文已截断: 未读消息 ${relevant.length} 条经 maxMessages(${maxRecentMessages}) 和 token 预算(${effectiveTokenBudget}) 双重截断，已保留最近 ${finalCapped.length} 条`;
  } else if (wasCapped) {
    degradation = `⚠️ 增量上下文已截断: 未读消息 ${relevant.length} 条超出预算 ${maxRecentMessages}，已保留最近 ${finalCapped.length} 条`;
  } else if (tokenTrimmed) {
    degradation = `⚠️ 增量上下文 token 预算截断: ${capped.length} 条消息超出 token 预算(${effectiveTokenBudget})，已保留最近 ${finalCapped.length} 条`;
  }

  const boundaryId = finalCapped[finalCapped.length - 1]?.id;
  const contextHeader = [navigationHeader, intentSnapshotText].filter(Boolean).join('\n');
  const historyRecallSmokeText =
    includedHistorySummary?.mode === 'summary-active' ? formatHistoryRecallSmoke() : '';
  const historySummarySection = historySummaryText
    ? [historySummaryText, historyRecallSmokeText, '[Recent Messages]'].filter(Boolean).join('\n')
    : '';
  return {
    contextText: [
      contextHeader,
      historySummarySection,
      `[对话历史增量 - 未发送过 ${finalCapped.length} 条]\n${finalLines.join('\n')}\n[/对话历史]`,
    ]
      .filter(Boolean)
      .join('\n'),
    boundaryId,
    includedHistoryCount: finalCapped.length,
    includesCurrentUserMessage: finalIncludesCurrentUserMessage,
    currentMessageFilteredOut,
    degradation,
    navigationHeader,
    ...(includedHistorySummary ? { historySummary: includedHistorySummary } : {}),
    historyGovernanceDegraded,
    historyGovernanceQualityIssues,
    intentSnapshot,
  };
}

/**
 * F148: Smart window path for cold-mention context assembly.
 * Burst detection → tombstone → evidence recall → tool scrub → compact context.
 */
async function assembleSmartWindowContext(
  deps: RouteStrategyDeps,
  relevant: StoredMessage[],
  catId: CatId,
  threadId: string,
  currentUserMessageId: string | undefined,
  currentMessageFilteredOut: boolean,
  hcConfig: import('../../../../../config/hierarchical-context-config.js').HierarchicalContextConfig,
  _cursor: string | undefined,
  options: IncrementalContextOptions | undefined,
  navigationHeader: string,
  intentSnapshot: AgentIntentSnapshot | undefined,
  intentSnapshotText: string,
  baton: import('./navigation-context.js').BatonContext | null,
  activeTasks: import('./navigation-context.js').TaskSummary[],
  recentArtifacts: import('./artifact-tracking.js').RecentArtifact[],
  rankedSources: import('./source-ranking.js').RankedSource[],
  preReadStoredArtifacts: import('./artifact-tracking.js').RecentArtifact[],
  threadHistorySummary: FormattedThreadHistorySummary | undefined,
  historyGovernanceDegraded: boolean,
  historyGovernanceQualityIssues: readonly HistorySummaryQualityIssue[],
): Promise<IncrementalContextResult> {
  const budget = options?.contextBudget ?? getCatContextBudget(catId as string);
  const truncateLimit = budget.maxContentLengthPerMsg;

  // 1. Burst detection
  const { burst, omitted } = detectRecentBurst(relevant, hcConfig);

  // F148 OQ-1 telemetry: burst detection stats
  const actualGapMs =
    burst.length > 0 && omitted.length > 0 ? burst[0].timestamp - omitted[omitted.length - 1].timestamp : null;
  log.info({
    f148: 'burst-stats',
    threadId,
    catId,
    totalMessages: relevant.length,
    burstCount: burst.length,
    omittedCount: omitted.length,
    actualGapMs,
    configuredGapMs: hcConfig.burstSilenceGapMs,
  });

  // 2. Thread title for tombstone + evidence (fail-open like recallEvidence)
  const threadStore = deps.invocationDeps.threadStore;
  let threadTitle = '';
  if (threadStore) {
    try {
      threadTitle = (await Promise.resolve(threadStore.get(threadId)))?.title ?? '';
    } catch {
      // fail-open: threadTitle stays empty, tombstone/evidence degrade gracefully
    }
  }

  // 3. Sanitize omitted content once (before tombstone keyword extraction + anchor formatting)
  const sanitizedOmitted = omitted.map((m) => ({
    ...m,
    content: sanitizeInjectedContent(m.content),
  }));

  // 3.1 Tombstone (uses sanitized content for keyword extraction)
  const tombstone = buildTombstone(sanitizedOmitted, threadTitle, hcConfig, threadId);
  const tombstoneText = tombstone ? formatTombstone(tombstone) : '';

  // 3.5 Phase C: Anchor extraction from omitted messages
  const currentMsgText = currentUserMessageId
    ? (burst.find((m) => m.id === currentUserMessageId)?.content.slice(0, 200) ?? '')
    : '';
  const compositeQueryTerms = [threadTitle, currentMsgText]
    .concat(
      burst
        .filter((m) => m.catId === null && m.userId !== 'system')
        .slice(-2)
        .map((m) => m.content.slice(0, 200)),
    )
    .join(' ')
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= 3);
  const anchors = selectAnchors(sanitizedOmitted, compositeQueryTerms, hcConfig.maxAnchors);
  const anchorLines = formatAnchors(anchors, truncateLimit);

  // 3.7 Phase D: Fetch thread memory (fail-open)
  let threadMemorySummary = '';
  const storedFileArtifacts = preReadStoredArtifacts;
  let threadMemoryMeta: {
    available: boolean;
    sessionsIncorporated: number;
    decisions?: string[];
    openQuestions?: string[];
  } | null = null;
  if (threadStore) {
    try {
      const mem = await Promise.resolve(threadStore.getThreadMemory(threadId));
      if (mem) {
        let summary = sanitizeInjectedContent(mem.summary);
        // Trim to maxThreadMemoryTokens by dropping oldest lines
        const lines = summary.split('\n');
        while (lines.length > 1 && estimateTokens(lines.join('\n')) > hcConfig.maxThreadMemoryTokens) {
          lines.shift();
        }
        summary = lines.join('\n');
        // Hard-cap: if remaining text still exceeds budget, binary-search truncate by tokens
        if (estimateTokens(summary) > hcConfig.maxThreadMemoryTokens) {
          let lo = 0;
          let hi = summary.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (estimateTokens(summary.slice(0, mid)) <= hcConfig.maxThreadMemoryTokens) lo = mid;
            else hi = mid - 1;
          }
          summary = summary.slice(0, lo) + '…';
        }
        threadMemorySummary = summary;
        // storedFileArtifacts already pre-read via preReadStoredArtifacts (G1→G2 bridge)
        threadMemoryMeta = {
          available: true,
          sessionsIncorporated: mem.sessionsIncorporated,
          ...(Array.isArray(mem.decisions) && mem.decisions.length ? { decisions: mem.decisions } : {}),
          ...(Array.isArray(mem.openQuestions) && mem.openQuestions.length ? { openQuestions: mem.openQuestions } : {}),
        };
      }
    } catch {
      // fail-open: threadMemory stays empty
    }
  }

  // 3.8 Evidence recall (fail-open) — must run before coverage map so hints are populated
  const currentMsg = currentUserMessageId ? burst.find((m) => m.id === currentUserMessageId) : undefined;
  const nonSystemRecent = burst.filter((m) => m.catId === null && m.userId !== 'system').slice(-2);
  const evidenceLines = await recallEvidence(
    deps.evidenceStore,
    threadTitle,
    currentMsg?.content ?? '',
    nonSystemRecent,
    hcConfig,
  );

  // 3.9 Phase D: Build coverage map (AC-D2) — VG-1: only evidence recall titles (not tombstone search hints)
  const participants = [...new Set(omitted.map((m) => m.catId ?? m.userId).filter(Boolean))] as string[];
  const retrievalHints = evidenceLines.map((line) => {
    const match = line.match(/^\[Evidence:\s*(.+?)\]/);
    return match ? match[1] : line.slice(0, 80);
  });
  const coverageMap = buildCoverageMap({
    omitted: {
      count: omitted.length,
      from: omitted[0]?.timestamp ?? 0,
      to: omitted[omitted.length - 1]?.timestamp ?? 0,
      participants,
    },
    burst: {
      count: burst.length,
      from: burst[0]?.timestamp ?? 0,
      to: burst[burst.length - 1]?.timestamp ?? 0,
    },
    anchorIds: anchors.map((a) => a.message.id),
    threadMemory: threadMemoryMeta,
    retrievalHints,
    searchSuggestions: tombstone?.retrievalHints ?? [],
  });
  const coverageMapText = `[Context Coverage Map]\n${JSON.stringify(coverageMap)}`;
  const threadMemoryText = threadMemorySummary
    ? `[Thread Memory: ${threadMemoryMeta?.sessionsIncorporated ?? 0} sessions]\n${threadMemorySummary}`
    : '';

  // 5. Tool payload scrub on burst
  const scrubbedBurst = scrubToolPayloads(burst);

  // 6. Format burst messages
  const burstLines = scrubbedBurst.map((m) => {
    const contentWithDigest = digestRichBlocks(m);
    const cleanContent = sanitizeInjectedContent(contentWithDigest);
    const normalized: StoredMessage = cleanContent === m.content ? m : { ...m, content: cleanContent };
    const rendered = formatMessage(normalized, { truncate: truncateLimit });
    return `[${m.id}] ${rendered}`;
  });

  // 7. Respect effectiveMaxContextTokens (same as warm path)
  const effectiveTokenBudget = options?.effectiveMaxContextTokens ?? budget.maxContextTokens;
  const boundaryId = relevant[relevant.length - 1]?.id;

  if (effectiveTokenBudget <= 0) {
    const intentionalNoContext = budget.maxContextTokens <= 0;
    return {
      contextText: [navigationHeader, intentSnapshotText].filter(Boolean).join('\n'),
      boundaryId,
      includedHistoryCount: 0,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: intentionalNoContext ? undefined : `⚠️ 增量上下文预算耗尽: 系统提示已占满 prompt 预算`,
      historyGovernanceDegraded,
      historyGovernanceQualityIssues,
      intentSnapshot,
    };
  }

  // Token trim with graduated degradation:
  // evidence → coverageMap+threadMemory → anchors → tombstone → burst
  let finalBurstLines = burstLines;
  let finalBurstMsgs = scrubbedBurst;
  const finalEvidenceLines = [...evidenceLines];
  const finalAnchorLines = [...anchorLines];
  const anchorScores = anchors.map((a) => a.score);
  let finalTombstoneText = tombstoneText;
  let finalCoverageMapText = coverageMapText;
  let finalThreadMemoryText = threadMemoryText;
  let includedHistorySummary = threadHistorySummary;
  let finalThreadHistorySummaryText = includedHistorySummary?.text ?? '';
  let tokenDegradation: string | undefined;

  const totalTokens = () =>
    estimateTokens(
      [
        finalThreadHistorySummaryText,
        finalCoverageMapText,
        finalThreadMemoryText,
        finalTombstoneText,
        ...finalAnchorLines,
        ...finalEvidenceLines,
        ...finalBurstLines,
      ]
        .filter(Boolean)
        .join('\n'),
    );

  if (totalTokens() > effectiveTokenBudget) {
    if (finalThreadHistorySummaryText) {
      finalThreadHistorySummaryText = '';
      includedHistorySummary = undefined;
    }

    // Stage 1: Drop evidence lines from oldest
    while (finalEvidenceLines.length > 0 && totalTokens() > effectiveTokenBudget) {
      finalEvidenceLines.shift();
    }

    // Stage 1.3: Drop coverage map + thread memory together
    if (totalTokens() > effectiveTokenBudget) {
      finalCoverageMapText = '';
      finalThreadMemoryText = '';
    }

    // Stage 1.5: Drop anchors by lowest score
    while (finalAnchorLines.length > 0 && totalTokens() > effectiveTokenBudget) {
      let minIdx = 0;
      for (let i = 1; i < anchorScores.length; i++) {
        if (anchorScores[i] < anchorScores[minIdx]) minIdx = i;
      }
      finalAnchorLines.splice(minIdx, 1);
      anchorScores.splice(minIdx, 1);
    }

    // Stage 2: Drop tombstone
    if (totalTokens() > effectiveTokenBudget && finalTombstoneText) {
      finalTombstoneText = '';
    }

    // Stage 3: Trim burst from oldest
    let keep = finalBurstLines.length;
    while (keep > 1 && totalTokens() > effectiveTokenBudget) {
      finalBurstLines = burstLines.slice(-keep + 1);
      finalBurstMsgs = scrubbedBurst.slice(-keep + 1);
      keep--;
    }

    // Stage 4: Hard cap — if envelope + 1 burst still exceeds budget, return empty
    if (totalTokens() > effectiveTokenBudget) {
      return {
        contextText: [navigationHeader, intentSnapshotText].filter(Boolean).join('\n'),
        boundaryId,
        includedHistoryCount: 0,
        includesCurrentUserMessage: false,
        currentMessageFilteredOut,
        degradation: `⚠️ 增量上下文 token 预算截断: 预算不足以容纳最小上下文 (${effectiveTokenBudget} tokens)`,
        historyGovernanceDegraded,
        historyGovernanceQualityIssues,
        intentSnapshot,
      };
    }

    tokenDegradation = `⚠️ 增量上下文 token 预算截断: evidence ${evidenceLines.length} → ${finalEvidenceLines.length}, anchors ${anchorLines.length} → ${finalAnchorLines.length}, burst ${burstLines.length} → ${finalBurstLines.length}`;
  }

  // 8. Assemble context packet
  const sections: string[] = [];
  if (finalCoverageMapText) sections.push(finalCoverageMapText);
  if (finalThreadMemoryText) sections.push(finalThreadMemoryText);
  if (finalTombstoneText) sections.push(finalTombstoneText);
  if (finalAnchorLines.length > 0) sections.push(...finalAnchorLines);
  if (finalEvidenceLines.length > 0) {
    sections.push(`[Related evidence]\n${finalEvidenceLines.join('\n')}\n[/Related evidence]`);
  }
  sections.push(...finalBurstLines);

  const includesCurrentUserMessage = Boolean(
    currentUserMessageId && finalBurstMsgs.some((m) => m.id === currentUserMessageId),
  );

  const contextHeader = [navigationHeader, intentSnapshotText].filter(Boolean).join('\n');
  const historyRecallSmokeText =
    includedHistorySummary?.mode === 'summary-active' ? formatHistoryRecallSmoke() : '';
  const historySummarySection = finalThreadHistorySummaryText
    ? [finalThreadHistorySummaryText, historyRecallSmokeText, '[Recent Messages]'].filter(Boolean).join('\n')
    : '';
  const contextText =
    sections.length > 0
      ? [
          contextHeader,
          historySummarySection,
          `[对话历史增量 - 智能窗口: ${omitted.length} 条已摘要, ${finalBurstMsgs.length} 条详细]\n${sections.join('\n')}\n[/对话历史]`,
        ]
          .filter(Boolean)
          .join('\n')
      : contextHeader;

  // Final hard cap: envelope overhead may push total over budget
  if (contextText && estimateTokens(contextText) > effectiveTokenBudget) {
    return {
      contextText: [navigationHeader, intentSnapshotText].filter(Boolean).join('\n'),
      boundaryId,
      includedHistoryCount: 0,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: `⚠️ 增量上下文 token 预算截断: 预算不足以容纳最小上下文 (${effectiveTokenBudget} tokens)`,
      historyGovernanceDegraded,
      historyGovernanceQualityIssues,
      intentSnapshot,
    };
  }

  return {
    contextText,
    boundaryId,
    includedHistoryCount: finalBurstMsgs.length,
    includesCurrentUserMessage,
    currentMessageFilteredOut,
    degradation: tokenDegradation,
    ...(includedHistorySummary ? { historySummary: includedHistorySummary } : {}),
    historyGovernanceDegraded,
    historyGovernanceQualityIssues,
    coverageMap,
    briefingContext: {
      ...(threadMemorySummary ? { threadMemorySummary } : {}),
      ...(finalAnchorLines.length > 0 ? { anchorSummaries: finalAnchorLines } : {}),
      ...(baton ? { baton } : {}),
      ...(activeTasks.length > 0 ? { activeTasks } : {}),
      ...(() => {
        const merged = mergeLedger(storedFileArtifacts, recentArtifacts);
        return merged.length > 0 ? { recentArtifacts: merged } : {};
      })(),
      ...(rankedSources.length > 0 ? { rankedSources } : {}),
    },
    navigationHeader,
    intentSnapshot,
  };
}
