import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getThreadIdFromPathname } = vi.hoisted(() => ({
  getThreadIdFromPathname: vi.fn((pathname: string) => {
    const match = pathname.match(/^\/thread\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : 'default';
  }),
}));

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/thread/thread-abc',
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

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname,
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

import { ActivityBar } from '@/components/ActivityBar';

describe('ActivityBar referrer forwarding (P2 fix)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockPush.mockClear();
    window.localStorage.clear();
    delete document.documentElement.dataset.visualTheme;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('appends ?from=threadId when navigating from /thread/xxx to mission hub', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const missionBtn = container.querySelector('button[title="任务"]') as HTMLElement;
    expect(missionBtn).toBeTruthy();

    React.act(() => {
      missionBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/mission-hub?from=thread-abc');
  });

  it('does not render global search as a primary rail entry', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const searchBtn = container.querySelector('button[title="搜索"]') as HTMLElement;
    expect(searchBtn).toBeNull();
  });

  it('appends ?from=threadId when navigating to memory', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const memoryBtn = container.querySelector('button[title="记忆"]') as HTMLElement;
    expect(memoryBtn).toBeTruthy();

    React.act(() => {
      memoryBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/memory?from=thread-abc');
  });

  it('does NOT append ?from= when clicking the home button', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const homeBtn = container.querySelector('button[title="对话"]') as HTMLElement;
    expect(homeBtn).toBeTruthy();

    React.act(() => {
      homeBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('does NOT append ?from= when already on root (default thread)', () => {
    getThreadIdFromPathname.mockReturnValueOnce('default');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const missionBtn = container.querySelector('button[title="任务"]') as HTMLElement;
    React.act(() => {
      missionBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/mission-hub');
  });

  it('forwards existing ?from= when cross-hopping between non-thread pages', () => {
    getThreadIdFromPathname.mockReturnValueOnce('default');
    const originalSearch = window.location.search;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?from=thread-abc' },
      writable: true,
      configurable: true,
    });

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const memoryBtn = container.querySelector('button[title="记忆"]') as HTMLElement;
    expect(memoryBtn).toBeTruthy();

    React.act(() => {
      memoryBtn.click();
    });

    expect(mockPush).toHaveBeenCalledWith('/memory?from=thread-abc');

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    });
  });

  it('keeps stored Claude visual theme across default-version bumps', () => {
    window.localStorage.setItem('clowder:visual-theme-default:v3', '1');
    window.localStorage.setItem('clowder:visual-theme', 'claude');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    expect(document.documentElement.dataset.visualTheme).toBe('claude');
    expect(window.localStorage.getItem('clowder:visual-theme')).toBe('claude');
    expect(window.localStorage.getItem('clowder:visual-theme-default:v4')).toBe('1');
  });

  it('keeps explicit Slock v1 visual theme after v4 default migration is complete', () => {
    window.localStorage.setItem('clowder:visual-theme-default:v4', '1');
    window.localStorage.setItem('clowder:visual-theme', 'slockv1');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    expect(document.documentElement.dataset.visualTheme).toBe('slockv1');
    expect(window.localStorage.getItem('clowder:visual-theme')).toBe('slockv1');
  });

  it('keeps explicit KAMI visual theme after v4 default migration is complete', () => {
    window.localStorage.setItem('clowder:visual-theme-default:v4', '1');
    window.localStorage.setItem('clowder:visual-theme', 'kami');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    expect(document.documentElement.dataset.visualTheme).toBe('kami');
    expect(window.localStorage.getItem('clowder:visual-theme')).toBe('kami');
  });

  it('migrates legacy Tesla visual theme to Slock v1', () => {
    window.localStorage.setItem('clowder:visual-theme-default:v4', '1');
    window.localStorage.setItem('clowder:visual-theme', 'tesla');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    expect(document.documentElement.dataset.visualTheme).toBe('slockv1');
    expect(window.localStorage.getItem('clowder:visual-theme')).toBe('slockv1');
  });
});
