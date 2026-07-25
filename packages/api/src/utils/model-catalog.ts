/**
 * Fifth model discovery source: a shared, network-fetched cloud model catalog (models.dev +
 * LiteLLM's model_prices_and_context_window.json). This is the "kept alive" replacement for the
 * hand-maintained `static` allowlists in local-cli-model-probes.ts — those lists only get refreshed
 * when someone edits the source; this catalog reflects whatever the two upstream projects currently
 * know about, without a code change or deploy.
 *
 * Scope: only providers whose model id can be handed directly to the local CLI are supported here —
 * claude (anthropic), codex (openai), gemini (google). kimi/grok/opencode/cursor/opencli use their
 * own alias systems (e.g. `kimi-code/k3`, `xiaomi-mimo/mimo-v2.5-pro`) that don't correspond to any
 * upstream catalog id, so feeding cloud ids into those CLIs would not run — intentionally out of scope.
 *
 * This module only fetches + parses + caches the cloud lists. It has no knowledge of the CLI probe
 * chain; local-cli-probe.ts decides when/whether to call getModelCatalog() and how to merge the
 * result into a given CLI's candidates (see `catalogModels` on ModelChainOptions).
 */

export type ModelCatalogProviderId = 'claude' | 'codex' | 'gemini';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const LITELLM_CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CATALOG_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_HOURS = 24;

/** models.dev groups models under this provider key per target CLI family. */
const MODELS_DEV_PROVIDER_KEYS: Record<ModelCatalogProviderId, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

/** LiteLLM tags each flat model id with a `litellm_provider` value; this is the target mapping. */
const LITELLM_PROVIDER_VALUES: Record<ModelCatalogProviderId, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'gemini',
};

/**
 * Family prefix filter, applied after merging both sources — prevents cross-family "串味" (e.g. a
 * gemini `veo-*`/`lyria-*`/`gemma-*` id, or an openai `text-embedding-*`/`dall-e-*` id, leaking into
 * a slot meant for chat/coding models of a specific CLI family). Mirrors the existing claude-* filter
 * already used for the remote gateway source in local-cli-model-probes.ts.
 */
const FAMILY_PATTERNS: Record<ModelCatalogProviderId, RegExp> = {
  claude: /^claude-/,
  codex: /^(?:gpt-|o[0-9]|codex-)/,
  gemini: /^gemini-/,
};

export interface ModelCatalogFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ModelCatalogOptions {
  /** Env source for the on/off + TTL knobs; defaults to `process.env`. Injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fetch implementation for both catalog sources; defaults to the global `fetch`. Injectable for tests. */
  readonly fetchRemote?: (
    url: string,
    init: { readonly signal: AbortSignal },
  ) => Promise<ModelCatalogFetchResponse>;
  /** Clock override for TTL checks in tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

function isCatalogEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env.CLOWDER_MODEL_CATALOG;
  return raw !== '0' && raw !== 'false';
}

function catalogTtlMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env.CLOWDER_MODEL_CATALOG_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Parses the models.dev `/api.json` catalog (`{ [providerKey]: { models: { [modelId]: {...} } } }`)
 * into id lists for the three CLI-relevant providers. Tolerant of any structural surprise — an
 * unexpected shape yields an empty bucket for that provider rather than throwing.
 */
export function parseModelsDevCatalog(payload: unknown): Partial<Record<ModelCatalogProviderId, string[]>> {
  const result: Partial<Record<ModelCatalogProviderId, string[]>> = {};
  try {
    if (!isRecord(payload)) return result;
    for (const [catalogId, devProviderKey] of Object.entries(MODELS_DEV_PROVIDER_KEYS) as Array<
      [ModelCatalogProviderId, string]
    >) {
      const providerEntry = payload[devProviderKey];
      if (!isRecord(providerEntry)) continue;
      const models = providerEntry.models;
      if (!isRecord(models)) continue;
      const ids = Object.keys(models);
      if (ids.length > 0) result[catalogId] = ids;
    }
  } catch {
    return {};
  }
  return result;
}

/**
 * Recovers the bare model id a CLI would recognize from a raw LiteLLM key. Most keys for our three
 * target providers are already bare (`claude-sonnet-5`, `gpt-5.6-sol`). Some are prefixed:
 *  - A prefix equal to the model's own `litellm_provider` (e.g. `gemini/gemini-2.5-flash`, litellm's
 *    own namespacing for the direct Gemini API — NOT a Vertex/other-hosting alias) is self-
 *    referential: strip it and keep the suffix as the bare id. This matters in practice — most of
 *    LiteLLM's *direct-Gemini-API* model ids are namespaced this way; dropping them outright (as a
 *    blanket "any slash ⇒ drop" rule would) would silently lose the bulk of LiteLLM's Gemini data.
 *  - Any other prefix (`bedrock/`, `azure_ai/`, `vertex_ai/`, size/quality pricing-variant prefixes
 *    like `1024-x-1024/dall-e-2`, etc.) means this key names an alternate-hosting or non-model
 *    variant, not a bare id the target CLI understands — dropped, not guessed at.
 */
function bareLiteLlmModelId(modelId: string, litellmProvider: string): string | null {
  const slashIndex = modelId.indexOf('/');
  if (slashIndex === -1) return modelId;
  const prefix = modelId.slice(0, slashIndex);
  return prefix === litellmProvider ? modelId.slice(slashIndex + 1) : null;
}

/**
 * Parses LiteLLM's flat `model_prices_and_context_window.json` (`{ [modelId]: { litellm_provider,
 * ... } }`, plus a non-model `sample_spec` documentation key) into id lists for the three
 * CLI-relevant providers. Provider-prefixed variants that name an alternate hosting backend (e.g.
 * `bedrock/...`, `azure_ai/...`, `vertex_ai/...`) are excluded outright — those ids only work through
 * that specific backend, not the plain CLI. See `bareLiteLlmModelId` for the one exception (a
 * self-referential prefix). Tolerant of structural surprises — a malformed entry is just skipped.
 */
export function parseLiteLlmCatalog(payload: unknown): Partial<Record<ModelCatalogProviderId, string[]>> {
  const buckets: Record<ModelCatalogProviderId, string[]> = { claude: [], codex: [], gemini: [] };
  try {
    if (!isRecord(payload)) return {};
    for (const [modelId, spec] of Object.entries(payload)) {
      if (modelId === 'sample_spec' || !isRecord(spec)) continue;
      const provider = spec.litellm_provider;
      if (typeof provider !== 'string') continue;
      for (const [catalogId, litellmValue] of Object.entries(LITELLM_PROVIDER_VALUES) as Array<
        [ModelCatalogProviderId, string]
      >) {
        if (provider !== litellmValue) continue;
        const bareId = bareLiteLlmModelId(modelId, litellmValue);
        if (bareId) buckets[catalogId].push(bareId);
      }
    }
  } catch {
    return {};
  }
  const result: Partial<Record<ModelCatalogProviderId, string[]>> = {};
  for (const catalogId of Object.keys(buckets) as ModelCatalogProviderId[]) {
    const ids = uniqueStrings(buckets[catalogId]);
    if (ids.length > 0) result[catalogId] = ids;
  }
  return result;
}

/** Applies the family prefix filter for one provider slot. Exported for direct unit testing. */
export function filterModelCatalogFamily(providerId: ModelCatalogProviderId, ids: readonly string[]): string[] {
  const pattern = FAMILY_PATTERNS[providerId];
  return ids.filter((id) => pattern.test(id));
}

function mergeProviderBuckets(
  a: Partial<Record<ModelCatalogProviderId, string[]>>,
  b: Partial<Record<ModelCatalogProviderId, string[]>>,
): Partial<Record<ModelCatalogProviderId, string[]>> {
  const result: Partial<Record<ModelCatalogProviderId, string[]>> = {};
  for (const catalogId of ['claude', 'codex', 'gemini'] as ModelCatalogProviderId[]) {
    const merged = uniqueStrings([...(a[catalogId] ?? []), ...(b[catalogId] ?? [])]);
    if (merged.length > 0) result[catalogId] = merged;
  }
  return result;
}

async function fetchCatalogJson(
  url: string,
  fetchImpl: NonNullable<ModelCatalogOptions['fetchRemote']>,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Timeout (AbortError), network failure/offline, or a non-JSON body — fail open, silently.
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

let cachedCatalog: Partial<Record<ModelCatalogProviderId, string[]>> | null = null;
let cachedAtMs = 0;

/** Test-only reset for the process-local TTL cache. */
export function resetModelCatalogCache(): void {
  cachedCatalog = null;
  cachedAtMs = 0;
}

/**
 * Best-effort cloud model catalog fetch: models.dev + LiteLLM in parallel, merged (union, dedup) and
 * family-filtered per provider. Cached in-process for CLOWDER_MODEL_CATALOG_TTL_HOURS (default 24h)
 * so repeated scans within the window don't re-fetch. Never throws: disabled via
 * CLOWDER_MODEL_CATALOG=0/false, a timeout, network failure, or a body that fails to parse all
 * resolve to an (possibly cached) empty result — the CLI model chain must never fail because of
 * this optional, supplementary source.
 */
export async function getModelCatalog(
  options: ModelCatalogOptions = {},
): Promise<Partial<Record<ModelCatalogProviderId, string[]>>> {
  const env = options.env ?? process.env;
  if (!isCatalogEnabled(env)) return {};

  const now = (options.now ?? Date.now)();
  if (cachedCatalog && now - cachedAtMs < catalogTtlMs(env)) return cachedCatalog;

  const fetchImpl = options.fetchRemote ?? ((url: string, init: { signal: AbortSignal }) => fetch(url, init));
  const [modelsDevPayload, liteLlmPayload] = await Promise.all([
    fetchCatalogJson(MODELS_DEV_CATALOG_URL, fetchImpl),
    fetchCatalogJson(LITELLM_CATALOG_URL, fetchImpl),
  ]);

  const modelsDevIds = modelsDevPayload !== null ? parseModelsDevCatalog(modelsDevPayload) : {};
  const liteLlmIds = liteLlmPayload !== null ? parseLiteLlmCatalog(liteLlmPayload) : {};
  const merged = mergeProviderBuckets(modelsDevIds, liteLlmIds);

  const filtered: Partial<Record<ModelCatalogProviderId, string[]>> = {};
  for (const catalogId of Object.keys(merged) as ModelCatalogProviderId[]) {
    const familyFiltered = filterModelCatalogFamily(catalogId, merged[catalogId] ?? []);
    if (familyFiltered.length > 0) filtered[catalogId] = familyFiltered;
  }

  cachedCatalog = filtered;
  cachedAtMs = now;
  return filtered;
}
