/**
 * [batch 2-E] "As Task" checkbox wiring — verifies the message payload carries
 * `asTask: true` (JSON body for text-only sends, FormData field for
 * image/attachment sends) when ChatInput's checkbox is checked, and that a
 * `taskId` surfaced in the server response is threaded back through
 * SendMessageResult so callers can detect a server-side task admission
 * without needing a separate client-side task-creation call.
 *
 * See docs/research/clowder-raft-thread-task-design.md §3 step 2.3 and
 * packages/api/src/routes/messages.schema.ts (asTask field, confirmed landed
 * in this worktree by 2-A's parallel work as of this writing).
 */
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockAddMessage = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockRemoveMessage = vi.fn();
const mockRemoveThreadMessage = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockReplaceThreadMessageId = vi.fn();
const mockResetRefs = vi.fn();
const mockProcessCommand = vi.fn(async () => false);

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({ resetRefs: mockResetRefs }),
}));

vi.mock('@/hooks/useChatCommands', () => ({
  useChatCommands: () => ({ processCommand: mockProcessCommand }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    () => ({
      addMessage: mockAddMessage,
      addMessageToThread: mockAddMessageToThread,
      removeMessage: mockRemoveMessage,
      removeThreadMessage: mockRemoveThreadMessage,
      patchThreadMessage: mockPatchThreadMessage,
      setLoading: mockSetLoading,
      setHasActiveInvocation: mockSetHasActiveInvocation,
      setThreadLoading: mockSetThreadLoading,
      setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
      replaceThreadMessageId: mockReplaceThreadMessageId,
      currentThreadId: 'thread-route',
    }),
    { getState: () => ({ currentThreadId: 'thread-route' }) },
  ),
}));

import type { SendMessageResult } from '@/hooks/useSendMessage';
import { useSendMessage } from '@/hooks/useSendMessage';

function SendRunner({
  asTask,
  images,
  onDone,
}: {
  asTask?: boolean;
  images?: File[];
  onDone: (result: SendMessageResult | undefined) => void;
}) {
  const { handleSend } = useSendMessage('thread-route');
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    handleSend('帮我看看这个 bug', images, undefined, undefined, undefined, undefined, asTask).then(onDone);
  }, [handleSend, onDone, asTask, images]);

  return null;
}

describe('useSendMessage asTask payload', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    mockAddMessage.mockReset();
    mockAddMessageToThread.mockReset();
    mockRemoveMessage.mockReset();
    mockRemoveThreadMessage.mockReset();
    mockPatchThreadMessage.mockReset();
    mockSetLoading.mockReset();
    mockSetHasActiveInvocation.mockReset();
    mockSetThreadLoading.mockReset();
    mockSetThreadHasActiveInvocation.mockReset();
    mockReplaceThreadMessageId.mockReset();
    mockResetRefs.mockReset();
    mockProcessCommand.mockReset();
    mockProcessCommand.mockResolvedValue(false);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ userMessageId: 'msg-1' }) });

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

  it('includes asTask:true in the JSON body when the checkbox is checked', async () => {
    await act(async () => {
      root.render(React.createElement(SendRunner, { asTask: true, onDone: () => {} }));
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload.asTask).toBe(true);
  });

  it('omits asTask from the JSON body when the checkbox is unchecked', async () => {
    await act(async () => {
      root.render(React.createElement(SendRunner, { asTask: false, onDone: () => {} }));
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload).not.toHaveProperty('asTask');
  });

  it('omits asTask from the JSON body when not passed at all (backward compatible)', async () => {
    await act(async () => {
      root.render(React.createElement(SendRunner, { onDone: () => {} }));
    });

    const payload = JSON.parse(String(mockApiFetch.mock.calls[0]?.[1]?.body));
    expect(payload).not.toHaveProperty('asTask');
  });

  it('sends asTask as a FormData field ("true") on image/attachment sends', async () => {
    const fakeImage = new File(['x'], 'pic.png', { type: 'image/png' });

    await act(async () => {
      root.render(React.createElement(SendRunner, { asTask: true, images: [fakeImage], onDone: () => {} }));
    });

    const formData = mockApiFetch.mock.calls[0]?.[1]?.body as FormData;
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get('asTask')).toBe('true');
  });

  it('does not append an asTask field to FormData when unchecked', async () => {
    const fakeImage = new File(['x'], 'pic.png', { type: 'image/png' });

    await act(async () => {
      root.render(React.createElement(SendRunner, { asTask: false, images: [fakeImage], onDone: () => {} }));
    });

    const formData = mockApiFetch.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get('asTask')).toBeNull();
  });

  it('surfaces taskId from the response on SendMessageResult (unowned-task 202 shape)', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'task_created', taskId: 'task-42', userMessageId: 'msg-1' }),
    });
    let captured: SendMessageResult | undefined;

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          asTask: true,
          onDone: (result) => {
            captured = result;
          },
        }),
      );
    });

    expect(captured?.taskId).toBe('task-42');
  });

  it('leaves taskId undefined when the response does not carry one (owned-task admission path)', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', userMessageId: 'msg-1' }),
    });
    let captured: SendMessageResult | undefined;

    await act(async () => {
      root.render(
        React.createElement(SendRunner, {
          asTask: true,
          onDone: (result) => {
            captured = result;
          },
        }),
      );
    });

    expect(captured?.taskId).toBeUndefined();
  });
});
