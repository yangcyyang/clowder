import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveEffectiveToolPolicy, shouldAutoDowngradeToMinimal } = await import('../dist/config/tool-policy.js');

describe('toolPolicy mature-secretary defaults', () => {
  test('auto-downgrades short/simple standard tasks to minimal', () => {
    assert.equal(shouldAutoDowngradeToMinimal('hi', 'standard'), true);
    assert.equal(resolveEffectiveToolPolicy({ toolPolicy: 'standard' }, '@codex 你好').toolPolicy, 'minimal');
  });

  test('does not auto-downgrade heavy tasks', () => {
    const resolved = resolveEffectiveToolPolicy({ toolPolicy: 'standard' }, '@codex 帮我修复这个 thread 报错');
    assert.equal(resolved.toolPolicy, 'standard');
  });

  test('user override wins over auto downgrade', () => {
    const resolved = resolveEffectiveToolPolicy({ toolPolicy: 'standard' }, '重度工具箱 hi');
    assert.deepEqual(resolved, { toolPolicy: 'full', source: 'user-override' });
  });
});
