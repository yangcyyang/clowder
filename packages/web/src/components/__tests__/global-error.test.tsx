import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalError from '@/app/global-error';

describe('GlobalError', () => {
  let container: Document;
  let root: Root;
  let originalLocation: Location;
  const reload = vi.fn();

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalLocation = window.location;
  });

  beforeEach(() => {
    reload.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    container = document.implementation.createHTMLDocument();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderError(reset: () => void) {
    act(() => {
      root.render(<GlobalError error={new Error('boom')} reset={reset} />);
    });
  }

  it('renders a visible fallback and lets the primary action reset first', () => {
    const reset = vi.fn();
    renderError(reset);

    expect(container.documentElement.textContent).toContain('Clowder 页面加载失败');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent === '重新加载')).toBe(true);

    act(() => buttons.find((button) => button.textContent === '重试页面')?.click());

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('falls back to a hard reload when reset throws', () => {
    const reset = vi.fn(() => {
      throw new Error('reset failed');
    });
    renderError(reset);

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '重试页面')
        ?.click();
    });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a separate explicit hard reload action', () => {
    renderError(vi.fn());

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '重新加载')
        ?.click();
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
