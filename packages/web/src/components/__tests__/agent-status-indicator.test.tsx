import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { AgentStatusIndicator, getAgentStatusLabel } from '../AgentStatusIndicator';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const TEST_CAT: CatData = {
  id: 'gpt52',
  displayName: '缅因猫',
  color: { primary: '#4CAF50', secondary: '#C8E6C9' },
  mentionPatterns: ['@gpt52'],
  clientId: 'openai',
  defaultModel: 'gpt-5.2',
  avatar: 'cat',
  roleDescription: 'test',
  personality: 'test',
};

function getCatById(catId: string): CatData | undefined {
  return catId === TEST_CAT.id ? TEST_CAT : undefined;
}

describe('AgentStatusIndicator', () => {
  it('renders nothing when no agent is active', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{}}
        catStatuses={{}}
        catInvocations={{}}
        getCatById={getCatById}
      />,
    );

    expect(html).toBe('');
  });

  it('renders active agent status from thread-scoped invocation data', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{
          'inv-1': { catId: 'gpt52', mode: 'execute', startedAt: Date.now() - 5000 },
        }}
        catStatuses={{ gpt52: 'streaming' }}
        catInvocations={{}}
        getCatById={getCatById}
      />,
    );

    expect(html).not.toContain('AGENT');
    expect(html).toContain('缅因猫');
    expect(html).toContain('正在生成');
  });

  it('uses phase to show tool execution state', () => {
    expect(getAgentStatusLabel('streaming', 'tool_calling')).toBe('正在执行工具');
  });

  it('ignores stale cat status when invocation slot is not present', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{}}
        catStatuses={{ gpt52: 'pending' }}
        catInvocations={{ gpt52: { startedAt: Date.now() - 1000 } }}
        getCatById={getCatById}
      />,
    );

    expect(html).toBe('');
  });
});
