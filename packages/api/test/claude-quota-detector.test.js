/**
 * claude-quota-detector tests — 理智线 T6 (task #388)
 *
 * Real samples (verified live incidents, see #388 gate report):
 * - "...folder.**You've hit your session limit · resets 3:30am (Asia/Shanghai)**"
 * - "...You've hit your session limit · resets 4:20pm (Asia/Shanghai)"
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectClaudeQuotaSignal } from '../dist/domains/cats/services/agents/providers/claude-quota-detector.js';

describe('detectClaudeQuotaSignal', () => {
  it('matches the real sample (markdown-bold-wrapped, at the tail of a longer reply)', () => {
    const text =
      "帮你更新了 说明 doc.\n\nNow the 说明 doc in the OrbitOS skill folder.**You've hit your session limit · resets 3:30am (Asia/Shanghai)**";
    const signal = detectClaudeQuotaSignal(text, {}, Date.UTC(2026, 5, 29, 10, 0, 0)); // 2026-06-29 10:00 UTC
    assert.ok(signal, 'must match the real captured format');
    assert.equal(signal.errorCode, 'usage_limit');
  });

  it('matches the second real sample (4:20pm, no markdown wrapping)', () => {
    const text = "Error: Claude CLI: CLI 异常退出\nYou've hit your session limit · resets 4:20pm (Asia/Shanghai)";
    const signal = detectClaudeQuotaSignal(text, {}, Date.now());
    assert.ok(signal);
  });

  it('FP SENTINEL: a mid-reply quote/discussion of the phrase (not at the tail) must NOT match', () => {
    const text =
      "You've hit your session limit · resets 3:30am (Asia/Shanghai) — this is the exact phrase we captured as a real sample in msg bfc9be14, useful for the T6 quota detector. Anyway, back to the task: I've updated the doc as requested.";
    const signal = detectClaudeQuotaSignal(text, {}, Date.now());
    assert.equal(signal, undefined, 'a mid-reply citation must not trigger a false cooldown');
  });

  it('FP SENTINEL: phrase appears then more substantial reply continues after it', () => {
    const text =
      "You've hit your session limit · resets 3:30am (Asia/Shanghai)\n\nBut ignoring that, here is the analysis you asked for: the root cause is X, the fix is Y, and I've verified it with tests.";
    const signal = detectClaudeQuotaSignal(text, {}, Date.now());
    assert.equal(signal, undefined, 'notice followed by substantial content is not a real quota hit');
  });

  it('does not match without the exact "·" separator / format', () => {
    const text = "You've hit your session limit, resets around 3:30am Asia/Shanghai";
    const signal = detectClaudeQuotaSignal(text, {}, Date.now());
    assert.equal(signal, undefined);
  });

  it('prefers concurrentResetAtMs (rate_limit_event) over text-parsed time when provided', () => {
    const text = "You've hit your session limit · resets 3:30am (Asia/Shanghai)";
    const concurrentResetAtMs = Date.UTC(2026, 5, 30, 1, 0, 0);
    const signal = detectClaudeQuotaSignal(text, { concurrentResetAtMs }, Date.now());
    assert.ok(signal);
    assert.equal(signal.resetSource, 'rate_limit_event');
    assert.equal(signal.resetAt, concurrentResetAtMs);
  });

  it('text-parse: resolves to TODAY when the target time is still ahead of now (same day)', () => {
    // Asia/Shanghai is UTC+8. now = 2026-06-29 00:00 Shanghai (2026-06-28 16:00 UTC).
    // Target 3:30am Shanghai today is still ahead of now.
    const nowUTC = Date.UTC(2026, 5, 28, 16, 0, 0); // 2026-06-29 00:00 Asia/Shanghai
    const text = "You've hit your session limit · resets 3:30am (Asia/Shanghai)";
    const signal = detectClaudeQuotaSignal(text, {}, nowUTC);
    assert.ok(signal);
    assert.equal(signal.resetSource, 'text_parse');
    const expected = Date.UTC(2026, 5, 28, 19, 30, 0); // 2026-06-29 03:30 Shanghai = 2026-06-28 19:30 UTC
    assert.equal(signal.resetAt, expected);
  });

  it('text-parse: resolves to TOMORROW when the target time has already passed today', () => {
    // now = 2026-06-29 10:00 Shanghai (2026-06-29 02:00 UTC) — 3:30am Shanghai already passed today.
    const nowUTC = Date.UTC(2026, 5, 29, 2, 0, 0);
    const text = "You've hit your session limit · resets 3:30am (Asia/Shanghai)";
    const signal = detectClaudeQuotaSignal(text, {}, nowUTC);
    assert.ok(signal);
    assert.equal(signal.resetSource, 'text_parse');
    const expected = Date.UTC(2026, 5, 29, 19, 30, 0); // 2026-06-30 03:30 Shanghai = 2026-06-29 19:30 UTC
    assert.equal(signal.resetAt, expected);
  });

  it('text-parse: falls back to resetSource=unresolved for an unrecognized timezone (never throws)', () => {
    const text = "You've hit your session limit · resets 3:30am (Not/AZone)";
    const signal = detectClaudeQuotaSignal(text, {}, Date.now());
    assert.ok(signal, 'still recognized as usage_limit even if the timezone cannot be resolved');
    assert.equal(signal.resetSource, 'unresolved');
    assert.equal(signal.resetAt, undefined);
  });

  it('plain unrelated text does not match', () => {
    const signal = detectClaudeQuotaSignal('这是一条正常的回复，跟额度完全无关。', {}, Date.now());
    assert.equal(signal, undefined);
  });
});
