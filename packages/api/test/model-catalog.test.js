import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  LITELLM_CATALOG_URL,
  MODELS_DEV_CATALOG_URL,
  filterModelCatalogFamily,
  getModelCatalog,
  parseLiteLlmCatalog,
  parseModelsDevCatalog,
  resetModelCatalogCache,
} from '../dist/utils/model-catalog.js';

// Real-structure excerpts captured from the live endpoints (models.dev/api.json and LiteLLM's
// model_prices_and_context_window.json), trimmed to the fields these parsers actually read.
const MODELS_DEV_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/model-catalog-models-dev.json', import.meta.url)));
const LITELLM_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/model-catalog-litellm.json', import.meta.url)));

describe('parseModelsDevCatalog', () => {
  it('extracts model ids from the anthropic/openai/google provider buckets, keyed by CLI id', () => {
    const result = parseModelsDevCatalog(MODELS_DEV_FIXTURE);
    assert.deepEqual(result.claude?.sort(), ['claude-fable-5', 'claude-opus-4-6', 'claude-sonnet-5']);
    assert.deepEqual(result.codex?.sort(), [
      'chatgpt-image-latest',
      'gpt-5.3-codex-spark',
      'gpt-5.4',
      'gpt-5.6-sol',
      'gpt-image-2',
      'o3-mini',
      'text-embedding-3-large',
    ]);
    assert.deepEqual(result.gemini?.sort(), [
      'deep-research-preview-04-2026',
      'gemini-2.5-flash',
      'gemini-3.1-pro-preview',
      'gemma-4-31b-it',
      'lyria-3-pro-preview',
    ]);
  });

  it('ignores providers outside the claude/codex/gemini scope (e.g. zhipuai)', () => {
    const result = parseModelsDevCatalog(MODELS_DEV_FIXTURE);
    assert.equal(Object.keys(result).sort().join(','), 'claude,codex,gemini');
  });

  it('is defensive against a malformed payload', () => {
    assert.deepEqual(parseModelsDevCatalog(null), {});
    assert.deepEqual(parseModelsDevCatalog('not an object'), {});
    assert.deepEqual(parseModelsDevCatalog([1, 2, 3]), {});
    assert.deepEqual(parseModelsDevCatalog({ anthropic: { models: 'not an object' } }), {});
  });
});

describe('parseLiteLlmCatalog', () => {
  it('excludes the sample_spec documentation key', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    for (const ids of Object.values(result)) {
      assert.equal(ids.includes('sample_spec'), false);
    }
  });

  it('keeps bare ids for the matching litellm_provider and drops cross-provider-hosted prefixes', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    // anthropic: bare ids kept; azure_ai/claude-opus-4-6 excluded (wrong litellm_provider, "azure_ai").
    assert.deepEqual(result.claude?.sort(), ['claude-opus-4-6', 'claude-sonnet-5']);
    assert.equal(result.claude?.includes('azure_ai/claude-opus-4-6'), false);
  });

  it('drops non-self-referential prefixed variants (size/quality pricing keys) for openai', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    // '1024-x-1024/dall-e-2' has litellm_provider openai but a non-self prefix -> dropped entirely.
    assert.equal(result.codex?.includes('1024-x-1024/dall-e-2'), false);
    assert.equal(result.codex?.includes('dall-e-2'), false);
  });

  it('strips a self-referential provider prefix instead of dropping the entry (openai/sora-2)', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    assert.equal(result.codex?.includes('sora-2'), true);
    assert.equal(result.codex?.includes('openai/sora-2'), false);
  });

  it('keeps the bare gpt-5.6-sol/o3-mini/codex-mini-latest ids for codex', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    assert.deepEqual(
      result.codex?.slice().sort(),
      ['codex-mini-latest', 'gpt-5.6-sol', 'gpt-image-2', 'o3-mini', 'sora-2', 'text-embedding-3-large'].sort(),
    );
  });

  it('excludes bare gemini-2.5-flash tagged with the Vertex AI backend, keeps the self-prefixed direct Gemini API variant', () => {
    const result = parseLiteLlmCatalog(LITELLM_FIXTURE);
    // gemini-2.5-flash (bare key) is litellm_provider "vertex_ai-language-models", not "gemini" -> excluded.
    assert.equal(result.gemini?.includes('gemini-2.5-flash'), true, 'the self-prefixed gemini/gemini-2.5-flash strips to this bare id');
    // Confirm there is exactly one contributor to that id (no accidental double count from the Vertex entry).
    assert.equal(result.gemini?.filter((id) => id === 'gemini-2.5-flash').length, 1);
    assert.equal(result.gemini?.includes('gemini-embedding-2'), true);
  });

  it('is defensive against a malformed payload', () => {
    assert.deepEqual(parseLiteLlmCatalog(null), {});
    assert.deepEqual(parseLiteLlmCatalog(42), {});
    assert.deepEqual(parseLiteLlmCatalog({ 'some-model': 'not an object' }), {});
  });
});

describe('filterModelCatalogFamily', () => {
  it('claude slot only accepts claude-* ids', () => {
    assert.deepEqual(filterModelCatalogFamily('claude', ['claude-opus-5', 'gpt-5.4', 'gemini-2.5-flash']), [
      'claude-opus-5',
    ]);
  });

  it('codex slot accepts gpt-*, o[0-9]*, and codex-* ids', () => {
    assert.deepEqual(
      filterModelCatalogFamily('codex', ['gpt-5.6-sol', 'o3-mini', 'o1-pro', 'codex-mini-latest', 'chatgpt-4o-latest', 'ft:gpt-4o-2024-08-06', 'opencode']),
      ['gpt-5.6-sol', 'o3-mini', 'o1-pro', 'codex-mini-latest'],
    );
  });

  it('gemini slot only accepts gemini-* ids (rejects veo/lyria/gemma/deep-research)', () => {
    assert.deepEqual(
      filterModelCatalogFamily('gemini', [
        'gemini-3.1-pro-preview',
        'veo-3.1-generate-preview',
        'lyria-3-pro-preview',
        'gemma-4-31b-it',
        'deep-research-preview-04-2026',
      ]),
      ['gemini-3.1-pro-preview'],
    );
  });
});

describe('getModelCatalog', () => {
  afterEach(() => {
    resetModelCatalogCache();
  });

  function fetchStub(responses) {
    const calls = [];
    return {
      calls,
      async fetchRemote(url, init) {
        calls.push(url);
        assert.ok(init?.signal instanceof AbortSignal);
        const entry = responses[url];
        if (!entry) throw new Error(`unexpected fetch url in test: ${url}`);
        if (entry.throw) throw entry.throw;
        return {
          ok: entry.ok ?? true,
          status: entry.status ?? 200,
          async json() {
            if (entry.jsonThrows) throw new Error('invalid json');
            return entry.body;
          },
        };
      },
    };
  }

  it('fetches both sources, merges the union (dedup), and family-filters the result', async () => {
    const { fetchRemote, calls } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { body: MODELS_DEV_FIXTURE },
      [LITELLM_CATALOG_URL]: { body: LITELLM_FIXTURE },
    });

    const result = await getModelCatalog({ env: {}, fetchRemote });

    assert.deepEqual(calls.sort(), [LITELLM_CATALOG_URL, MODELS_DEV_CATALOG_URL].sort());
    // claude-sonnet-5 / claude-opus-4-6 appear in BOTH sources -> deduped to a single occurrence each.
    assert.equal(result.claude?.filter((id) => id === 'claude-sonnet-5').length, 1);
    assert.equal(result.claude?.filter((id) => id === 'claude-opus-4-6').length, 1);
    assert.ok(result.claude?.includes('claude-fable-5'), 'models.dev-only id must still surface');
    // gemini family filter rejects models.dev's gemma/lyria/deep-research ids.
    assert.equal(result.gemini?.some((id) => id.startsWith('gemma-') || id.startsWith('lyria-')), false);
    assert.ok(result.gemini?.includes('gemini-2.5-flash'));
  });

  it('caches the result and does not refetch again within the TTL window', async () => {
    const { fetchRemote, calls } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { body: MODELS_DEV_FIXTURE },
      [LITELLM_CATALOG_URL]: { body: LITELLM_FIXTURE },
    });
    let now = 1_000_000;

    const first = await getModelCatalog({ env: {}, fetchRemote, now: () => now });
    assert.equal(calls.length, 2);

    now += 60_000; // 1 minute later, well within the 24h default TTL
    const second = await getModelCatalog({ env: {}, fetchRemote, now: () => now });
    assert.equal(calls.length, 2, 'a cache hit must not trigger any additional fetch calls');
    assert.deepEqual(second, first);
  });

  it('refetches once the TTL window has elapsed', async () => {
    const { fetchRemote, calls } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { body: MODELS_DEV_FIXTURE },
      [LITELLM_CATALOG_URL]: { body: LITELLM_FIXTURE },
    });
    let now = 1_000_000;

    await getModelCatalog({ env: { CLOWDER_MODEL_CATALOG_TTL_HOURS: '1' }, fetchRemote, now: () => now });
    assert.equal(calls.length, 2);

    now += 2 * 60 * 60 * 1000; // 2 hours later, past the configured 1h TTL
    await getModelCatalog({ env: { CLOWDER_MODEL_CATALOG_TTL_HOURS: '1' }, fetchRemote, now: () => now });
    assert.equal(calls.length, 4, 'past the TTL, both sources should be fetched again');
  });

  it('silently falls back to an empty catalog when a fetch times out (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const { fetchRemote } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { throw: abortError },
      [LITELLM_CATALOG_URL]: { throw: abortError },
    });

    const result = await getModelCatalog({ env: {}, fetchRemote });
    assert.deepEqual(result, {});
  });

  it('silently falls back when one source fails and keeps the other source usable', async () => {
    const { fetchRemote } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { ok: false, status: 503 },
      [LITELLM_CATALOG_URL]: { body: LITELLM_FIXTURE },
    });

    const result = await getModelCatalog({ env: {}, fetchRemote });
    assert.ok(result.claude?.includes('claude-sonnet-5'), 'litellm-only data should still surface');
  });

  it('silently falls back when a response body fails to parse as JSON', async () => {
    const { fetchRemote } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { jsonThrows: true },
      [LITELLM_CATALOG_URL]: { jsonThrows: true },
    });

    const result = await getModelCatalog({ env: {}, fetchRemote });
    assert.deepEqual(result, {});
  });

  it('makes zero network requests when CLOWDER_MODEL_CATALOG=0', async () => {
    let fetchCalls = 0;
    const result = await getModelCatalog({
      env: { CLOWDER_MODEL_CATALOG: '0' },
      async fetchRemote() {
        fetchCalls += 1;
        return { ok: true, status: 200, async json() { return {}; } };
      },
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result, {});
  });

  it('makes zero network requests when CLOWDER_MODEL_CATALOG=false', async () => {
    let fetchCalls = 0;
    await getModelCatalog({
      env: { CLOWDER_MODEL_CATALOG: 'false' },
      async fetchRemote() {
        fetchCalls += 1;
        return { ok: true, status: 200, async json() { return {}; } };
      },
    });
    assert.equal(fetchCalls, 0);
  });

  it('is enabled by default when CLOWDER_MODEL_CATALOG is unset', async () => {
    const { fetchRemote, calls } = fetchStub({
      [MODELS_DEV_CATALOG_URL]: { body: MODELS_DEV_FIXTURE },
      [LITELLM_CATALOG_URL]: { body: LITELLM_FIXTURE },
    });
    await getModelCatalog({ env: {}, fetchRemote });
    assert.equal(calls.length, 2);
  });
});
