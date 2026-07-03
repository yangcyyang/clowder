import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandPicker } from '../SlashCommandPicker';

const mocks = {
  apiFetch: vi.fn(),
};

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

describe('SlashCommandPicker command registry integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads project workflow commands from the unified command registry', async () => {
    const onItemsChange = vi.fn();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          commands: [
            {
              name: '/continue-project',
              usage: '/continue-project [projectId]',
              description: '读取项目事实源并输出接手摘要',
              category: 'project',
              surface: 'both',
              source: 'skill',
              skillId: 'project-workflow',
            },
            {
              name: '/project-status',
              usage: '/project-status [projectId]',
              description: '查看项目事实源中的当前状态',
              category: 'project',
              surface: 'both',
              source: 'skill',
              skillId: 'project-workflow',
            },
          ],
        }),
    });

    await act(async () => {
      root.render(
        React.createElement(SlashCommandPicker, {
          query: 'project',
          selectedIdx: 0,
          onSelectIdx: vi.fn(),
          onPick: vi.fn(),
          onItemsChange,
        }),
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain('/continue-project'));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/commands?surface=web');
    expect(container.textContent).toContain('/project-status');
    expect(container.textContent).toContain('project-workflow');
    expect(onItemsChange.mock.calls.at(-1)?.[0].map((item: { command: string }) => item.command)).toEqual([
      '/continue-project',
      '/project-status',
    ]);
  });
});
