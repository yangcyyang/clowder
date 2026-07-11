import { describe, expect, it } from 'vitest';
import { freshnessHoldLabel } from '../FreshnessHoldBar';

describe('FreshnessHoldBar labels', () => {
  it('never exposes draft content and distinguishes recoverable states', () => {
    expect(freshnessHoldLabel({ status: 'held' })).toContain('安全扣住');
    expect(freshnessHoldLabel({ status: 'reviewing' })).toContain('重新审阅');
    expect(freshnessHoldLabel({ status: 'needs_attention', attentionReason: 'timeout' })).toContain('超时');
    expect(freshnessHoldLabel({ status: 'needs_attention', attentionReason: 'review_limit' })).toContain('人工处理');
  });
});
