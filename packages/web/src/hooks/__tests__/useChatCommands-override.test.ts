/**
 * Tests that processCommand uses overrideThreadId when provided,
 * rather than falling back to currentThreadId from the store.
 *
 * Covers the R2 P1-2 fix: command path ignores split target thread.
 */
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Capture apiFetch calls ──
const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'opus', displayName: '布偶猫', mentionPatterns: ['@opus', '@布偶猫', '@布偶'] },
      { id: 'codex', displayName: '缅因猫', mentionPatterns: ['@codex', '@缅因猫', '@缅因'] },
      { id: 'gemini', displayName: '暹罗猫', mentionPatterns: ['@gemini', '@暹罗猫', '@暹罗'] },
    ],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

// ── Mock chatStore with a known currentThreadId ──
// Note: vi.mock is hoisted, so values must be inlined (no top-level refs)
vi.mock('@/stores/chatStore', () => {
  const state = {
    currentThreadId: 'store-current-thread',
  };
  const addMsg = vi.fn();
  const hook = Object.assign(
    (selector?: (s: typeof state) => unknown) => {
      if (selector) return selector(state);
      return { ...state, addMessage: addMsg };
    },
    {
      getState: () => ({ ...state, addMessage: addMsg }),
    },
  );
  return { useChatStore: hook };
});

import { useChatCommands } from '@/hooks/useChatCommands';
import { useToastStore } from '@/stores/toastStore';
import { RESET_CONTEXT_CONFIRMATION } from '@/utils/reset-thread-context';

/**
 * Thin component that extracts processCommand and invokes it
 * with the provided args on mount.
 */
function CommandRunner({
  input,
  overrideThreadId,
  hasPayload,
  onDone,
}: {
  input: string;
  overrideThreadId?: string;
  hasPayload?: boolean;
  onDone: (result: boolean) => void;
}) {
  const { processCommand } = useChatCommands();
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    processCommand(input, overrideThreadId, { hasPayload }).then(onDone);
  }, [hasPayload, input, overrideThreadId, onDone, processCommand]);

  return null;
}

describe('processCommand overrideThreadId (P1-2 R2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('/remember uses overrideThreadId in API call, not store currentThreadId', async () => {
    const OVERRIDE_THREAD = 'split-pane-target-thread';
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    let result: boolean | undefined;

    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/remember mykey myvalue',
          overrideThreadId: OVERRIDE_THREAD,
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/memory',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    // Parse the body to verify threadId
    const callArgs = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.threadId).toBe(OVERRIDE_THREAD);
    expect(body.threadId).not.toBe('store-current-thread');
    expect(body.key).toBe('mykey');
    expect(body.value).toBe('myvalue');
  });

  it('/remember without override falls back to store currentThreadId', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    let result: boolean | undefined;

    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/remember foo bar',
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBe(true);

    const callArgs = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.threadId).toBe('store-current-thread');
  });

  it('/reset-context uses override thread and emits only the exact local confirmation', async () => {
    mockApiFetch.mockResolvedValue({ ok: true });
    let result: boolean | undefined;
    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/reset-context',
          overrideThreadId: 'split-reset-thread',
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/threads/split-reset-thread/reset-context',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'success', message: RESET_CONTEXT_CONFIRMATION, threadId: 'split-reset-thread' }),
    ]);
  });

  it('/reset-context rejects arguments locally without calling the API', async () => {
    let result: boolean | undefined;
    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/reset-context now',
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });
    expect(result).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.message).toBe('用法：/reset-context');
  });

  it('/reset-context rejects image or attachment payloads locally', async () => {
    let result: boolean | undefined;
    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/reset-context',
          hasPayload: true,
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });
    expect(result).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]?.message).toBe('用法：/reset-context');
  });
});
