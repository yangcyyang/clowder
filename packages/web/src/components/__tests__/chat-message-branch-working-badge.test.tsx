import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

/**
 * 跨视图感知修复(F001) 功能2: 主频道内联"分支工作中"提示条。
 *
 * 背景: 铲屎官在主频道 @芝芝 发任务 → thread-first 把执行路由进分支 → 芝芝干活 108 秒
 * 并完成 → 铲屎官全程零感知。这条提示条要让"干活中"这件事在主频道里可见——
 * 甚至在分支还没有任何一条回复落地时(replyCount===0,cat 还在生成第一条回复)就要出现,
 * 复用 replies 徽标同一个数据源(threadReplyInfo.branchThreadId,来自 extra.slockThread,
 * 分支一创建就带着,不需要等第一条回复)。
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let mockGlobalCatActivity: Record<string, { status: 'active' | 'idle'; threadId?: string; updatedAt: number }> = {};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [{ id: 'thread-branch', title: '芝芝的分支' }],
      messages: [],
      currentThreadId: 'default',
      isLoadingThreads: false,
      catStatuses: {},
      globalCatActivity: mockGlobalCatActivity,
    }),
  resolveBubbleExpanded: (override: string | undefined, globalDefault: string) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

function makeUserMessage(): ChatMessageType {
  return {
    id: 'm-thread-parent',
    type: 'user',
    catId: null,
    timestamp: Date.now(),
    visibility: 'public',
    revealedAt: null,
    whisperTo: null,
    origin: 'user',
    variant: null,
    isStreaming: false,
    content: '父消息',
    thinking: '',
    contentBlocks: null,
    toolEvents: null,
    metadata: null,
    summary: null,
    evidence: null,
    extra: null,
    source: null,
  } as unknown as ChatMessageType;
}

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe('ChatMessage 分支工作中提示条(跨视图感知修复)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: false });
    mockGlobalCatActivity = {};
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('分支已创建但还没有任何回复(replyCount=0)、猫正在这个分支里执行时,仍然渲染工作提示条', () => {
    mockGlobalCatActivity = { zhizhi: { status: 'active', threadId: 'thread-branch', updatedAt: Date.now() } };
    const onOpenThread = vi.fn();

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={(id) =>
            id === 'zhizhi'
              ? {
                  id: 'zhizhi',
                  displayName: '芝芝',
                  color: { primary: '#111', secondary: '#fff' },
                  mentionPatterns: [],
                  clientId: 'claude',
                  defaultModel: 'sonnet',
                  avatar: '',
                  roleDescription: '',
                  personality: '',
                }
              : undefined
          }
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 0 }}
          onOpenThread={onOpenThread}
        />,
      );
    });

    const workingBadge = findButtonByText(container, '芝芝正在分支中回复');
    expect(workingBadge).toBeTruthy();

    // 没有既有 replies 徽标(0 条回复,不该出现 "0 replies" 这种奇怪文案)。
    expect(findButtonByText(container, 'replies')).toBeUndefined();

    act(() => {
      workingBadge?.click();
    });
    expect(onOpenThread).toHaveBeenCalledWith('m-thread-parent');
  });

  it('分支已有历史回复、且猫仍在该分支执行时,工作提示条顶替既有 replies 徽标(互斥,不并存)', () => {
    mockGlobalCatActivity = { zhizhi: { status: 'active', threadId: 'thread-branch', updatedAt: Date.now() } };

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 3 }}
          onOpenThread={vi.fn()}
        />,
      );
    });

    expect(findButtonByText(container, '正在分支中回复')).toBeTruthy();
    expect(findButtonByText(container, '3 replies')).toBeUndefined();
  });

  it('执行结束(globalCatActivity 清空/无匹配)后,回归既有 replies 徽标', () => {
    mockGlobalCatActivity = {}; // 已清灯

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 3, newCount: 1 }}
          onOpenThread={vi.fn()}
        />,
      );
    });

    expect(findButtonByText(container, '正在分支中回复')).toBeUndefined();
    expect(findButtonByText(container, '3 replies')).toBeTruthy();
  });

  it('猫在其他分支/其他 thread 执行(threadId 不匹配这条消息的分支)时,不误报工作提示条', () => {
    mockGlobalCatActivity = { zhizhi: { status: 'active', threadId: 'thread-other-branch', updatedAt: Date.now() } };

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 2 }}
          onOpenThread={vi.fn()}
        />,
      );
    });

    expect(findButtonByText(container, '正在分支中回复')).toBeUndefined();
    expect(findButtonByText(container, '2 replies')).toBeTruthy();
  });

  it('没有关联分支(threadReplyInfo 为 undefined)时,不渲染工作提示条,也不报错', () => {
    mockGlobalCatActivity = { zhizhi: { status: 'active', threadId: 'thread-branch', updatedAt: Date.now() } };

    expect(() => {
      act(() => {
        root.render(<ChatMessage message={makeUserMessage()} getCatById={() => undefined} onOpenThread={vi.fn()} />);
      });
    }).not.toThrow();

    expect(findButtonByText(container, '正在分支中回复')).toBeUndefined();
  });

  it('getCatById 找不到猫时,工作提示条回退用 catId 本身兜底展示', () => {
    mockGlobalCatActivity = { 'unknown-cat': { status: 'active', threadId: 'thread-branch', updatedAt: Date.now() } };

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 0 }}
          onOpenThread={vi.fn()}
        />,
      );
    });

    expect(findButtonByText(container, 'unknown-cat正在分支中回复')).toBeTruthy();
  });
});
