import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, setWorkspaceOpenFile } = vi.hoisted(() => {
  return { apiFetchMock: vi.fn(), setWorkspaceOpenFile: vi.fn() };
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceOpenFile: typeof setWorkspaceOpenFile }) => unknown) =>
    selector({ setWorkspaceOpenFile }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

import { linkifyFilePaths, MarkdownContent } from '../MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('MarkdownContent file path links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(content: string) {
    await act(async () => {
      root.render(React.createElement(MarkdownContent, { content, disableCommandPrefix: true }));
    });
  }

  async function renderLinkedPaths(content: string, projectRoot: string) {
    await act(async () => {
      root.render(React.createElement(React.Fragment, null, linkifyFilePaths(content, projectRoot)));
    });
  }

  it('opens a Chinese relative Markdown path in the workspace without a configured project root', async () => {
    const path = 'docs/个人内容资产操作系统-落地执行方案-v1.md';
    await render(`请打开 ${path} [wt:notes]`);

    const link = container.querySelector<HTMLAnchorElement>('a.markdown-file-link');
    expect(link?.textContent).toBe(path);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const allowed = link?.dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(setWorkspaceOpenFile).toHaveBeenCalledWith(path, null, 'notes');
  });

  it('keeps a backtick-wrapped Chinese Markdown path clickable with the existing file-code style', async () => {
    const path = 'docs/个人内容资产操作系统-落地执行方案-v1.md';
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ worktreeId: 'resolved-notes', path, root: '/workspace' }],
      }),
    });
    await render(`请阅读 \`${path}\``);

    const code = container.querySelector<HTMLElement>('code.markdown-file-code');
    const link = code?.querySelector<HTMLAnchorElement>('a.markdown-file-link');
    expect(link?.textContent).toBe(path);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    let allowed: boolean | undefined;
    await act(async () => {
      allowed = link?.dispatchEvent(event);
    });

    expect(allowed).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/resolve-local-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: '个人内容资产操作系统-落地执行方案-v1.md' }),
    });
    expect(setWorkspaceOpenFile).toHaveBeenCalledWith(path, null, 'resolved-notes');
  });

  it('keeps a configured Chinese relative path on the existing VSCode and workspace interaction', async () => {
    const path = 'docs/个人内容资产操作系统-落地执行方案-v1.md';
    await renderLinkedPaths(`请打开 ${path} [wt:notes]`, '/workspace');

    const link = container.querySelector<HTMLAnchorElement>('a.markdown-file-link');
    expect(link?.textContent).toBe(path);
    expect(link?.getAttribute('href')).toBe(`vscode://file/workspace/${path}`);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const allowed = link?.dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(setWorkspaceOpenFile).toHaveBeenCalledWith(path, null, 'notes');
  });

  it('keeps English relative paths with line numbers routed through the existing workspace link behavior', async () => {
    await renderLinkedPaths('请查看 docs/x.md:12 [wt:docs]', '/workspace');

    const link = container.querySelector<HTMLAnchorElement>('a.markdown-file-link');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(setWorkspaceOpenFile).toHaveBeenCalledWith('docs/x.md', 12, 'docs');
  });

  it('leaves Cmd/Ctrl+click to the vscode link instead of opening the workspace', async () => {
    const path = 'docs/个人内容资产操作系统-落地执行方案-v1.md';
    await renderLinkedPaths(`请打开 ${path}`, '/workspace');

    const link = container.querySelector<HTMLAnchorElement>('a.markdown-file-link');
    const preventNavigation = (event: MouseEvent) => event.preventDefault();
    link?.addEventListener('click', preventNavigation, { capture: true });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link?.dispatchEvent(event);
    link?.removeEventListener('click', preventNavigation, { capture: true });

    expect(link?.getAttribute('href')).toBe(`vscode://file/workspace/${path}`);
    expect(setWorkspaceOpenFile).not.toHaveBeenCalled();
  });
});
