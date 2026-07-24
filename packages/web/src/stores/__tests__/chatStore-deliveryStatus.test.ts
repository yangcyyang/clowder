/**
 * [thread-task-design §1.1] Regression test: markMessagesDelivered is the one
 * signal that actually confirms a queued message reached a cat, so it must be
 * the place that retires ChatMessage's "排队中" badge — clearing
 * deliveryStatus:'queued' to 'delivered' alongside the existing deliveredAt
 * bookkeeping.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

const NOW = 1700000000000;

describe('markMessagesDelivered clears deliveryStatus', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [],
      threadStates: {},
    });
  });

  it('flips a queued active-thread message to delivered', () => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [
        {
          id: 'msg-1',
          type: 'user',
          content: '排队消息',
          timestamp: NOW,
          deliveryStatus: 'queued',
        },
      ],
    });

    useChatStore.getState().markMessagesDelivered('thread-1', ['msg-1'], NOW + 1);

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-1');
    expect(msg?.deliveryStatus).toBe('delivered');
    expect(msg?.deliveredAt).toBe(NOW + 1);
  });

  it('flips a queued background-thread message to delivered', () => {
    useChatStore.setState({
      currentThreadId: 'thread-other',
      threadStates: {
        'thread-bg': {
          ...DEFAULT_THREAD_STATE,
          messages: [
            {
              id: 'msg-2',
              type: 'user',
              content: '排队消息',
              timestamp: NOW,
              deliveryStatus: 'queued',
            },
          ],
        },
      },
    });

    useChatStore.getState().markMessagesDelivered('thread-bg', ['msg-2'], NOW + 1);

    const msg = useChatStore.getState().threadStates['thread-bg']?.messages.find((m) => m.id === 'msg-2');
    expect(msg?.deliveryStatus).toBe('delivered');
  });

  it('does not add deliveryStatus to a message that never had one', () => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [
        {
          id: 'msg-3',
          type: 'user',
          content: '普通消息',
          timestamp: NOW,
        },
      ],
    });

    useChatStore.getState().markMessagesDelivered('thread-1', ['msg-3'], NOW + 1);

    const msg = useChatStore.getState().messages.find((m) => m.id === 'msg-3');
    expect(msg?.deliveryStatus).toBeUndefined();
    expect(msg?.deliveredAt).toBe(NOW + 1);
  });
});
