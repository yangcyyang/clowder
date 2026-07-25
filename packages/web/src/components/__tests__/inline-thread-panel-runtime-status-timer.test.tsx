/**
 * Coordinator ask: bring the Thread panel's "回复中" runtime-status chip up to parity with
 * the main channel's AgentStatusIndicator.tsx — stage label (getAgentStatusLabel), a ticking
 * mm:ss elapsed timer (formatElapsed), and a stop button wired to the same cancel endpoint
 * (POST /api/threads/:threadId/cancel/:catId). This suite locks in the three new behaviors,
 * plus the isolation guarantee that ties directly to the thread-anchor fix in
 * inline-thread-panel-anchor-race.test.tsx: a cat active in some OTHER thread must never
 * show up in a different thread's status row.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: 'Opus',
        name: 'Opus',
        color: { primary: '#8855ff' },
        defaultModel: 'claude-opus',
        provider: 'anthropic',
        clientId: 'anthropic',
        mentionPatterns: ['opus'],
        roleDescription: '',
        avatar: '',
        roster: { available: true },
      },
      {
        id: 'zhizhi',
        displayName: '芝芝',
        name: '芝芝',
        color: { primary: '#ff8855' },
        defaultModel: 'claude-sonnet-5',
        provider: 'anthropic',
        clientId: 'anthropic',
        mentionPatterns: ['zhizhi'],
        roleDescription: '',
        avatar: '',
        roster: { available: true },
      },
    ],
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/components/ChatMessage', () => ({
  ChatMessage: () => React.createElement('div', null, 'message'),
  shouldRenderChatMessage: () => true,
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '父消息',
  timestamp: 1,
} as ChatMessage;

describe('InlineThreadPanel runtime status — AgentStatusIndicator parity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('ticks the elapsed mm:ss timer once a second, same as AgentStatusIndicator', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply', startedAt }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-branch"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const statusRow = container.querySelector('[data-testid="inline-thread-runtime-status"]');
    expect(statusRow?.textContent).toContain('0:00');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusRow?.textContent).toContain('0:02');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(statusRow?.textContent).toContain('0:05');
  });

  it('shows the phase-aware stage label via getAgentStatusLabel (main-channel vocabulary)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply', startedAt: Date.now() }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-branch"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const statusRow = container.querySelector('[data-testid="inline-thread-runtime-status"]');
    // A plain 'streaming' status with no finer-grained phase (the REST queue poll never
    // returns phase — see InlineThreadActiveInvocation's comment) reads as "正在生成", the
    // same label AgentStatusIndicator shows the main channel for the identical case — not
    // the old bespoke "回复中" wording.
    expect(statusRow?.textContent).toContain('正在生成');
  });

  it('the stop button cancels this thread + cat via the same endpoint AgentStatusIndicator uses', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/thread-branch/queue')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply', startedAt: Date.now() }] }),
        });
      }
      if (url.startsWith('/api/threads/thread-branch/cancel/opus')) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-branch"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    apiFetchMock.mockClear();
    const statusRow = container.querySelector('[data-testid="inline-thread-runtime-status"]') as HTMLElement;
    const stopButton = Array.from(statusRow.querySelectorAll('button')).find((b) => b.textContent === '停止');
    expect(stopButton).toBeTruthy();

    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-branch/cancel/opus',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('only shows this thread\'s cats — a cat active in a different (even more-recently-fetched) thread never leaks in', async () => {
    let resolveThreadAQueue: ((value: unknown) => void) | undefined;
    const threadAQueuePromise = new Promise((resolve) => {
      resolveThreadAQueue = resolve;
    });

    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/thread-a/queue')) {
        // thread-a (宪宪-thread)'s queue poll resolves LATE — simulating it being slow
        // because 芝芝 is actively streaming there under concurrent load.
        return threadAQueuePromise.then(() => ({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'zhizhi', mode: 'reply', startedAt: Date.now() }] }),
        }));
      }
      if (url.startsWith('/api/threads/thread-b/queue')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ activeInvocations: [{ catId: 'opus', mode: 'reply', startedAt: Date.now() }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-a"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        <InlineThreadPanel
          threadId="thread-b"
          parentThreadId="thread-parent"
          sourceMessage={sourceMessage}
          parentThreadTitle="Parent"
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      resolveThreadAQueue?.(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const statusRow = container.querySelector('[data-testid="inline-thread-runtime-status"]');
    expect(statusRow?.textContent).toContain('Opus');
    expect(statusRow?.textContent).not.toContain('芝芝');
  });
});
