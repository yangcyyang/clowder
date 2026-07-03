import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { getUnreadDividerInsertIndex, resolveUnreadDividerCursor } from '../unreadDivider';

function msg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: id,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('getUnreadDividerInsertIndex', () => {
  it('returns the first visible message after the read cursor', () => {
    const messages = [msg('read'), msg('hidden', { type: 'system' }), msg('new')];
    const index = getUnreadDividerInsertIndex(messages, 'read', (message) => message.id !== 'hidden');
    expect(index).toBe(2);
  });

  it('does not render when the cursor is missing or at the end of the loaded window', () => {
    const messages = [msg('old'), msg('read')];
    expect(getUnreadDividerInsertIndex(messages, 'missing')).toBe(-1);
    expect(getUnreadDividerInsertIndex(messages, 'read')).toBe(-1);
    expect(getUnreadDividerInsertIndex(messages, null)).toBe(-1);
  });
});

describe('resolveUnreadDividerCursor', () => {
  it('prefers the server read cursor when local thread state has already been cleared', () => {
    expect(
      resolveUnreadDividerCursor({
        serverUnreadCount: 3,
        serverLastReadMessageId: 'server-read',
        storedUnreadCount: 0,
        storedLastReadMessageId: 'stale-local-read',
      }),
    ).toBe('server-read');
  });

  it('falls back to stored thread state before the server thread summary is available', () => {
    expect(
      resolveUnreadDividerCursor({
        serverUnreadCount: 0,
        serverLastReadMessageId: null,
        storedUnreadCount: 2,
        storedLastReadMessageId: 'local-read',
      }),
    ).toBe('local-read');
  });

  it('does not return a cursor without both unread count and last read message id', () => {
    expect(resolveUnreadDividerCursor({ serverUnreadCount: 2, serverLastReadMessageId: null })).toBeNull();
    expect(resolveUnreadDividerCursor({ serverUnreadCount: 0, serverLastReadMessageId: 'read' })).toBeNull();
  });
});
