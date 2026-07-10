import type { RuntimeContextBudgetSnapshot } from '../routing/route-helpers.js';

export type ClaudeBudgetGateAction = 'allow' | 'drop-resume' | 'block';

export interface ClaudeBudgetGateDecision {
  action: ClaudeBudgetGateAction;
  reason?: 'disabled' | 'non_claude' | 'visible_prompt_over_budget' | 'history_over_budget';
  estimatedTokens?: number;
  thresholdTokens?: number;
  historyFullTokens?: number;
  historyBudgetRatio?: number;
  thresholdRatio?: number;
}

export interface ClaudeBudgetGateInput {
  provider?: string | null | undefined;
  contextBudget?: RuntimeContextBudgetSnapshot | undefined;
  hasResumeSession?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

const DEFAULT_VISIBLE_PROMPT_HARD_LIMIT = 200_000;
const DEFAULT_RESUME_HISTORY_TOKEN_LIMIT = 100_000;
const DEFAULT_RESUME_HISTORY_RATIO_LIMIT = 0.8;

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

function isDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return /^(0|false|off|no|disabled)$/i.test(value);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isClaudeProvider(provider: string | null | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === 'anthropic';
}

/**
 * Prevent runaway Claude cost before the CLI is launched.
 *
 * The expensive failure mode is usually hidden in `--resume`: even when the new
 * prompt is small, Claude can reload a huge prior session. For high-history
 * threads we therefore drop resume first; if the visible prompt itself is
 * already oversized, we block the invocation entirely.
 */
export function evaluateClaudeBudgetGate(input: ClaudeBudgetGateInput): ClaudeBudgetGateDecision {
  const env = input.env ?? process.env;
  if (isDisabled(envValue(env, 'CAT_CAFE_CLAUDE_BUDGET_GATE'))) {
    return { action: 'allow', reason: 'disabled' };
  }
  if (!isClaudeProvider(input.provider)) {
    return { action: 'allow', reason: 'non_claude' };
  }

  const contextBudget = input.contextBudget;
  const estimatedTokens = Math.max(0, Math.ceil(contextBudget?.estimatedTokens ?? 0));
  const visiblePromptLimit = positiveNumber(
    envValue(env, 'CAT_CAFE_CLAUDE_VISIBLE_PROMPT_HARD_LIMIT'),
    DEFAULT_VISIBLE_PROMPT_HARD_LIMIT,
  );
  if (estimatedTokens >= visiblePromptLimit) {
    return {
      action: 'block',
      reason: 'visible_prompt_over_budget',
      estimatedTokens,
      thresholdTokens: visiblePromptLimit,
    };
  }

  if (!input.hasResumeSession) {
    return { action: 'allow' };
  }

  const historyFullTokens = Math.max(0, Math.ceil(contextBudget?.historyFullTokens ?? 0));
  const historyBudgetRatio = Math.max(0, contextBudget?.historyBudgetRatio ?? 0);
  const historyTokenLimit = positiveNumber(
    envValue(env, 'CAT_CAFE_CLAUDE_RESUME_HISTORY_TOKEN_LIMIT'),
    DEFAULT_RESUME_HISTORY_TOKEN_LIMIT,
  );
  const historyRatioLimit = positiveNumber(
    envValue(env, 'CAT_CAFE_CLAUDE_RESUME_HISTORY_RATIO_LIMIT'),
    DEFAULT_RESUME_HISTORY_RATIO_LIMIT,
  );

  if (historyFullTokens >= historyTokenLimit || historyBudgetRatio >= historyRatioLimit) {
    return {
      action: 'drop-resume',
      reason: 'history_over_budget',
      estimatedTokens,
      historyFullTokens,
      historyBudgetRatio,
      thresholdTokens: historyTokenLimit,
      thresholdRatio: historyRatioLimit,
    };
  }

  return { action: 'allow' };
}
