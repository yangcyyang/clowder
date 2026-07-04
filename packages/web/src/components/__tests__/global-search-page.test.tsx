import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const backMock = vi.fn();
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    back: backMock,
    push: pushMock,
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 })),
}));

import { GlobalSearchPage } from '@/components/GlobalSearchPage';
import { apiFetch } from '@/utils/api-client';

describe('GlobalSearchPage keyboard navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    backMock.mockClear();
    pushMock.mockClear();
    vi.mocked(apiFetch).mockClear();
    window.history.pushState({}, '', '/search');
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

  it('goes back when pressing Escape', async () => {
    await act(async () => {
      root.render(<GlobalSearchPage />);
    });

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(escapeEvent);
    });

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(backMock).toHaveBeenCalledTimes(1);
  });

  it('uses the same back action from the visible ESC button', async () => {
    await act(async () => {
      root.render(<GlobalSearchPage />);
    });

    const button = container.querySelector('button[aria-label="返回上一页"]') as HTMLButtonElement | null;
    if (!button) throw new Error('Missing ESC button');

    await act(async () => {
      button.click();
    });

    expect(backMock).toHaveBeenCalledTimes(1);
  });

  it('runs the message search from q query param', async () => {
    window.history.pushState({}, '', '/search?q=%E8%B7%AF%E7%BA%BF');

    await act(async () => {
      root.render(<GlobalSearchPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/messages/search?q=%E8%B7%AF%E7%BA%BF&limit=50');
  });

  it('reruns message search when q changes on the mounted page', async () => {
    await act(async () => {
      root.render(<GlobalSearchPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.mocked(apiFetch).mockClear();

    window.history.pushState({}, '', '/search?q=%E6%96%B0%E7%BA%BF%E7%B4%A2');

    await act(async () => {
      root.render(<GlobalSearchPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/messages/search?q=%E6%96%B0%E7%BA%BF%E7%B4%A2&limit=50');
  });
});
