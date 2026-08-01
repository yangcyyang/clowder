import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  useChatStore: vi.fn(),
  useFileManagement: vi.fn(),
  usePersistedState: vi.fn(),
  useWorkspace: vi.fn(),
  useWorkspaceSearch: vi.fn(),
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: (...args: unknown[]) => mocks.useWorkspace(...args),
}));
vi.mock('@/hooks/useWorkspaceSearch', () => ({
  useWorkspaceSearch: (...args: unknown[]) => mocks.useWorkspaceSearch(...args),
}));
vi.mock('@/hooks/useFileManagement', () => ({
  useFileManagement: (...args: unknown[]) => mocks.useFileManagement(...args),
}));
vi.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (...args: unknown[]) => mocks.usePersistedState(...args),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (store: Record<string, unknown>) => unknown) => mocks.useChatStore(selector),
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

vi.mock('@/components/memory/RecallFeed', () => ({ RecallFeed: () => null }));
vi.mock('@/components/TaskBoardPanel', () => ({ TaskBoardPanel: () => null }));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/workspace/BrowserPanel', () => ({ BrowserPanel: () => null }));
vi.mock('@/components/workspace/ChangesPanel', () => ({ ChangesPanel: () => null }));
vi.mock('@/components/workspace/FileIcons', () => ({ FileIcon: () => null }));
vi.mock('@/components/workspace/FocusModeButton', () => ({ FocusModeButton: () => null }));
vi.mock('@/components/workspace/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('@/components/workspace/LinkedRootsManager', () => ({
  LinkedRootRemoveButton: () => null,
  LinkedRootsManager: () => null,
}));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));
vi.mock('@/components/workspace/SchedulePanel', () => ({ SchedulePanel: () => null }));
vi.mock('@/components/workspace/TerminalTab', () => ({ TerminalTab: () => null }));
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({ WorkspaceFileViewer: () => null }));
vi.mock('@/components/workspace/WorkspaceFocusShell', () => ({
  WorkspaceFocusShell: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@/components/workspace/WorkspacePreviewOnly', () => ({ WorkspacePreviewOnly: () => null }));
vi.mock('@/components/workspace/WorkspaceTree', () => ({ WorkspaceTree: () => null }));

function setupMocks() {
  const fetchWorktrees = vi.fn().mockResolvedValue(undefined);
  const setOpenFile = vi.fn();
  const setRightPanelMode = vi.fn();
  const setWorkspaceMode = vi.fn();

  mocks.useWorkspace.mockReturnValue({
    worktrees: [],
    worktreeId: null,
    tree: [],
    file: null,
    searchResults: [],
    loading: false,
    searchLoading: false,
    error: null,
    search: vi.fn(),
    setSearchResults: vi.fn(),
    fetchFile: vi.fn(),
    fetchTree: vi.fn(),
    fetchSubtree: vi.fn(),
    fetchWorktrees,
    revealInFinder: vi.fn(),
    pendingExternalSha: null,
    setEditDirty: vi.fn(),
    applyExternalChange: vi.fn(),
    dismissExternalChange: vi.fn(),
  });
  mocks.useWorkspaceSearch.mockReturnValue({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    searchMode: 'all',
    setSearchMode: vi.fn(),
    didSearch: false,
    setDidSearch: vi.fn(),
    searchIme: { isComposing: () => false, onCompositionStart: vi.fn(), onCompositionEnd: vi.fn() },
    handleSearchSubmit: vi.fn(),
    handleSearchResultClick: vi.fn(),
  });
  mocks.useFileManagement.mockReturnValue({
    createFile: vi.fn(),
    createDir: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    uploadFile: vi.fn(),
  });
  mocks.useChatStore.mockImplementation((selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      currentThreadId: 'thread-1',
      pendingPreviewAutoOpen: null,
      workspaceRevealPath: null,
      workspaceMode: 'dev',
      setWorkspaceWorktreeId: vi.fn(),
      setWorkspaceOpenFile: setOpenFile,
      closeWorkspaceTab: vi.fn(),
      setRightPanelMode,
      setPendingChatInsert: vi.fn(),
      consumePreviewAutoOpen: vi.fn(),
      setWorkspaceMode,
    }),
  );
  mocks.usePersistedState.mockImplementation((_key: string, initialValue: unknown) => [initialValue, vi.fn(), vi.fn()]);

  return { fetchWorktrees, setOpenFile, setRightPanelMode, setWorkspaceMode };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('WorkspacePanel local Markdown path entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderPanel() {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel');
    await act(async () => {
      root.render(React.createElement(WorkspacePanel));
    });
  }

  it('rejects a non-Markdown path before calling the API', async () => {
    setupMocks();
    await renderPanel();

    const input = container.querySelector('input[aria-label="本地 Markdown 文件路径"]') as HTMLInputElement;
    const form = container.querySelector('form[aria-label="打开本地 Markdown 文件"]') as HTMLFormElement;
    await act(async () => {
      setInputValue(input, '/Users/cy/notes/todo.txt');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('仅支持 .md 或 .mdx 文件。');
  });

  it('rejects dot path segments before they can widen the linked root', async () => {
    setupMocks();
    await renderPanel();

    const input = container.querySelector('input[aria-label="本地 Markdown 文件路径"]') as HTMLInputElement;
    const form = container.querySelector('form[aria-label="打开本地 Markdown 文件"]') as HTMLFormElement;
    await act(async () => {
      setInputValue(input, '/Users/cy/notes/../../README.md');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('路径不能包含 . 或 .. 段。');
  });

  it('mounts the parent as a linked root and opens its relative Markdown path', async () => {
    const { fetchWorktrees, setOpenFile, setRightPanelMode, setWorkspaceMode } = setupMocks();
    mocks.apiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ linked: { id: 'linked_notes', root: '/Users/cy/notes' } }),
      })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ path: 'guide.mdx' }) });
    await renderPanel();

    const input = container.querySelector('input[aria-label="本地 Markdown 文件路径"]') as HTMLInputElement;
    const form = container.querySelector('form[aria-label="打开本地 Markdown 文件"]') as HTMLFormElement;
    await act(async () => {
      setInputValue(input, '/Users/cy/notes/guide.mdx');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    const [, rootRequest] = mocks.apiFetch.mock.calls[0];
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/workspace/linked-roots',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse((rootRequest as RequestInit).body as string)).toEqual({
      name: expect.stringMatching(/^local_md_notes_[a-z0-9]+$/),
      path: '/Users/cy/notes',
    });
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(2, '/api/workspace/file?worktreeId=linked_notes&path=guide.mdx');
    expect(fetchWorktrees).toHaveBeenCalledOnce();
    expect(setOpenFile).toHaveBeenCalledWith('guide.mdx', null, 'linked_notes');
    expect(setWorkspaceMode).toHaveBeenCalledWith('dev');
    expect(setRightPanelMode).toHaveBeenCalledWith('workspace');
  });

  it('keeps a missing file in the path entry and shows the API error', async () => {
    setupMocks();
    mocks.apiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ linked: { id: 'linked_notes', root: '/Users/cy/notes' } }),
      })
      .mockResolvedValueOnce({ ok: false, json: vi.fn().mockResolvedValue({ error: 'File not found' }) });
    await renderPanel();

    const input = container.querySelector('input[aria-label="本地 Markdown 文件路径"]') as HTMLInputElement;
    const form = container.querySelector('form[aria-label="打开本地 Markdown 文件"]') as HTMLFormElement;
    await act(async () => {
      setInputValue(input, '/Users/cy/notes/missing.md');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('无法打开文件：File not found');
  });
});
