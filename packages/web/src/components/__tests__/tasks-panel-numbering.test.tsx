/**
 * [thread-task-design item 4] Root cause: TaskCardView rendered
 * `#{task.id.slice(0, 6)}` as the card's "编号". Task ids come from
 * generateSortableId() (packages/api/.../ports/MessageStore.ts:461-466): a
 * 16-digit zero-padded epoch-ms timestamp + 6-digit sequence + uuid suffix.
 * The first 6 characters are therefore just "000" + the leading 3 digits of
 * the millisecond timestamp, which only change roughly every ~115 days
 * (10^10 ms) — every task created within the same ~4-month window collapsed
 * onto the same label. Real-world symptom: 79 cards, 2 distinct numbers
 * (#000178 / #000177 everywhere).
 *
 * Fix: labels must be computed the same way the backend's getTaskLabel does
 * (packages/api/src/routes/tasks.ts) — 1-based position in creation (ascending
 * id) order — via TasksPanel.computeTaskLabels, independent of the
 * updatedAt-based display sort used for column grouping.
 */
import type { TaskItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTaskLabels, TasksPanel } from '@/components/TasksPanel';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/components/TaskComposer', () => ({
  TaskComposer: () => <div data-testid="task-composer" />,
}));

// Realistic generateSortableId()-shaped ids: all three share the same leading 6
// characters ("000178"), exactly reproducing the real bug's timestamp-prefix
// collision — see module doc comment above.
function makeTask(overrides: Partial<TaskItem>): TaskItem {
  return {
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: 'untitled',
    ownerCatId: null,
    status: 'todo',
    why: '',
    createdBy: 'user',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as TaskItem;
}

const TASK_1 = makeTask({
  id: '0001784800000000-000001-aaaaaaaa',
  title: 'First Task',
  createdAt: 100,
  updatedAt: 100,
});
const TASK_2 = makeTask({
  id: '0001784800000000-000002-bbbbbbbb',
  title: 'Second Task',
  createdAt: 200,
  updatedAt: 200,
});
const TASK_3 = makeTask({
  id: '0001784800000000-000003-cccccccc',
  title: 'Third Task',
  createdAt: 300,
  updatedAt: 300,
});

describe('computeTaskLabels (pure)', () => {
  it('assigns 1-based labels by ascending id order, not array/display order', () => {
    // Deliberately out of creation order, mirroring how TasksPanel's sortedTasks
    // (updatedAt desc, for column display) differs from creation order.
    const labels = computeTaskLabels([TASK_3, TASK_1, TASK_2]);
    expect(labels.get(TASK_1.id)).toBe(1);
    expect(labels.get(TASK_2.id)).toBe(2);
    expect(labels.get(TASK_3.id)).toBe(3);
  });

  it('red-test proof: the old `task.id.slice(0, 6)` scheme collapses all three onto one label', () => {
    // This is the exact bug: all three ids share the same leading 6 chars.
    const collapsed = new Set([TASK_1, TASK_2, TASK_3].map((t) => t.id.slice(0, 6)));
    expect(collapsed.size).toBe(1);
    // The fix must NOT reproduce that collapse:
    const labels = computeTaskLabels([TASK_1, TASK_2, TASK_3]);
    expect(new Set(labels.values()).size).toBe(3);
  });
});

describe('TasksPanel card numbering (rendered)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [TASK_1, TASK_2, TASK_3] }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders each card with its own distinct #<label>, decoupled from column display order', async () => {
    await act(async () => {
      root.render(<TasksPanel threadId="thread-1" />);
    });
    // Let the fetch effect resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const html = container.innerHTML;
    expect(html).toContain('First Task');
    expect(html).toContain('Second Task');
    expect(html).toContain('Third Task');

    // Every card must show a distinct, small sequential label — never the
    // collapsed-timestamp string ("#000178") the old code rendered.
    expect(html).not.toContain('#000178');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('#3');

    const articles = Array.from(container.querySelectorAll('article'));
    const labelFor = (title: string) => {
      const article = articles.find((el) => el.textContent?.includes(title));
      const labelNode = Array.from(article?.querySelectorAll('div') ?? []).find((div) =>
        /^#\d+$/.test(div.textContent?.trim() ?? ''),
      );
      return labelNode?.textContent?.trim();
    };
    expect(labelFor('First Task')).toBe('#1');
    expect(labelFor('Second Task')).toBe('#2');
    expect(labelFor('Third Task')).toBe('#3');
  });
});
