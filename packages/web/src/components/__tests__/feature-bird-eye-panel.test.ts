import { beforeAll, describe, expect, it } from 'vitest';

describe('extractFeatureId', () => {
  let extractFeatureId: (tags: readonly string[]) => string;

  beforeAll(async () => {
    const mod = await import('@/components/mission-control/FeatureBirdEyePanel');
    extractFeatureId = mod.extractFeatureId;
  });

  it('extracts from feature:fxxx format (docs-backlog import)', () => {
    expect(extractFeatureId(['source:docs-backlog', 'feature:f058', 'status:spec'])).toBe('F058');
  });

  it('extracts from bare F058 tag', () => {
    expect(extractFeatureId(['F058', 'other-tag'])).toBe('F058');
  });

  it('normalizes case to uppercase', () => {
    expect(extractFeatureId(['feature:f049'])).toBe('F049');
  });

  it('returns Untagged when no feature tag found', () => {
    expect(extractFeatureId(['source:docs-backlog', 'status:spec'])).toBe('Untagged');
  });

  it('returns Untagged for empty tags', () => {
    expect(extractFeatureId([])).toBe('Untagged');
  });
});
