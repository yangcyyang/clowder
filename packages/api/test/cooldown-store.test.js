/**
 * CooldownStore (in-memory) tests — 理智线 T6 (task #388)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CooldownStore } from '../dist/domains/cats/services/stores/ports/CooldownStore.js';

describe('CooldownStore (in-memory)', () => {
  it('set() creates a new cooldown record', () => {
    const store = new CooldownStore();
    const record = store.set({
      catId: 'opus',
      until: 1_000_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: "You've hit your session limit · resets 3:30am (Asia/Shanghai)",
    });
    assert.equal(record.catId, 'opus');
    assert.equal(record.until, 1_000_000);
    assert.equal(record.reason, 'usage_limit');
    assert.equal(store.get('opus').until, 1_000_000);
  });

  it('set() max-merges: a shorter re-detection does not shorten the existing cooldown clock', () => {
    const store = new CooldownStore();
    store.set({ catId: 'opus', until: 2_000_000, reason: 'usage_limit', source: 'anthropic', originalError: 'x' });
    const second = store.set({
      catId: 'opus',
      until: 1_500_000, // shorter than existing — must NOT shorten
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'y',
    });
    assert.equal(second.until, 2_000_000, 'until must be max(existing, new), not overwritten shorter');
  });

  it('set() max-merges: a longer re-detection extends the cooldown clock', () => {
    const store = new CooldownStore();
    store.set({ catId: 'opus', until: 1_000_000, reason: 'usage_limit', source: 'anthropic', originalError: 'x' });
    const second = store.set({
      catId: 'opus',
      until: 3_000_000,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: 'y',
    });
    assert.equal(second.until, 3_000_000);
  });

  it('originalError is truncated to 200 chars', () => {
    const store = new CooldownStore();
    const longError = 'E'.repeat(500);
    const record = store.set({
      catId: 'opus',
      until: 1,
      reason: 'usage_limit',
      source: 'anthropic',
      originalError: longError,
    });
    assert.ok(record.originalError.length <= 201, `expected <=201 chars, got ${record.originalError.length}`);
  });

  it('get() returns null for a cat with no cooldown', () => {
    const store = new CooldownStore();
    assert.equal(store.get('opus'), null);
  });

  it('clear() removes the cooldown', () => {
    const store = new CooldownStore();
    store.set({ catId: 'opus', until: 1, reason: 'usage_limit', source: 'anthropic', originalError: 'x' });
    store.clear('opus');
    assert.equal(store.get('opus'), null);
  });

  it('listActive() returns all tracked cooldowns', () => {
    const store = new CooldownStore();
    store.set({ catId: 'opus', until: 1, reason: 'usage_limit', source: 'anthropic', originalError: 'x' });
    store.set({ catId: 'codex', until: 2, reason: 'usage_limit', source: 'openai', originalError: 'y' });
    const active = store.listActive();
    assert.equal(active.length, 2);
    assert.deepEqual(active.map((r) => r.catId).sort(), ['codex', 'opus']);
  });
});
