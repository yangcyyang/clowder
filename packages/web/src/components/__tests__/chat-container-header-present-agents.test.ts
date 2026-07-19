/**
 * D3: Present-agents indicator in ChatContainerHeader.
 * Shows agents ACTUALLY present in the current thread (posted or @-mentioned in
 * THIS thread's visible messages) — never the config roster (participatingCats/
 * preferredCats), which was the source of the "以为某猫在场其实不在" pain.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PresentAgentsIndicator } from '@/components/ChatContainerHeader';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) => ({
      id,
      displayName: `猫猫-${id}`,
      color: { primary: '#123456' },
    }),
    getCatsByBreed: () => new Map(),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));

const THREAD = {
  id: 'thread_xyz',
  title: '讨论 F095 设计',
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: Date.now(),
  createdAt: Date.now(),
  // 配置名册：kimi/glm 被配置进频道，但从未在本 thread 发言或被 @。
  participatingCats: ['kimi', 'glm'],
  preferredCats: ['kimi'],
};

function msg(input: Record<string, unknown>) {
  return { timestamp: 1, ...input };
}

const mockStore: Record<string, unknown> = {
  threads: [THREAD],
  threadStates: {},
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

const renderIndicator = (threadId: string) => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(React.createElement(PresentAgentsIndicator, { threadId }));
  return container;
};

describe('PresentAgentsIndicator', () => {
  beforeEach(() => {
    mockStore.threadStates = {};
  });

  it('shows only real participants from visible messages, not the config roster', () => {
    mockStore.threadStates = {
      thread_xyz: {
        messages: [
          msg({ id: 'u1', type: 'user', content: '@codex 帮忙看下', mentions: ['codex'] }),
          msg({ id: 'a1', type: 'assistant', catId: 'opus', content: '看完了' }),
        ],
        activeInvocations: {},
      },
    };

    const rendered = renderIndicator('thread_xyz');
    expect(rendered.querySelector('[data-testid="present-agents"]')).not.toBeNull();
    expect(rendered.querySelector('[data-testid="present-agent-codex"]')).not.toBeNull();
    expect(rendered.querySelector('[data-testid="present-agent-opus"]')).not.toBeNull();
    // 名册成员但不在场 —— 必须缺席（核心痛点）
    expect(rendered.querySelector('[data-testid="present-agent-kimi"]')).toBeNull();
    expect(rendered.querySelector('[data-testid="present-agent-glm"]')).toBeNull();
  });

  it('decorates actively-invoked agents as active', () => {
    mockStore.threadStates = {
      thread_xyz: {
        messages: [msg({ id: 'u1', type: 'user', content: '@codex go', mentions: ['codex'] })],
        activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute' } },
      },
    };

    const rendered = renderIndicator('thread_xyz');
    expect(rendered.querySelector('[data-testid="present-agent-codex"]')?.getAttribute('data-active')).toBe('true');
  });

  it('includes whisper participants for the user viewer (user sees everything)', () => {
    mockStore.threadStates = {
      thread_xyz: {
        messages: [
          msg({
            id: 'w1',
            type: 'assistant',
            catId: 'kimi',
            content: '悄悄话',
            visibility: 'whisper',
            whisperTo: ['kimi'],
          }),
        ],
        activeInvocations: {},
      },
    };

    const rendered = renderIndicator('thread_xyz');
    expect(rendered.querySelector('[data-testid="present-agent-kimi"]')).not.toBeNull();
  });

  it('renders nothing when the thread has no visible agent activity', () => {
    mockStore.threadStates = { thread_xyz: { messages: [], activeInvocations: {} } };
    const rendered = renderIndicator('thread_xyz');
    expect(rendered.querySelector('[data-testid="present-agents"]')).toBeNull();
    // 即使名册非空也不兜底成名册
    expect(rendered.textContent).not.toContain('猫猫-kimi');
  });
});
