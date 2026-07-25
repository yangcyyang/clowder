/**
 * F-I: "沉淀为知识" modal's 4th type card ("知识库" → vault inbox target).
 *
 * Covers:
 *  - the fourth card renders with the vault-inbox description
 *  - selecting it and submitting sends type='vault' plus sourceThreadTitle/sourceUrl
 *  - the card greys out and disables when GET /api/knowledge/vault-status reports unavailable
 *  - existing feature/lesson/decision behavior (default selection, no vault extras) is untouched
 *
 * No real network/filesystem access — apiFetch is fully mocked.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { KnowledgeCaptureModal } = await import('../KnowledgeCaptureModal');

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('KnowledgeCaptureModal — F-I vault type card', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    await act(async () => {
      root.render(
        <KnowledgeCaptureModal
          open
          sourceThreadId="thread-1"
          defaultTitle="讨论标题"
          onClose={onClose}
          onCreated={onCreated}
        />,
      );
    });
    await flush();
    return { onClose, onCreated };
  }

  function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders a fourth "知识库" type card describing the vault inbox destination', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ available: true }));
    await renderModal();

    const card = container.querySelector('[data-testid="knowledge-type-vault"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('知识库');
    expect(card?.textContent).toContain('00待确认/clowder-inbox');

    // The other three existing cards must still be present, unchanged.
    expect(container.querySelector('[data-testid="knowledge-type-feature"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="knowledge-type-lesson"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="knowledge-type-decision"]')).toBeTruthy();
  });

  it('selecting the vault card and submitting sends type=vault with sourceThreadTitle/sourceUrl', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/knowledge/vault-status') {
        return Promise.resolve(jsonResponse({ available: true }));
      }
      return Promise.resolve(jsonResponse({ type: 'vault', path: '00待确认/clowder-inbox/x.md', id: '2026-07-25-x' }));
    });
    const { onCreated } = await renderModal();

    const vaultCard = container.querySelector('[data-testid="knowledge-type-vault"]') as HTMLButtonElement;
    expect(vaultCard.disabled).toBe(false);
    await act(async () => {
      vaultCard.click();
    });

    const titleInput = container.querySelector('input') as HTMLInputElement;
    const summaryTextarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setInputValue(titleInput, '沉淀标题');
      setInputValue(summaryTextarea, '沉淀摘要内容');
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('投递到收件夹'),
    );
    expect(submitBtn).toBeTruthy();
    expect(submitBtn?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      submitBtn!.click();
    });
    await flush();

    const postCall = apiFetchMock.mock.calls.find(([url]) => url === '/api/knowledge');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse((postCall as [string, RequestInit])[1].body as string);
    expect(payload.type).toBe('vault');
    expect(payload.title).toBe('沉淀标题');
    expect(payload.summary).toBe('沉淀摘要内容');
    expect(payload.sourceThreadId).toBe('thread-1');
    expect(payload.sourceThreadTitle).toBe('讨论标题');
    expect(payload.sourceUrl).toContain('/thread/thread-1');

    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vault', path: '00待确认/clowder-inbox/x.md' }),
    );
    // The modal's own success message must reflect the inbox/reindex flow, not the generic doc message.
    expect(container.textContent).toContain('已投递收件夹');
    expect(container.textContent).toContain('下次索引重建后可被检索');
  });

  it('greys out and disables the vault card when the backend reports it unavailable', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ available: false, reason: 'OBSIDIAN_READONLY_ROOTS 未配置，知识库沉淀暂不可用' }),
    );
    await renderModal();

    const vaultCard = container.querySelector('[data-testid="knowledge-type-vault"]') as HTMLButtonElement;
    expect(vaultCard.disabled).toBe(true);
    expect(vaultCard.getAttribute('title')).toContain('OBSIDIAN_READONLY_ROOTS');
    expect(vaultCard.className).toContain('opacity-50');
    expect(vaultCard.className).toContain('cursor-not-allowed');

    await act(async () => {
      vaultCard.click();
    });
    // A disabled native <button> does not fire its click handler at all, and the
    // handler itself also short-circuits — either way the card must not become selected.
    expect(vaultCard.className).not.toContain('bg-[var(--console-card-soft-bg)]');
  });

  it('leaves feature/lesson/decision submissions untouched (no vault extras, default type stays "lesson")', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/knowledge/vault-status') {
        return Promise.resolve(jsonResponse({ available: true }));
      }
      return Promise.resolve(jsonResponse({ type: 'lesson', path: 'docs/public-lessons.md', id: 'LL-058' }));
    });
    await renderModal();

    const lessonCard = container.querySelector('[data-testid="knowledge-type-lesson"]') as HTMLButtonElement;
    expect(lessonCard.className).toContain('border-[var(--cafe-accent)]');

    const titleInput = container.querySelector('input') as HTMLInputElement;
    const summaryTextarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setInputValue(titleInput, '重复踩坑要入库');
      setInputValue(summaryTextarea, '同类事故复现后必须写入 lessons。');
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '生成文档');
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });
    await flush();

    const postCall = apiFetchMock.mock.calls.find(([url]) => url === '/api/knowledge');
    const payload = JSON.parse((postCall as [string, RequestInit])[1].body as string);
    expect(payload.type).toBe('lesson');
    expect(payload.sourceThreadTitle).toBeUndefined();
    expect(payload.sourceUrl).toBeUndefined();
  });
});
