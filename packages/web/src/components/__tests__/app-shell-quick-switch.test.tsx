import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { AppShell } from '../AppShell';
import { CHAT_THREAD_ROUTE_EVENT } from '../ThreadSidebar/thread-navigation';

const mocks = vi.hoisted(() => ({
  pathname: '/',
  push: vi.fn(),
  clearUnread: vi.fn(),
  threads: [] as Thread[],
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (_key: string, initial: number) => [initial, vi.fn(), vi.fn()] as const,
}));

vi.mock('@/stores/chatStore', () => {
  const state = {
    get threads() {
      return mocks.threads;
    },
    clearUnread: mocks.clearUnread,
  };
  const hook = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  return { useChatStore: hook };
});

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../ActivityBar', () => ({ ActivityBar: () => React.createElement('div', { 'data-testid': 'activity-bar' }) }));
vi.mock('../ThreadSidebar', () => ({
  ThreadSidebar: () => React.createElement('div', { 'data-testid': 'thread-sidebar' }),
}));
vi.mock('../workspace/ResizeHandle', () => ({
  ResizeHandle: () => React.createElement('div', { 'data-testid': 'resize-handle' }),
}));

function makeThread(id: string, title: string, lastActiveAt = 1): Thread {
  return {
    id,
    projectPath: 'default',
    title,
    createdBy: 'user',
    participants: [],
    lastActiveAt,
    createdAt: 1,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AppShell quick switcher', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.pathname = '/thread/thread-a';
    mocks.push.mockClear();
    mocks.clearUnread.mockClear();
    mocks.threads = [makeThread('thread-a', '大厅备忘', 1), makeThread('thread-roadmap', '路线图', 10)];
    window.history.pushState({}, '', '/thread/thread-a');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('opens with command-k, filters threads, and jumps on Enter', async () => {
    const routeEvents: string[] = [];
    window.addEventListener(CHAT_THREAD_ROUTE_EVENT, (event) => routeEvents.push(event.type), { once: true });

    await act(async () => {
      root.render(React.createElement(AppShell, null, React.createElement('main', null, 'content')));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    });

    const input = container.querySelector('[data-testid="quick-switch-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, '路线');
    });

    expect(container.textContent).toContain('路线图');

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(mocks.clearUnread).toHaveBeenCalledWith('thread-roadmap');
    expect(window.location.pathname).toBe('/thread/thread-roadmap');
    expect(routeEvents).toEqual([CHAT_THREAD_ROUTE_EVENT]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('uses router navigation when opened from a hidden-sidebar page', async () => {
    const routeEvents: string[] = [];
    mocks.pathname = '/search';
    window.history.pushState({}, '', '/search');
    window.addEventListener(CHAT_THREAD_ROUTE_EVENT, (event) => routeEvents.push(event.type), { once: true });

    await act(async () => {
      root.render(React.createElement(AppShell, null, React.createElement('main', null, 'search')));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    });

    const input = container.querySelector('[data-testid="quick-switch-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, '路线');
    });

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(mocks.clearUnread).toHaveBeenCalledWith('thread-roadmap');
    expect(mocks.push).toHaveBeenCalledWith('/thread/thread-roadmap');
    expect(routeEvents).toEqual([]);
  });
});
