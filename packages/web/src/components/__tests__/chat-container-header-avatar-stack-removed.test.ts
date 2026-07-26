/**
 * cy 2026-07-26: 移除频道头部的参与猫头像堆。
 * 铲屎官原话："头部红圈头像堆感觉没什么作用，看能不能把它删掉"。
 *
 * 定位：ChatContainerHeader.tsx 里 `<PresentAgentsIndicator threadId={threadId} />`
 * 是频道标题（ThreadIndicator）右侧唯一的头像徽章堆挂载点（全库 grep 确认
 * PresentAgentsIndicator 只在这一处 + 它自己的单测里被引用）。组件定义本身保留
 * （它自己的单测 chat-container-header-present-agents.test.ts 仍直接单测这个
 * export，不受本次头部摘除影响），本测试只断言"频道头部这一处不再挂载它"。
 *
 * 红→绿：给出一个会产生非空在场成员列表的 threadState（沿用
 * chat-container-header-present-agents.test.ts 的数据形状），断言头部渲染结果里
 * 不存在 present-agents 头像堆。改动前（仍挂载）必然失败——PresentAgentsIndicator
 * 会渲染出 [data-testid="present-agents"]；摘除挂载后转绿。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('@/components/ExportButton', () => ({ ExportButton: () => null }));
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/VoiceCompanionButton', () => ({ VoiceCompanionButton: () => null }));
vi.mock('@/components/icons/CatCafeLogo', () => ({
  CatCafeLogo: () => React.createElement('span', null, 'logo'),
}));
vi.mock('@/components/UserProfileCandidatesPanel', () => ({
  UserProfileCandidatesEntry: () => null,
}));

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
  title: '# AI推特日报',
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: Date.now(),
  createdAt: Date.now(),
  pinned: false,
  favorited: false,
  // 配置名册：kimi/glm 被配置进频道，但从未在本 thread 发言或被 @——历史上仍会被
  // present-agents 算作"应该在场"，用来确保这条数据能撑起一个非空头像堆。
  participatingCats: ['kimi', 'glm'],
  preferredCats: ['kimi'],
};

function msg(input: Record<string, unknown>) {
  return { timestamp: 1, ...input };
}

const mockStore: Record<string, unknown> = {
  threads: [THREAD],
  rightPanelMode: 'status',
  setRightPanelMode: vi.fn(),
  threadStates: {},
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

const defaultProps = {
  sidebarOpen: false,
  onToggleSidebar: vi.fn(),
  authPendingCount: 0,
  viewMode: 'single' as const,
  onToggleViewMode: vi.fn(),
  onOpenMobileStatus: vi.fn(),
  statusPanelOpen: false,
  onToggleStatusPanel: vi.fn(),
  onOpenChannelSettings: vi.fn(),
  onOpenKnowledgeCapture: vi.fn(),
};

describe('ChatContainerHeader — avatar stack removed', () => {
  beforeEach(() => {
    mockStore.threads = [THREAD];
    // Visible-agent-producing messages — the exact shape that
    // chat-container-header-present-agents.test.ts proves yields a non-empty stack.
    mockStore.threadStates = {
      thread_xyz: {
        messages: [
          msg({ id: 'u1', type: 'user', content: '@codex 帮忙看下', mentions: ['codex'] }),
          msg({ id: 'a1', type: 'assistant', catId: 'opus', content: '看完了' }),
        ],
        activeInvocations: {},
      },
    };
  });

  const renderHeader = (threadId: string) =>
    renderToStaticMarkup(React.createElement(ChatContainerHeader, { ...defaultProps, threadId }));

  it('does not render the participant avatar-stack badge cluster in the channel header', () => {
    const html = renderHeader('thread_xyz');
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelector('[data-testid="present-agents"]')).toBeNull();
    expect(container.querySelector('[data-testid="present-agent-codex"]')).toBeNull();
    expect(container.querySelector('[data-testid="present-agent-opus"]')).toBeNull();
  });

  it('still renders the channel title next to where the avatar stack used to sit', () => {
    const html = renderHeader('thread_xyz');
    expect(html).toContain('AI推特日报');
  });
});
