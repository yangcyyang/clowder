/**
 * 理智线自动交接包折叠卡片（cy 2026-07-26）。
 * 铲屎官原话："理智线交接的这种内容属于系统消息，可以折叠起来，我有需要再自己点击展开"。
 * 默认折叠为一行摘要；点击展开显示全文；再点收起。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('pre', null, content),
}));

const { SanityHandoffCard } = await import('@/components/SanityHandoffCard');

const RED_CAPSULE = [
  '## 理智线自动交接包（🔴 红区）',
  '目标（推断，非精确）：（消息推断）修复 F183 seq gap 检测',
  '背景：未明确',
  '约束：禁止 git stash',
  '已完成：修复了 seq 越界判定',
  '已验证：回归全绿',
  '废弃方案：未明确',
  '未解决：待补充边界测试',
  '下一步：继续推进 Phase D',
  '必读文件：packages/web/src/hooks/useAgentMessages.ts',
].join('\n');

const YELLOW_CAPSULE = RED_CAPSULE.replace('🔴 红区', '🟡 黄区');

describe('SanityHandoffCard', () => {
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

  it('defaults to collapsed — shows a one-line summary, not the full capsule body', () => {
    act(() => {
      root.render(React.createElement(SanityHandoffCard, { content: RED_CAPSULE }));
    });

    expect(container.textContent).toContain('理智线交接包');
    expect(container.textContent).toContain('点击展开');
    expect(container.querySelector('[data-testid="sanity-handoff-body"]')).toBeNull();
    // Full capsule text must not leak into the collapsed DOM.
    expect(container.textContent).not.toContain('修复了 seq 越界判定');
  });

  it('shows the red emoji for a red-zone capsule', () => {
    act(() => {
      root.render(React.createElement(SanityHandoffCard, { content: RED_CAPSULE }));
    });
    expect(container.textContent).toContain('🔴');
    expect(container.textContent).not.toContain('🟡');
  });

  it('shows the yellow emoji for a yellow-zone capsule', () => {
    act(() => {
      root.render(React.createElement(SanityHandoffCard, { content: YELLOW_CAPSULE }));
    });
    expect(container.textContent).toContain('🟡');
    expect(container.textContent).not.toContain('🔴');
  });

  it('expands to show the full capsule body on click, then collapses again on a second click', async () => {
    act(() => {
      root.render(React.createElement(SanityHandoffCard, { content: RED_CAPSULE }));
    });

    const toggle = container.querySelector('[data-testid="sanity-handoff-toggle"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle.click();
    });

    expect(container.textContent).toContain('点击收起');
    expect(container.querySelector('[data-testid="sanity-handoff-body"]')).toBeTruthy();
    expect(container.textContent).toContain('修复了 seq 越界判定');

    await act(async () => {
      toggle.click();
    });

    expect(container.textContent).toContain('点击展开');
    expect(container.querySelector('[data-testid="sanity-handoff-body"]')).toBeNull();
  });
});
