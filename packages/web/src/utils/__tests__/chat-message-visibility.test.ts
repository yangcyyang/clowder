import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { isUnreadCountableChatMessage, isUserVisibleChatMessage } from '../chat-message-visibility';

describe('chat-message-visibility', () => {
  it('hides context briefing messages from the main chat surface and unread counts', () => {
    const briefingMessage: ChatMessage = {
      id: 'briefing-1',
      threadId: 'thread-1',
      type: 'connector',
      content: 'CONTEXT BRIEFING',
      timestamp: Date.now(),
      origin: 'briefing',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'briefing-card-1', kind: 'card', v: 1, title: 'CONTEXT BRIEFING' }],
        },
      },
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(briefingMessage)).toBe(false);
    expect(isUnreadCountableChatMessage(briefingMessage)).toBe(false);
  });

  it('keeps progress heartbeat status visible but unread-neutral', () => {
    const heartbeatMessage: ChatMessage = {
      id: 'heartbeat-1',
      threadId: 'task-thread-1',
      type: 'connector',
      content: '老者-codex 正在推进：检查任务状态（1/3 已完成）',
      timestamp: Date.now(),
      extra: { systemKind: 'progress_heartbeat' },
    } as Partial<ChatMessage> as ChatMessage;

    expect(isUserVisibleChatMessage(heartbeatMessage)).toBe(true);
    expect(isUnreadCountableChatMessage(heartbeatMessage)).toBe(false);
  });
});
