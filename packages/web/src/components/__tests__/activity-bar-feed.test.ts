import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFeedResponse } from '@/utils/activity-feed-client';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: ({ className }: { className?: string }) => React.createElement('span', { className }, 'M'),
}));

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('@/components/hub-icons', () => ({
  HubIcon: ({ name, className }: { name: string; className?: string }) =>
    React.createElement('span', { className }, name),
}));

vi.mock('@/components/settings/settings-nav-config', () => ({
  SETTINGS_SECTIONS: [],
  isDailySettingsSection: () => true,
}));

const { fetchActivityFeed, ackActivityItem } = vi.hoisted(() => ({
  fetchActivityFeed: vi.fn(),
  ackActivityItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/activity-feed-client', () => ({
  fetchActivityFeed,
  ackActivityItem,
}));

import { ActivityBar } from '@/components/ActivityBar';

function feedResponse(overrides: Partial<ActivityFeedResponse> = {}): ActivityFeedResponse {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    unreadCount: 0,
    ...overrides,
  };
}

async function flushEffects() {
  // Let the pending fetchActivityFeed() promise (and its setState) resolve.
  await React.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ActivityBar — Activity feed integration (batch 3-D)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockPush.mockClear();
    fetchActivityFeed.mockReset();
    ackActivityItem.mockClear();
    window.localStorage.clear();
    delete document.documentElement.dataset.visualTheme;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.useRealTimers();
  });

  it('shows the backend unread badge once the feed resolves', async () => {
    fetchActivityFeed.mockResolvedValue(feedResponse({ unreadCount: 3 }));

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });
    await flushEffects();

    const badge = container.querySelector('.slock-unread-badge');
    expect(badge?.textContent).toBe('3');
  });

  it('requests the selected filter tab from the backend', async () => {
    fetchActivityFeed.mockResolvedValue(feedResponse());

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });
    await flushEffects();

    const activityButton = container.querySelector('button[aria-label="Activity 聚合收件箱"]') as HTMLElement;
    React.act(() => {
      activityButton.click();
    });
    await flushEffects();

    const mentionsTab = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Mentions');
    expect(mentionsTab).toBeTruthy();
    fetchActivityFeed.mockClear();
    React.act(() => {
      mentionsTab!.click();
    });
    await flushEffects();

    expect(fetchActivityFeed).toHaveBeenCalledWith('mentions', { limit: 30 });
  });

  it('renders feed items with kind label and jumps + acks on click', async () => {
    fetchActivityFeed.mockResolvedValue(
      feedResponse({
        items: [
          {
            id: 'reply:thread-1:msg-1',
            kind: 'reply',
            threadId: 'thread-1',
            sourceThreadId: 'thread-1',
            threadTitle: '需求讨论',
            isBranch: false,
            messageId: 'msg-1',
            content: '收到，马上处理',
            catId: 'opus',
            timestamp: Date.now(),
            read: false,
          },
        ],
        unreadCount: 1,
      }),
    );

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });
    await flushEffects();

    const activityButton = container.querySelector('button[aria-label="Activity 聚合收件箱"]') as HTMLElement;
    React.act(() => {
      activityButton.click();
    });
    await flushEffects();

    expect(container.textContent).toContain('需求讨论');
    expect(container.textContent).toContain('收到，马上处理');

    const itemButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('需求讨论'));
    expect(itemButton).toBeTruthy();
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    React.act(() => {
      itemButton!.click();
    });
    await flushEffects();

    // Acks the underlying message and navigates (jsdom exercises the
    // window.history.pushState + CHAT_THREAD_ROUTE_EVENT branch, same as a
    // real browser — router.push is only used in the no-window/SSR branch).
    expect(ackActivityItem).toHaveBeenCalledWith('thread-1', 'msg-1');
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread-1?highlight=msg-1');
    pushStateSpy.mockRestore();
  });

  it('task_status items render the 任务 label', async () => {
    fetchActivityFeed.mockResolvedValue(
      feedResponse({
        items: [
          {
            id: 'task_status:t-1:m-1',
            kind: 'task_status',
            threadId: 't-1',
            sourceThreadId: 't-1',
            threadTitle: '任务频道',
            isBranch: false,
            messageId: 'm-1',
            content: '#1 状态：进行中 → 待验收。',
            catId: null,
            timestamp: Date.now(),
            read: false,
          },
        ],
        unreadCount: 1,
      }),
    );

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });
    await flushEffects();

    const activityButton = container.querySelector('button[aria-label="Activity 聚合收件箱"]') as HTMLElement;
    React.act(() => {
      activityButton.click();
    });
    await flushEffects();

    expect(container.textContent).toContain('任务');
    expect(container.textContent).toContain('#1 状态：进行中 → 待验收。');
  });

  it('falls back to "no activity" state when the backend feed is unavailable (returns null)', async () => {
    fetchActivityFeed.mockResolvedValue(null);

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });
    await flushEffects();

    // No backend feed and an empty local chatStore → badge absent.
    const badge = container.querySelector('.slock-unread-badge');
    expect(badge).toBeNull();

    const activityButton = container.querySelector('button[aria-label="Activity 聚合收件箱"]') as HTMLElement;
    React.act(() => {
      activityButton.click();
    });
    await flushEffects();

    expect(container.textContent).toContain('暂无需要处理的 Activity');
  });
});
