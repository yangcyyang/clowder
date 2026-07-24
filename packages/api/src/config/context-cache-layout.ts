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
