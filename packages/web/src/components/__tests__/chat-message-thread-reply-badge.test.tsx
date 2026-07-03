import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { useTaskStore, type TaskItem } from '@/stores/taskStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
          threadReplyInfo={{ branchThreadId: 'thread-branch', replyCount: 11, newCount: 5 }}
          onOpenThread={onOpenThread}
        />,
      );
    });

    const replyButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('11 replies'),
    ) as HTMLButtonElement | undefined;

    expect(replyButton).toBeTruthy();
    expect(replyButton?.textContent).toContain('5 new');
    expect(replyButton?.getAttribute('aria-label')).toContain('打开 Thread');

    act(() => {
      replyButton?.click();
    });

    expect(onOpenThread).toHaveBeenCalledWith('m-thread-parent');
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
