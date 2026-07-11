import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreshnessHoldBar, type FreshnessHoldSummary, freshnessHoldLabel } from '../FreshnessHoldBar';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: () => 'Cat',
  useCatData: () => ({ getCatById: () => undefined }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function responseWith(holds: FreshnessHoldSummary[]) {
  return { ok: true, json: async () => ({ holds }) };
}

function hold(id: string, threadId: string, catId: string): FreshnessHoldSummary {
  return {
    id,
    catId,
    threadId,
    status: 'held',
    version: 1,
    reviewCount: 0,
    createdAt: 1,
    updatedAt: 1,
    reviewDeadlineAt: 2,
  };
}

describe('FreshnessHoldBar labels', () => {
  it('never exposes draft content and distinguishes recoverable states', () => {
    expect(freshnessHoldLabel({ status: 'held' })).toContain('安全扣住');
    expect(freshnessHoldLabel({ status: 'reviewing' })).toContain('重新审阅');
    expect(freshnessHoldLabel({ status: 'needs_attention', attentionReason: 'timeout' })).toContain('超时');
    expect(freshnessHoldLabel({ status: 'needs_attention', attentionReason: 'review_limit' })).toContain('人工处理');
  });
});

describe('FreshnessHoldBar thread isolation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('ignores an older thread response that resolves after the active thread', async () => {
    const oldResponse = deferred<ReturnType<typeof responseWith>>();
    const currentResponse = deferred<ReturnType<typeof responseWith>>();
    mocks.apiFetch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise);

    await act(async () => {
      root.render(React.createElement(FreshnessHoldBar, { threadId: 'thread-old' }));
    });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      root.render(React.createElement(FreshnessHoldBar, { threadId: 'thread-current' }));
    });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      currentResponse.resolve(responseWith([hold('current', 'thread-current', 'CURRENT_CAT')]));
      await currentResponse.promise;
    });
    expect(container.textContent).toContain('CURRENT_CAT');

    await act(async () => {
      oldResponse.resolve(responseWith([hold('old', 'thread-old', 'OLD_CAT')]));
      await oldResponse.promise;
    });
    expect(container.textContent).toContain('CURRENT_CAT');
    expect(container.textContent).not.toContain('OLD_CAT');
  });
});
