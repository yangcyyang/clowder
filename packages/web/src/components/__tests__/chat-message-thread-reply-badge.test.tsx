import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      messages: [],
      currentThreadId: 'default',
      isLoadingThreads: false,
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

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: '验收快车道',
    ownerCatId: 'opus' as NonNullable<TaskItem['ownerCatId']>,
    status: 'in_review',
    why: '',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    sourceMessageId: 'm-thread-parent',
    evidence: { tests: 'passed' },
    ...overrides,
  };
}

describe('ChatMessage thread reply badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useTaskStore.setState({ tasks: [] });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders a slock-like clickable reply entry that opens the thread panel', () => {
    const onOpenThread = vi.fn();

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{
            branchThreadId: 'thread-branch',
            replyCount: 11,
            newCount: 5,
            latestReply: {
              id: 'reply-latest',
              catId: 'opus',
              content: '已完成验收矩阵与窄屏回归',
              timestamp: Date.now(),
            },
          }}
          onOpenThread={onOpenThread}
        />,
      );
    });

    const replyButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('11 replies'),
    ) as HTMLButtonElement | undefined;

    expect(replyButton).toBeTruthy();
    expect(replyButton?.textContent).toContain('5 new');
    expect(replyButton?.textContent).toContain('opus');
    expect(replyButton?.textContent).toContain('已完成验收矩阵与窄屏回归');
    expect(replyButton?.getAttribute('aria-label')).toContain('打开 Thread');
    expect(replyButton?.querySelector('[data-thread-unread-dot="true"]')).toBeTruthy();
    expect(replyButton?.className).toContain('min-h-11');

    act(() => {
      replyButton?.click();
    });

    expect(onOpenThread).toHaveBeenCalledWith('m-thread-parent');
  });

  it('keeps the latest summary compact and hides the unread dot when read', () => {
    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{
            branchThreadId: 'thread-branch',
            replyCount: 1,
            newCount: 0,
            latestReply: {
              id: 'reply-latest',
              catId: null,
              content: '这是用户发出的最后一条回复',
              timestamp: Date.now(),
            },
          }}
          onOpenThread={vi.fn()}
        />,
      );
    });

    const replyButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('1 reply'),
    );
    expect(replyButton?.textContent).toContain('你 · 这是用户发出的最后一条回复');
    expect(replyButton?.querySelector('[data-thread-unread-dot="true"]')).toBeNull();
    expect(replyButton?.querySelector('[data-thread-reply-summary="true"]')?.className).toContain('truncate');
  });

  it('keeps authorized open, reference and copy as sibling controls with full-id address payload', async () => {
    const onReference = vi.fn();
    const onCopy = vi.fn();
    const token = '#大厅:0001784400000000-000001-ab12cd34';
    apiFetchMock.mockResolvedValue({ ok: true });
    await act(async () => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 2 }}
          onOpenThread={vi.fn()}
          threadAddressToken={token}
          onReferenceThreadAddress={onReference}
          onCopyThreadAddress={onCopy}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const referenceButton = container.querySelector<HTMLButtonElement>('button[aria-label="引用 Thread 地址"]');
    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="复制 Thread 地址"]');
    expect(referenceButton?.title).toContain(token);
    expect(copyButton?.title).toContain(token);
    expect(container.querySelector('button button')).toBeNull();

    act(() => {
      referenceButton?.click();
      copyButton?.click();
    });
    expect(onReference).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it('does not render address actions when the viewer-safe capability check denies them', async () => {
    await act(async () => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => undefined}
          threadReplyInfo={{ branchThreadId: 'thread-stale', replyCount: 2 }}
          onOpenThread={vi.fn()}
          threadAddressToken="#大厅:0001784400000000-000001-ab12cd34"
          onReferenceThreadAddress={vi.fn()}
          onCopyThreadAddress={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-thread-address-actions]')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalled();
    expect(
      apiFetchMock.mock.calls.some(([url]) => String(url).includes('/api/thread-address/resolve?')),
    ).toBe(true);
  });

  it('renders a slock-like task dispatch chip with assignee and opens the task thread', () => {
    useTaskStore.setState({ tasks: [makeTask()] });
    const onOpenTaskThread = vi.fn();

    act(() => {
      root.render(
        <ChatMessage
          message={makeUserMessage()}
          getCatById={() => ({
            id: 'opus',
            displayName: '专家-Claude',
            color: { primary: '#111', secondary: '#fff' },
            mentionPatterns: [],
            clientId: 'claude',
            defaultModel: 'sonnet',
            avatar: '',
            roleDescription: 'Claude reviewer',
            personality: 'concise',
          })}
          onOpenTaskThread={onOpenTaskThread}
        />,
      );
    });

    expect(container.textContent).toContain('任务 #1 @专家-Claude');
    expect(container.textContent).toContain('交付证据 1/5');

    const taskButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('任务 #1'),
    ) as HTMLButtonElement | undefined;

    expect(taskButton).toBeTruthy();
    expect(taskButton?.getAttribute('aria-label')).toContain('打开任务 Thread #1');

    act(() => {
      taskButton?.click();
    });

    expect(onOpenTaskThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
  });
});
