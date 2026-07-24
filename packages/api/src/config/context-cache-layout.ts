/**
 * ADR-024: KV-cache friendly context layout — feature flag reader.
 *
 * `CONTEXT_CACHE_LAYOUT` selects the transport assembly path:
 *   - 'v1' (default): current behavior, byte-for-byte unchanged. Zero-risk merge.
 *   - 'v2': four-slot layout [STATIC SYSTEM] → [HISTORY] → [META] → [CURRENT MSG],
 *     with session-writable content (memory / lessons / project / per-turn meta)
 *     relocated to a tail META block so the history prefix stays cacheable.
 *
 * The flag is read per-invocation (not cached) so a Hub env edit + fresh
 * invocation flips layout without a restart. Registered in env-registry.ts.
 */

export type ContextCacheLayout = 'v1' | 'v2';

/**
 * Resolve the active context-cache layout. Only the exact string 'v2' opts in;
 * everything else (unset, 'v1', typos) falls back to the safe v1 path.
 */
export function getContextCacheLayout(env: NodeJS.ProcessEnv = process.env): ContextCacheLayout {
  return env.CONTEXT_CACHE_LAYOUT === 'v2' ? 'v2' : 'v1';
}

/**
 * ADR-024 验证计划 2（金丝雀）：`CONTEXT_CACHE_LAYOUT_CATS` 是逗号分隔的 catId
 * 名单——全局 flag 仍为 v1 时，名单内的猫单独走 v2 布局（灰度 24-48h 用）。
 * 全局 v2 时名单被忽略（全体 v2）。
 */
export function getCanaryCatIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.CONTEXT_CACHE_LAYOUT_CATS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Per-cat layout resolution: global 'v2' wins; otherwise canary-listed cats get
 * 'v2'; everyone else stays on the safe 'v1' path. Sites without a cat identity
 * should keep calling getContextCacheLayout() (global-only semantics).
 */
export function resolveContextCacheLayoutForCat(
  catId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ContextCacheLayout {
  if (getContextCacheLayout(env) === 'v2') return 'v2';
  if (catId && getCanaryCatIds(env).has(catId)) return 'v2';
  return 'v1';
}
