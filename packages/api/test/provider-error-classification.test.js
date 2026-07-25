/**
 * provider-error-classification.ts tests (batch 3-B, item 2)
 * Maka absorption #4: structured evidence must outrank free-text regex.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('provider-error-classification', () => {
  /** @type {typeof import('../dist/domains/cats/services/agents/invocation/provider-error-classification.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/agents/invocation/provider-error-classification.js');
    assert.ok(mod.classifyProviderError);
    assert.ok(mod.classifyProviderErrorText);
    assert.ok(mod.toTaskFailureClass);
    assert.ok(mod.isAutoRetryEligible);
    assert.ok(mod.AUTO_RETRY_WHITELIST);
  });

  // ─── Structured evidence wins over conflicting/absent text ───

  test('structured aborted flag wins regardless of message text', () => {
    const result = mod.classifyProviderError({ aborted: true, message: 'quota exceeded' });
    assert.equal(result.kind, 'aborted');
    assert.equal(result.evidence, 'structured');
  });

  test('structured httpStatus 429 classifies as quota even with unrelated text', () => {
    const result = mod.classifyProviderError({ httpStatus: 429, message: 'internal server hiccup' });
    assert.equal(result.kind, 'quota');
    assert.equal(result.evidence, 'structured');
  });

  test('structured httpStatus 402 classifies as quota', () => {
    const result = mod.classifyProviderError({ httpStatus: 402 });
    assert.equal(result.kind, 'quota');
    assert.equal(result.evidence, 'structured');
  });

  test('structured nodeErrorCode ECONNRESET classifies as transient_network', () => {
    const result = mod.classifyProviderError({ nodeErrorCode: 'ECONNRESET', message: 'unrelated text' });
    assert.equal(result.kind, 'transient_network');
    assert.equal(result.evidence, 'structured');
  });

  test('structured httpStatus 503 classifies as transient_network', () => {
    const result = mod.classifyProviderError({ httpStatus: 503 });
    assert.equal(result.kind, 'transient_network');
    assert.equal(result.evidence, 'structured');
  });

  test('structured non-zero exitCode with emptyOutput classifies as cli_crash', () => {
    const result = mod.classifyProviderError({ exitCode: 1, signal: null, emptyOutput: true });
    assert.equal(result.kind, 'cli_crash');
    assert.equal(result.evidence, 'structured');
  });

  test('non-zero exitCode with emptyOutput=false (usable output) falls through structured cli_crash tier', () => {
    const result = mod.classifyProviderError({ exitCode: 1, emptyOutput: false, message: 'benign trailing stderr' });
    // Should NOT be classified as cli_crash via the structured tier since output was usable;
    // falls to text tier / agent_error fallback.
    assert.notEqual(result.kind, 'cli_crash');
  });

  test('signal-killed process (SIGKILL) classifies as cli_crash', () => {
    const result = mod.classifyProviderError({ exitCode: null, signal: 'SIGKILL' });
    assert.equal(result.kind, 'cli_crash');
  });

  // ─── Text-tier fallbacks (no structured evidence available) ───

  test('text: AbortError classifies as aborted', () => {
    const result = mod.classifyProviderErrorText('AbortError: The operation was aborted');
    assert.equal(result.kind, 'aborted');
    assert.equal(result.evidence, 'text');
  });

  test('text: user_cancel classifies as aborted', () => {
    const result = mod.classifyProviderErrorText('canceled by user_cancel');
    assert.equal(result.kind, 'aborted');
  });

  test('text: rate limit wording classifies as quota', () => {
    const result = mod.classifyProviderErrorText('Error: rate limit exceeded, too many requests');
    assert.equal(result.kind, 'quota');
    assert.equal(result.evidence, 'text');
  });

  test('text: Chinese quota wording classifies as quota', () => {
    const result = mod.classifyProviderErrorText('今日额度已用尽');
    assert.equal(result.kind, 'quota');
  });

  test('text: context window overflow classifies as context_overflow', () => {
    const result = mod.classifyProviderErrorText('ran out of room in the context window');
    assert.equal(result.kind, 'context_overflow');
  });

  test('text: prompt token limit classifies as context_overflow', () => {
    const result = mod.classifyProviderErrorText('prompt token count of 220000 exceeds the limit of 200000');
    assert.equal(result.kind, 'context_overflow');
  });

  test('text: ECONNRESET wording classifies as transient_network', () => {
    const result = mod.classifyProviderErrorText('Error: connect ECONNRESET 127.0.0.1:443');
    assert.equal(result.kind, 'transient_network');
  });

  test('text: socket hang up classifies as transient_network', () => {
    const result = mod.classifyProviderErrorText('socket hang up');
    assert.equal(result.kind, 'transient_network');
  });

  test('text: CLI abnormal exit message classifies as cli_crash', () => {
    const result = mod.classifyProviderErrorText('CLI 异常退出 (code: 1, signal: none)');
    assert.equal(result.kind, 'cli_crash');
  });

  test('text: unrecognized message falls back to agent_error', () => {
    const result = mod.classifyProviderErrorText('something completely unexpected happened');
    assert.equal(result.kind, 'agent_error');
    assert.equal(result.evidence, 'text');
  });

  test('no evidence at all falls back to agent_error with evidence=none', () => {
    const result = mod.classifyProviderError({});
    assert.equal(result.kind, 'agent_error');
    assert.equal(result.evidence, 'none');
  });

  // ─── Priority order regression: earlier tiers must win over later ones ───

  test('priority: aborted beats quota when both signals present', () => {
    const result = mod.classifyProviderError({ aborted: true, httpStatus: 429 });
    assert.equal(result.kind, 'aborted');
  });

  test('priority: quota (structured) beats network text', () => {
    const result = mod.classifyProviderError({ httpStatus: 429, message: 'ECONNRESET' });
    assert.equal(result.kind, 'quota');
  });

  test('priority: context_overflow text beats cli_crash structured evidence ordering (checked before network/cli tiers)', () => {
    const result = mod.classifyProviderError({ message: 'ran out of room in the context window' });
    assert.equal(result.kind, 'context_overflow');
  });

  // ─── Whitelist + TaskFailureClass mapping ───

  test('AUTO_RETRY_WHITELIST contains exactly transient_network and cli_crash', () => {
    assert.deepEqual([...mod.AUTO_RETRY_WHITELIST].sort(), ['cli_crash', 'transient_network']);
  });

  test('isAutoRetryEligible whitelists only transient_network and cli_crash', () => {
    assert.equal(mod.isAutoRetryEligible('transient_network'), true);
    assert.equal(mod.isAutoRetryEligible('cli_crash'), true);
    assert.equal(mod.isAutoRetryEligible('quota'), false);
    assert.equal(mod.isAutoRetryEligible('aborted'), false);
    assert.equal(mod.isAutoRetryEligible('agent_error'), false);
    assert.equal(mod.isAutoRetryEligible('context_overflow'), false);
  });

  test('toTaskFailureClass mapping table', () => {
    assert.equal(mod.toTaskFailureClass('quota'), 'budget_exhausted');
    assert.equal(mod.toTaskFailureClass('transient_network'), 'infra_error');
    assert.equal(mod.toTaskFailureClass('cli_crash'), 'infra_error');
    assert.equal(mod.toTaskFailureClass('context_overflow'), 'infra_error');
    assert.equal(mod.toTaskFailureClass('aborted'), 'manual_fail');
    assert.equal(mod.toTaskFailureClass('agent_error'), 'agent_error');
  });
});
