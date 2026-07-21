/**
 * #404-interaction item 1: task card collapse must be a smooth CSS transition
 * (grid-template-rows 0fr/1fr), not an instant JSX-tree swap. Locks in: one
 * persistent header that toggles aria-expanded + compact/full title text, and
 * a detail wrapper whose gridTemplateRows style flips between '0fr'/'1fr'
 * (detail content stays mounted in both states so it can animate).
 */

import type { TaskItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InlineThreadTaskStatusCard, taskCardCollapsedStorageKey } from '@/components/InlineThreadPanel';

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: '折叠过渡验收',
    ownerCatId: 'opus',
    status: 'doing',
    why: '',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    evidence: {},
    ...overrides,
  } as TaskItem;
}

describe('InlineThreadTaskStatusCard collapse transition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('defaults expanded: header aria-expanded=true, detail wrapper gridTemplateRows=1fr, detail content present', async () => {
    await act(async () => {
      root.render(<InlineThreadTaskStatusCard task={makeTask()} threadId="thread-1" />);
    });

    const header = container.querySelector('button[aria-label="折叠任务 Thread 状态"]') as HTMLButtonElement;
    expect(header).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('任务目标');
    expect(container.textContent).toContain('交付证据');

    const detailWrapper = container.querySelector('.grid.transition-\\[grid-template-rows\\]') as HTMLElement;
    expect(detailWrapper?.style.gridTemplateRows).toBe('1fr');
  });

  it('click toggles to collapsed: aria-expanded=false, compact title text, gridTemplateRows=0fr, detail content still mounted', async () => {
    await act(async () => {
      root.render(<InlineThreadTaskStatusCard task={makeTask()} threadId="thread-1" />);
    });

    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => {
      header.click();
    });

    const collapsedHeader = container.querySelector('button[aria-label="展开任务 Thread 状态"]') as HTMLButtonElement;
    expect(collapsedHeader).toBeTruthy();
    expect(collapsedHeader.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedHeader.textContent).toContain('任务 · 折叠过渡验收');
    expect(container.textContent).not.toContain('任务目标');

    const detailWrapper = container.querySelector('.grid.transition-\\[grid-template-rows\\]') as HTMLElement;
    expect(detailWrapper?.style.gridTemplateRows).toBe('0fr');
    // Detail content stays in the DOM (so the collapse animates instead of popping) — just visually clipped.
    expect(container.textContent).toContain('交付证据');
  });

  it('persists collapsed state to localStorage keyed by threadId, restored on remount', async () => {
    await act(async () => {
      root.render(<InlineThreadTaskStatusCard task={makeTask()} threadId="thread-42" />);
    });
    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    expect(window.localStorage.getItem(taskCardCollapsedStorageKey('thread-42'))).toBe('1');

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<InlineThreadTaskStatusCard task={makeTask()} threadId="thread-42" />);
    });
    expect(container.querySelector('button[aria-label="展开任务 Thread 状态"]')).toBeTruthy();
  });
});
