import { describe, expect, it } from 'vitest';
import {
  isScannedModelSource,
  MODEL_SOURCE_LABELS,
  parseModelOptionsResponse,
} from '../hub-cat-model-options';

describe('hub-cat-model-options: catalog source (5th, cloud model catalog)', () => {
  it('has a Chinese label for the catalog source', () => {
    expect(MODEL_SOURCE_LABELS.catalog).toBe('云目录');
  });

  it('labels every ModelCandidateSource, including catalog', () => {
    expect(Object.keys(MODEL_SOURCE_LABELS).sort()).toEqual(['catalog', 'cli', 'config', 'remote', 'static'].sort());
  });

  it('treats catalog as a scanned source (drift-check semantics: present in catalog => no drift)', () => {
    expect(isScannedModelSource('catalog')).toBe(true);
    // Unaffected existing sources keep their existing scanned/unscanned classification.
    expect(isScannedModelSource('cli')).toBe(true);
    expect(isScannedModelSource('config')).toBe(true);
    expect(isScannedModelSource('remote')).toBe(true);
    expect(isScannedModelSource('static')).toBe(false);
    expect(isScannedModelSource(undefined)).toBe(false);
  });

  it('parseModelOptionsResponse surfaces a catalog modelsSource from the API response shape', () => {
    const parsed = parseModelOptionsResponse({
      scannedAt: '2026-07-25T00:00:00.000Z',
      clients: {
        anthropic: {
          models: ['claude-sonnet-5', 'claude-haiku-4-5'],
          modelsSource: 'catalog',
        },
      },
    });

    expect(parsed.sources.anthropic).toBe('catalog');
    expect(parsed.options.anthropic).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']);
    expect(parsed.scannedAt).toBe('2026-07-25T00:00:00.000Z');
  });
});
