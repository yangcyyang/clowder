import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { MarkdownContent } = await import('../MarkdownContent');
const TOKEN = '#大厅:0001784400000000-000001-ab12cd34';

describe('Markdown Thread Address link', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useChatStore.setState({ currentThreadId: 'thread-current' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it('renders a clickable address only after the viewer-safe resolver authorizes it', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ threadId: 'thread-branch' }),
    });
    await act(async () => {
      root.render(<MarkdownContent content={`继续处理 ${TOKEN}`} disableCommandPrefix />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const link = container.querySelector<HTMLButtonElement>('[data-thread-address-link]');
    expect(link?.textContent).toBe(TOKEN);
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('sourceThreadId=thread-current'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps the token as inert text when resolution is denied', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: '线程地址不可用' }) });
    await act(async () => {
      root.render(<MarkdownContent content={TOKEN} disableCommandPrefix />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-thread-address-link]')).toBeNull();
    expect(container.querySelector('[data-thread-address-text]')?.textContent).toBe(TOKEN);
  });

  it('does not linkify inline-code addresses', async () => {
    await act(async () => {
      root.render(<MarkdownContent content={`\`${TOKEN}\``} disableCommandPrefix />);
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-thread-address-link]')).toBeNull();
  });

  it('keeps quoted and multiple addresses inert without probing the resolver', async () => {
    await act(async () => {
      root.render(<MarkdownContent content={`> ${TOKEN}\n\n${TOKEN} #研发:0001784400000000-000002-ab12cd35`} />);
      await Promise.resolve();
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-thread-address-link]')).toBeNull();
  });
});
