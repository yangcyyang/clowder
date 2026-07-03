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
});
