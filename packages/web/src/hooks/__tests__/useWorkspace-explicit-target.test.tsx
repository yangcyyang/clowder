// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setWorktreeId: vi.fn(),
  state: {
    currentProjectPath: '/workspace/current-project',
    workspaceExplicitTargetWorktreeId: 'explicit-target' as string | null,
    workspaceOpenFilePath: 'docs/ClowderAI-功能清单.md',
    workspaceWorktreeId: 'explicit-target',
  },
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ ...mocks.state, setWorkspaceWorktreeId: mocks.setWorktreeId }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('@/utils/socket-url', () => ({
  ensureSocketSession: vi.fn().mockResolvedValue(undefined),
  SOCKET_URL: 'http://127.0.0.1:3004',
}));

vi.mock('socket.io-client', () => ({
  io: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
  }),
}));

import { useWorkspace } from '@/hooks/useWorkspace';

describe('useWorkspace explicit cross-project target', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useWorkspace> | null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    mocks.state.workspaceExplicitTargetWorktreeId = 'explicit-target';
    mocks.setWorktreeId.mockReset();
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workspace/worktrees?')) {
        return {
          ok: true,
          json: async () => ({
            worktrees: [{ id: 'current-project', root: '/workspace/current-project', branch: 'main', head: 'aaaa' }],
          }),
        };
      }
      if (url === '/api/workspace/worktrees') {
        return {
          ok: true,
          json: async () => ({
            worktrees: [
              { id: 'explicit-target', root: '/workspace/target', branch: 'notes', head: 'bbbb' },
              { id: 'current-project', root: '/workspace/current-project', branch: 'main', head: 'aaaa' },
            ],
          }),
        };
      }
      if (url.startsWith('/api/workspace/file?')) {
        return {
          ok: true,
          json: async () => ({
            path: 'docs/ClowderAI-功能清单.md',
            content: '# ClowderAI 完整功能清单',
            sha256: 'sha',
            size: 32,
            mime: 'text/markdown',
            truncated: false,
          }),
        };
      }
      return { ok: true, json: async () => ({ tree: [] }) };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps an explicitly opened file target available when it is outside the current project filter', async () => {
    function Host() {
      latest = useWorkspace();
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Host));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/workspace/worktrees');
    expect(latest?.worktrees.map((worktree) => worktree.id)).toContain('explicit-target');
    expect(mocks.setWorktreeId).not.toHaveBeenCalledWith('current-project');
  });

  it('uses the scoped project worktree for an ordinary file when no explicit target is pending', async () => {
    mocks.state.workspaceExplicitTargetWorktreeId = null;

    function Host() {
      latest = useWorkspace();
      return null;
    }

    await act(async () => {
      root.render(React.createElement(Host));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.apiFetch).not.toHaveBeenCalledWith('/api/workspace/worktrees');
    expect(mocks.setWorktreeId).toHaveBeenCalledWith('current-project');
  });
});
