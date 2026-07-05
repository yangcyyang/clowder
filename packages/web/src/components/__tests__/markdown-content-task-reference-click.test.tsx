/**
 * #N task reference click behavior — opens the task's right-side thread via
 * TaskThreadActionsContext when a provider is present (Raft-aligned), and
 * falls back to the pre-existing scrollIntoView behavior when it is not
 * (e.g. MarkdownContent used outside ChatContainer/InlineThreadPanel).
 */

import type { TaskItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskThreadActionsContext } from '@/contexts/TaskThreadActionsContext';
import { useTaskStore } from '@/stores/taskStore';
import { MarkdownContent } from '../MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

const TASK: TaskItem = {
  id: 'task-328',
  kind: 'work',
  threadId: 'thread-1',
  subjectKey: null,
  title: '验收快车道',
  ownerCatId: null,
  status: 'in_review',
  why: '',
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 1,
  sourceMessageId: 'msg-328',
};

describe('TaskReferenceLink click routing', () => {
  afterEach(() => {
    useTaskStore.setState({ tasks: [] });
  });

  it('calls openTaskThread(task) when TaskThreadActionsContext is provided', async () => {
    useTaskStore.setState({ tasks: [TASK] });
    const openTaskThread = vi.fn();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TaskThreadActionsContext.Provider value={{ openTaskThread }}>
          <MarkdownContent content="请看 task #1 的验收状态" disableCommandPrefix />
        </TaskThreadActionsContext.Provider>,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('[data-task-ref-link]');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(openTaskThread).toHaveBeenCalledTimes(1);
    expect(openTaskThread).toHaveBeenCalledWith(TASK);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to scrollIntoView when no TaskThreadActionsContext is present', async () => {
    useTaskStore.setState({ tasks: [TASK] });

    const sourceMessage = document.createElement('div');
    sourceMessage.setAttribute('data-message-id', 'msg-328');
    document.body.appendChild(sourceMessage);
    const scrollSpy = vi.fn();
    sourceMessage.scrollIntoView = scrollSpy;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownContent content="请看 task #1 的验收状态" disableCommandPrefix />);
    });

    const button = container.querySelector<HTMLButtonElement>('[data-task-ref-link]');
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(scrollSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    sourceMessage.remove();
  });

  it('renders the chip as pointer-cursor and clickable regardless of provider', async () => {
    useTaskStore.setState({ tasks: [TASK] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownContent content="task #1" disableCommandPrefix />);
    });

    const button = container.querySelector<HTMLButtonElement>('[data-task-ref-link]');
    expect(button?.className).toContain('cursor-pointer');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
