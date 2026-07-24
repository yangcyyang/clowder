// ADR-024 验证计划 2：金丝雀名单 CONTEXT_CACHE_LAYOUT_CATS 的按猫布局解析。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { getContextCacheLayout, getCanaryCatIds, resolveContextCacheLayoutForCat } = await import(
  '../dist/config/context-cache-layout.js'
);

describe('ADR-024 canary cats (CONTEXT_CACHE_LAYOUT_CATS)', () => {
  test('global v1 + empty list → everyone v1', () => {
    const env = {};
    assert.equal(getContextCacheLayout(env), 'v1');
    assert.equal(resolveContextCacheLayoutForCat('kimi', env), 'v1');
    assert.equal(resolveContextCacheLayoutForCat(undefined, env), 'v1');
  });

  test('canary list gives v2 only to listed cats while global stays v1', () => {
    const env = { CONTEXT_CACHE_LAYOUT_CATS: 'kimi' };
    assert.equal(getContextCacheLayout(env), 'v1', 'global flag untouched by the list');
    assert.equal(resolveContextCacheLayoutForCat('kimi', env), 'v2');
    assert.equal(resolveContextCacheLayoutForCat('opus-45', env), 'v1');
    assert.equal(resolveContextCacheLayoutForCat(undefined, env), 'v1');
  });

  test('list parsing: commas, whitespace, empties', () => {
    const ids = getCanaryCatIds({ CONTEXT_CACHE_LAYOUT_CATS: ' kimi, opus-45 ,, ' });
    assert.deepEqual([...ids].sort(), ['kimi', 'opus-45']);
  });

  test('global v2 wins regardless of list', () => {
    const env = { CONTEXT_CACHE_LAYOUT: 'v2', CONTEXT_CACHE_LAYOUT_CATS: '' };
    assert.equal(resolveContextCacheLayoutForCat('anyone', env), 'v2');
    assert.equal(resolveContextCacheLayoutForCat(undefined, env), 'v2');
  });
});
