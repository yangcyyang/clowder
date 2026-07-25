import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileInputToolbar } from '@/components/MobileInputToolbar';

describe('MobileInputToolbar', () => {
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
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(props: Partial<React.ComponentProps<typeof MobileInputToolbar>> = {}) {
    const defaults = {
      onAttach: vi.fn(),
      onWhisperToggle: vi.fn(),
      onClose: vi.fn(),
      ...props,
    };
    act(() => {
      root.render(React.createElement(MobileInputToolbar, defaults));
    });
    return defaults;
  }

  it('renders attach and whisper actions (no game entry)', () => {
    render();
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(container.textContent).toContain('附件');
    expect(container.textContent).toContain('悄悄话');
    expect(container.textContent).not.toContain('游戏');
  });

  it('calls onWhisperToggle + onClose when whisper button is clicked', () => {
    const fns = render();
    const whisperBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('悄悄话'),
    );
    act(() => {
      whisperBtn?.click();
    });
    expect(fns.onWhisperToggle).toHaveBeenCalledTimes(1);
    expect(fns.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onAttach + onClose when attach button is clicked', () => {
    const fns = render();
    const attachBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('附件'));
    act(() => {
      attachBtn?.click();
    });
    expect(fns.onAttach).toHaveBeenCalledTimes(1);
    expect(fns.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables attachment when disabled prop is set', () => {
    render({ disabled: true });
    const attachBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('附件'));
    expect(attachBtn?.disabled).toBe(true);
  });
});
