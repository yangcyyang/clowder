'use client';

import type { ChatMessage } from '@/stores/chatStore';

export const SAVED_MESSAGES_STORAGE_KEY = 'clowder:saved-messages:v1';
export const SAVED_MESSAGES_EVENT = 'clowder:saved-messages-changed';
export const SAVED_MESSAGE_SCROLL_KEY = 'clowder:saved-message-scroll-target';
export const SAVED_MESSAGES_VIEW_KEY = 'clowder:saved-messages-view-open';
export const SAVED_MESSAGES_VIEW_EVENT = 'clowder:saved-messages-view-changed';

export interface SavedMessageSnapshot {
  messageId: string;
  threadId: string;
  content: string;
  type: ChatMessage['type'];
  catId?: string;
  timestamp: number;
  savedAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeSavedMessages(value: unknown): SavedMessageSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is SavedMessageSnapshot => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<SavedMessageSnapshot>;
      return (
        typeof candidate.messageId === 'string' &&
        typeof candidate.threadId === 'string' &&
        typeof candidate.content === 'string' &&
        typeof candidate.timestamp === 'number' &&
        typeof candidate.savedAt === 'number'
      );
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function loadSavedMessages(): SavedMessageSnapshot[] {
  if (!canUseStorage()) return [];
  try {
    return normalizeSavedMessages(JSON.parse(window.localStorage.getItem(SAVED_MESSAGES_STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function persistSavedMessages(messages: SavedMessageSnapshot[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(SAVED_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
  window.dispatchEvent(new CustomEvent(SAVED_MESSAGES_EVENT));
}

export function isMessageSaved(messageId: string): boolean {
  return loadSavedMessages().some((item) => item.messageId === messageId);
}

export function toggleSavedMessage(threadId: string, message: ChatMessage): boolean {
  const current = loadSavedMessages();
  const exists = current.some((item) => item.messageId === message.id);
  if (exists) {
    persistSavedMessages(current.filter((item) => item.messageId !== message.id));
    return false;
  }

  persistSavedMessages([
    {
      messageId: message.id,
      threadId,
      content: message.content,
      type: message.type,
      catId: message.catId,
      timestamp: message.timestamp,
      savedAt: Date.now(),
    },
    ...current,
  ]);
  return true;
}

export function setSavedMessageScrollTarget(threadId: string, messageId: string) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(SAVED_MESSAGE_SCROLL_KEY, JSON.stringify({ threadId, messageId }));
}

export function clearSavedMessageScrollTarget() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SAVED_MESSAGE_SCROLL_KEY);
}

export function consumeSavedMessageScrollTarget(threadId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SAVED_MESSAGE_SCROLL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { threadId?: string; messageId?: string };
    if (parsed.threadId !== threadId || !parsed.messageId) return null;
    window.sessionStorage.removeItem(SAVED_MESSAGE_SCROLL_KEY);
    return parsed.messageId;
  } catch {
    window.sessionStorage.removeItem(SAVED_MESSAGE_SCROLL_KEY);
    return null;
  }
}

export function isSavedMessagesViewOpen(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(SAVED_MESSAGES_VIEW_KEY) === 'true';
}

export function setSavedMessagesViewOpen(open: boolean) {
  if (typeof window === 'undefined') return;
  if (open) {
    window.sessionStorage.setItem(SAVED_MESSAGES_VIEW_KEY, 'true');
  } else {
    window.sessionStorage.removeItem(SAVED_MESSAGES_VIEW_KEY);
  }
  window.dispatchEvent(new CustomEvent(SAVED_MESSAGES_VIEW_EVENT, { detail: { open } }));
}
