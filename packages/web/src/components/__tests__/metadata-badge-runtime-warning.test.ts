import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetadataBadge } from '../MetadataBadge';

describe('MetadataBadge runtime warnings', () => {
  it('renders runtime warning count and expanded titles', () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataBadge, {
        metadata: {
          provider: 'anthropic',
          model: 'claude-fable-5',
          usage: { inputTokens: 448000, outputTokens: 1200, costUsd: 0.62 },
          runtimeWarnings: [
            {
              id: 'warn-1',
              title: 'Skill 目录已裁剪',
              message: 'Exceeded skills context budget',
              severity: 'warning',
              timestamp: 123,
            },
          ],
        },
      }),
    );

    expect(html).toContain('⚠ 1');
  });

  it('renders the structured deliveryOnly degradation beside message metadata', () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataBadge, {
        metadata: {
          provider: 'codex-cli',
          model: 'gpt-5.5',
          usage: {
            deliveryOnlyMode: 'degraded',
            deliveryOnlyDegradedIssue: 'missing_summary',
          },
        },
      }),
    );

    expect(html).toContain('⚠ deliveryOnly 降级 · missing_summary');
    expect(html).toContain('text-conn-amber-text');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('does not render a warning for active deliveryOnly', () => {
    const html = renderToStaticMarkup(
      React.createElement(MetadataBadge, {
        metadata: {
          provider: 'codex-cli',
          model: 'gpt-5.5',
          usage: { deliveryOnlyMode: 'active' },
        },
      }),
    );
    expect(html).not.toContain('deliveryOnly 降级');
  });
});
