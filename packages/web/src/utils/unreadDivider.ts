import type { ChatMessage } from '@/stores/chat-types';

export interface UnreadDividerCursorInput {
  serverUnreadCount?: number | null;
  serverLastReadMessageId?: string | null;
  storedUnreadCount?: number | null;
  storedLastReadMessageId?: string | null;
}

function hasUnreadCursor(unreadCount: number | null | undefined, lastReadMessageId: string | null | undefined): boolean {
  return (unreadCount ?? 0) > 0 && !!lastReadMessageId;
}

export function resolveUnreadDividerCursor(input: UnreadDividerCursorInput): string | null {
  if (hasUnreadCursor(input.serverUnreadCount, input.serverLastReadMessageId)) {
    return input.serverLastReadMessageId!;
  }
  if (hasUnreadCursor(input.storedUnreadCount, input.storedLastReadMessageId)) {
    return input.storedLastReadMessageId!;
  }
  return null;
}

export function getUnreadDividerInsertIndex(
  messages: readonly ChatMessage[],
  lastReadMessageId: string | null | undefined,
  shouldRender: (message: ChatMessage) => boolean = () => true,
): number {
  if (!lastReadMessageId) return -1;
  const cursorIndex = messages.findIndex((message) => message.id === lastReadMessageId);
  if (cursorIndex < 0 || cursorIndex >= messages.length - 1) return -1;
  for (let i = cursorIndex + 1; i < messages.length; i += 1) {
    if (shouldRender(messages[i]!)) return i;
  }
  return -1;
}
