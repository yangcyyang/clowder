import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getSanityLineFallback,
  resolveSanityLine,
  resolveSanityLineDefault,
} from '../dist/types/sanity-line-defaults.js';

describe('理智线 T2 (task #384): resolveSanityLineDefault', () => {
  it('matches gpt-5.6 family to 250K', () => {
    assert.equal(resolveSanityLineDefault('gpt-5.6-sol'), 250_000);
  });

  it('matches fable family to 240K', () => {
    assert.equal(resolveSanityLineDefault('claude-fable-5'), 240_000);
  });

  it('matches opus family to 200K', () => {
    assert.equal(resolveSanityLineDefault('claude-opus-4-8'), 200_000);
  });

  it('matches sonnet family to 200K', () => {
    assert.equal(resolveSanityLineDefault('claude-sonnet-4-6'), 200_000);
  });

  it('matches grok family to 180K', () => {
    assert.equal(resolveSanityLineDefault('grok-4.5'), 180_000);
  });

  it('matches kimi family to 140K', () => {
    assert.equal(resolveSanityLineDefault('kimi-code/kimi-for-coding'), 140_000);
  });

  it('is robust to version-suffix drift (does not require exact model id match)', () => {
    // Real defaultModel strings carry version suffixes that drift over time
    // (e.g. claude-opus-4-8 → claude-opus-4-9); keyword match must survive that.
    assert.equal(resolveSanityLineDefault('claude-opus-4-99-preview'), 200_000);
  });

  it('falls back to 120K for unmatched models', () => {
    assert.equal(resolveSanityLineDefault('gemini-3.1-pro'), getSanityLineFallback());
    assert.equal(resolveSanityLineDefault('z-ai/glm-4.7'), getSanityLineFallback());
  });

  it('falls back to 120K for undefined model', () => {
    assert.equal(resolveSanityLineDefault(undefined), getSanityLineFallback());
  });
});

describe('理智线 T2 (task #384): resolveSanityLine priority order', () => {
  it('prefers explicit variant value over everything else', () => {
    assert.equal(resolveSanityLine(999_000, 555_000, 'claude-opus-4-8'), 999_000);
  });

  it('falls back to breed value when variant value is absent', () => {
    assert.equal(resolveSanityLine(undefined, 555_000, 'claude-opus-4-8'), 555_000);
  });

  it('falls back to model-default table when neither variant nor breed value is set', () => {
    assert.equal(resolveSanityLine(undefined, undefined, 'claude-opus-4-8'), 200_000);
  });

  it('falls back to 120K when nothing resolves', () => {
    assert.equal(resolveSanityLine(undefined, undefined, undefined), 120_000);
  });
});
