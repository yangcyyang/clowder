import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { evaluateClaudeBudgetGate } = await import(
  '../dist/domains/cats/services/agents/invocation/claude-budget-gate.js'
);

function budget(overrides = {}) {
  return {
    surface: 'thread',
    threadId: 'thread-1',
    toolPolicy: 'standard',
    toolPolicySource: 'agent-default',
    mode: 'serial',
    estimatedTokens: 12_000,
    historyMessages: 24,
    loadedBlocks: [],
    skippedBlocks: [],
    governanceTier: 'core',
    governanceEstimatedTokens: 0,
    governanceSourceInjected: false,
    usesFullHistory: false,
    maxPromptTokens: 200_000,
    maxContextTokens: 12_000,
    ...overrides,
  };
}

describe('Claude budget gate', () => {
  test('drops resume for Claude when thread history is over budget', () => {
    const decision = evaluateClaudeBudgetGate({
      provider: 'anthropic',
      hasResumeSession: true,
      contextBudget: budget({ historyFullTokens: 180_000, historyBudgetRatio: 0.9 }),
      env: {},
    });

    assert.equal(decision.action, 'drop-resume');
    assert.equal(decision.reason, 'history_over_budget');
  });

  test('blocks Claude when visible prompt is already oversized', () => {
    const decision = evaluateClaudeBudgetGate({
      provider: 'anthropic',
      hasResumeSession: false,
      contextBudget: budget({ estimatedTokens: 250_000 }),
      env: {},
    });

    assert.equal(decision.action, 'block');
    assert.equal(decision.reason, 'visible_prompt_over_budget');
  });

  test('does not gate non-Claude providers', () => {
    const decision = evaluateClaudeBudgetGate({
      provider: 'openai',
      hasResumeSession: true,
      contextBudget: budget({ estimatedTokens: 500_000, historyFullTokens: 500_000, historyBudgetRatio: 2 }),
      env: {},
    });

    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'non_claude');
  });

  test('can be disabled by env', () => {
    const decision = evaluateClaudeBudgetGate({
      provider: 'anthropic',
      hasResumeSession: true,
      contextBudget: budget({ estimatedTokens: 500_000, historyFullTokens: 500_000, historyBudgetRatio: 2 }),
      env: { CAT_CAFE_CLAUDE_BUDGET_GATE: '0' },
    });

    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'disabled');
  });
});
