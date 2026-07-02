import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceStore } from '@/stores/marketplaceStore';
import { MarketplacePanel } from '../marketplace/marketplace-panel';

const mocks = {
  apiFetch: vi.fn(),
};

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

describe('MarketplacePanel retry', () => {
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
    useMarketplaceStore.setState({
      results: [],
      selectedResult: null,
      installPlan: null,
      loading: false,
      error: null,
      query: '',
      ecosystemFilter: [],
      trustFilter: [],
      artifactKindsFilter: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('retry browses again after an initial browse failure with no query', async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new Error('Browse failed once'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });

    await act(async () => {
      root.render(React.createElement(MarketplacePanel));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Browse failed once'));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重试'),
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/marketplace/search');
  });
});
