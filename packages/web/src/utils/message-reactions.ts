'use client';

export const MESSAGE_REACTIONS_STORAGE_KEY = 'clowder:message-reactions:v1';
export const MESSAGE_REACTIONS_EVENT = 'clowder:message-reactions-changed';

export interface MessageReaction {
  emoji: string;
  users: string[];
  updatedAt: number;
}

export type MessageReactionMap = Record<string, MessageReaction[]>;

const DEFAULT_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

export function getDefaultReactionEmojis(): string[] {
  return DEFAULT_EMOJIS;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeReactions(value: unknown): MessageReactionMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: MessageReactionMap = {};
  for (const [messageId, reactions] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(reactions)) continue;
    const normalized = reactions
      .filter((item): item is MessageReaction => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Partial<MessageReaction>;
        return (
          typeof candidate.emoji === 'string' &&
          Array.isArray(candidate.users) &&
          candidate.users.every((user) => typeof user === 'string')
        );
      })
      .map((item) => ({
        emoji: item.emoji,
        users: Array.from(new Set(item.users)),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
      }))
      .filter((item) => item.users.length > 0);
    if (normalized.length > 0) result[messageId] = normalized;
  }
  return result;
}

export function loadMessageReactions(): MessageReactionMap {
  if (!canUseStorage()) return {};
  try {
    return normalizeReactions(JSON.parse(window.localStorage.getItem(MESSAGE_REACTIONS_STORAGE_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function persistMessageReactions(map: MessageReactionMap) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(MESSAGE_REACTIONS_STORAGE_KEY, JSON.stringify(map));
  window.dispatchEvent(new CustomEvent(MESSAGE_REACTIONS_EVENT));
}

export function getMessageReactions(messageId: string): MessageReaction[] {
  return loadMessageReactions()[messageId] ?? [];
}

export function toggleMessageReaction(messageId: string, emoji: string, userId: string): MessageReaction[] {
  const map = loadMessageReactions();
  const current = map[messageId] ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  const now = Date.now();

  let next: MessageReaction[];
  if (!existing) {
    next = [...current, { emoji, users: [userId], updatedAt: now }];
  } else {
    const hasUser = existing.users.includes(userId);
    next = current
      .map((reaction) => {
        if (reaction.emoji !== emoji) return reaction;
        const users = hasUser ? reaction.users.filter((user) => user !== userId) : [...reaction.users, userId];
        return { ...reaction, users: Array.from(new Set(users)), updatedAt: now };
      })
      .filter((reaction) => reaction.users.length > 0);
  }

  if (next.length > 0) {
    map[messageId] = next;
  } else {
    delete map[messageId];
  }
  persistMessageReactions(map);
  return next;
}
