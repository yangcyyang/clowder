import type { TaskItem } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

function makeTasks(): TaskItem[] {
  const base = {
    kind: 'work' as const,
    threadId: 't1',
    subjectKey: null,
    why: 'test reason',
    createdBy: 'user' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerCatId: null,
  };
  return [
    { ...base, id: '1', title: 'Doing task', status: 'doing' },
    { ...base, id: '2', title: 'Review task', status: 'in_review' },
    { ...base, id: '3', title: 'Todo task', status: 'todo' },
    { ...base, id: '4', title: 'Done task', status: 'done' },
    { ...base, id: '5', title: 'Blocked task', status: 'blocked' },
  ];
}

let mockTasks: TaskItem[] = [];

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (selector: (s: { tasks: TaskItem[]; updateTask: (task: TaskItem) => void }) => unknown) =>
    selector({ tasks: mockTasks, updateTask: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { currentThreadId: string | null }) => unknown) =>
    selector({ currentThreadId: 'thread-1' }),
}));

vi.mock('../TaskComposer', () => ({
  TaskComposer: () => <div data-testid="task-composer" />,
}));

describe('TaskBoardPanel', () => {
  beforeEach(() => {
    mockTasks = [];
    delete process.env.NEXT_PUBLIC_CAT_CAFE_INVOCATION_COST_PANEL;
    delete process.env.NEXT_PUBLIC_CAT_CAFE_USAGE_COST_PANEL;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('taskboard-collapsed');
    }
  });

  it('renders five status sections in correct order: doing, in_review, blocked, todo, done', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    const sections = ['进行中', '待验收', '阻塞中', '待办', '已完成'];
    for (const label of sections) {
      expect(html).toContain(label);
    }
    const positions = sections.map((s) => html.indexOf(s));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('shows doing, in_review, and blocked task items (expanded by default)', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('Doing task');
    expect(html).toContain('Review task');
    expect(html).toContain('Blocked task');
  });

  it('hides todo and done task items (collapsed by default)', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).not.toContain('Todo task');
    expect(html).not.toContain('Done task');
  });

  it('renders header with stats badge', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('毛线球');
    expect(html).toContain('待处理 2');
  });

  it('renders blocked section with red highlight', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('bg-conn-red-bg');
  });

  it('shows empty state with guidance when no tasks', async () => {
    mockTasks = [];
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('把长期事项挂在线上');
    expect(html).toContain('创建第一颗毛线球');
    expect(html).toContain('何时该用毛线球');
  });

  it('respects localStorage collapse preference on render', async () => {
    mockTasks = makeTasks();
    // Simulate user having previously expanded todo section
    localStorage.setItem(
      'taskboard-collapsed',
      JSON.stringify({ todo: false, done: true, doing: false, in_review: false, blocked: false }),
    );
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    // todo section was set to not-collapsed, so its task should be visible
    expect(html).toContain('Todo task');
    // done section is still collapsed
    expect(html).not.toContain('Done task');
  });

  it('hides invocation cost summary by default even when usage events exist', async () => {
    mockTasks = [
      {
        ...makeTasks()[0],
        events: [
          {
            ts: new Date().toISOString(),
            catId: 'codex',
            type: 'usage',
            data: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.12, durationMs: 2300 },
          },
        ],
      },
    ];
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).not.toContain('1.5k tok');
    expect(html).not.toContain('$0.12');
  });

  it('shows invocation token cost summary when feature flag is enabled', async () => {
    process.env.NEXT_PUBLIC_CAT_CAFE_INVOCATION_COST_PANEL = '1';
    mockTasks = [
      {
        ...makeTasks()[0],
        events: [
          {
            ts: new Date().toISOString(),
            catId: 'codex',
            type: 'usage',
            data: {
              provider: 'openai',
              model: 'gpt-5.5',
              inputTokens: 1000,
              cacheReadTokens: 300,
              cacheCreationTokens: 100,
              outputTokens: 500,
              totalTokens: 1500,
              costUsd: 0.12,
              durationMs: 2300,
              sourceBreakdown: {
                totalEstimatedTokens: 1000,
                sources: [
                  { source: 'history', chars: 2400, estimatedTokens: 600 },
                  { source: 'rules', chars: 1600, estimatedTokens: 400 },
                ],
              },
            },
          },
        ],
      },
    ];
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('1.5k tok');
    expect(html).toContain('$0.12');
    expect(html).toContain('2.3s');
  });
});
