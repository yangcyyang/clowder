/**
 * 复刻 Raft 的"长消息默认折叠"体验（铲屎官带截图指定，2026-07-27）。
 *
 * 红→绿：改动前 CollapsibleMessageBody.tsx 不存在，这些断言必然失败（红）；
 * 实现后（max-height + 底部渐隐遮罩 + Show more/Collapse 按钮，用 scrollHeight
 * 判定是否需要折叠）转绿。
 *
 * jsdom 不跑真实布局，scrollHeight/clientHeight 恒为 0——按仓库既有惯例
 * （见 scroll-to-bottom-button.test.ts 的 defineNumberProp）用 Object.defineProperty
 * 在 HTMLElement.prototype 上打一个可控的 scrollHeight getter，模拟"真实渲染后的
 * 内容高度"，覆盖整个组件树里任意元素的读数（这个测试文件里只有
 * CollapsibleMessageBody 自己的 contentRef 会读它，不会误伤别处）。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollapsibleMessageBody } from '@/components/CollapsibleMessageBody';

let mockScrollHeight = 0;
let originalScrollHeightDescriptor: PropertyDescriptor | undefined;

describe('CollapsibleMessageBody', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return mockScrollHeight;
      },
    });
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    if (originalScrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeightDescriptor);
    }
  });

  beforeEach(() => {
    mockScrollHeight = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderBody(props: Partial<{ disabled: boolean; fadeBackgroundVar: string }> = {}) {
    act(() => {
      root.render(
        React.createElement(
          CollapsibleMessageBody,
          props,
          React.createElement('p', { key: 'c' }, 'long body text'.repeat(50)),
        ),
      );
    });
  }

  function getToggle(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="collapsible-message-toggle"]');
  }

  function getFade(): HTMLElement | null {
    return container.querySelector('[data-testid="collapsible-message-fade"]');
  }

  // ① 超长内容渲染出折叠态与 Show more 按钮
  it('long content (scrollHeight far past the threshold) renders collapsed with a fade mask and a Show more button', () => {
    mockScrollHeight = 900; // > 400 * 1.25 = 500
    renderBody();

    const toggle = getToggle();
    expect(toggle).toBeTruthy();
    expect(toggle?.textContent).toBe('Show more');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(getFade()).toBeTruthy();
  });

  // ② 点击展开后内容完整可见且出现 Collapse，再点收起
  it('clicking Show more reveals full content and swaps to Collapse; clicking again re-collapses', async () => {
    mockScrollHeight = 900;
    renderBody();

    expect(getToggle()?.textContent).toBe('Show more');

    await act(async () => {
      getToggle()?.click();
    });

    expect(getToggle()?.textContent).toBe('Collapse');
    expect(getToggle()?.getAttribute('aria-expanded')).toBe('true');
    // Expanded: content div no longer clipped, fade mask removed.
    expect(getFade()).toBeNull();

    await act(async () => {
      getToggle()?.click();
    });

    expect(getToggle()?.textContent).toBe('Show more');
    expect(getToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(getFade()).toBeTruthy();
  });

  // ③ 短消息不渲染任何折叠控件
  it('short content renders no fold controls at all', () => {
    mockScrollHeight = 120;
    renderBody();

    expect(getToggle()).toBeNull();
    expect(getFade()).toBeNull();
  });

  it('content just past the raw 400px threshold but inside the 1.25x buffer does NOT fold (avoids a barely-over-threshold experience)', () => {
    mockScrollHeight = 450; // > 400 but < 400*1.25=500
    renderBody();

    expect(getToggle()).toBeNull();
  });

  it('content clearly past the 1.25x buffer (>500px) does fold', () => {
    mockScrollHeight = 520;
    renderBody();

    expect(getToggle()).toBeTruthy();
  });

  // ④ 流式中的消息不折叠
  it('disabled=true (the streaming case) never folds regardless of height', () => {
    mockScrollHeight = 900;
    renderBody({ disabled: true });

    expect(getToggle()).toBeNull();
    expect(getFade()).toBeNull();
    expect(container.textContent).toContain('long body text');
  });

  it('toggle click does not bubble to an ancestor click handler (stopPropagation guards message selection)', async () => {
    mockScrollHeight = 900;
    const parentClick = vi.fn();
    act(() => {
      root.render(
        React.createElement(
          'div',
          { onClick: parentClick },
          React.createElement(CollapsibleMessageBody, {}, React.createElement('p', null, 'x'.repeat(2000))),
        ),
      );
    });

    await act(async () => {
      getToggle()?.click();
    });

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('toggle is a real, keyboard-focusable button with aria-expanded', () => {
    mockScrollHeight = 900;
    renderBody();
    const toggle = getToggle();
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('type')).toBe('button');
    expect(toggle?.hasAttribute('aria-expanded')).toBe(true);
    // Real <button> elements are focusable by default (no explicit tabindex needed);
    // confirm nothing disables that.
    expect(toggle?.hasAttribute('disabled')).toBe(false);
    expect(toggle?.getAttribute('tabindex')).not.toBe('-1');
  });

  it('fade mask color follows the caller-supplied fadeBackgroundVar (e.g. whisper bubble bg), not a hardcoded color', () => {
    mockScrollHeight = 900;
    renderBody({ fadeBackgroundVar: '--conn-amber-bg' });

    const fade = getFade();
    expect(fade?.style.background).toContain('var(--conn-amber-bg)');
  });
});
