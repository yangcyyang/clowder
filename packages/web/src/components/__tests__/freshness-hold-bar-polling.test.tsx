import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreshnessHoldBar, type FreshnessHoldSummary } from '@/components/FreshnessHoldBar';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => undefined }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

const activeHold: FreshnessHoldSummary = {
  id: 'hold-1',
  catId: 'opus',
  threadId: 'thread-1',
  status: 'held',
  version: 1,
  reviewCount: 0,
  createdAt: 1,
  updatedAt: 1,
  reviewDeadlineAt: 60_000,
};

describe('FreshnessHoldBar adaptive polling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let holds: FreshnessHoldSummary[];
  let visibilityState: DocumentVisibilityState;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    holds = [];
    visibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    apiFetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => ({ holds }) }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function mountBar() {
    await act(async () => {
      root.render(<FreshnessHoldBar threadId="thread-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('backs off to 30 seconds while no freshness hold exists', async () => {
    await mountBar();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the 5 second cadence while a freshness hold exists', async () => {
    holds = [activeHold];
    await mountBar();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll while hidden and refreshes once when visible again', async () => {
    holds = [activeHold];
    await mountBar();
    apiFetchMock.mockClear();

    visibilityState = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiFetchMock).not.toHaveBeenCalled();

    visibilityState = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});
