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
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 })),
}));

import { GlobalSearchPage } from '@/components/GlobalSearchPage';

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

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(escape);
    });

    expect(escape.defaultPrevented).toBe(true);
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
});
