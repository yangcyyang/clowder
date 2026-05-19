import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultReactionEmojis,
  getMessageReactions,
  MESSAGE_REACTIONS_EVENT,
  MESSAGE_REACTIONS_STORAGE_KEY,
  toggleMessageReaction,
} from '../message-reactions';

describe('message-reactions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('provides the default reaction palette', () => {
    expect(getDefaultReactionEmojis()).toEqual(['👍', '❤️', '😂', '🎉', '👀', '✅']);
  });

  it('toggles one user reaction on and off', () => {
    expect(toggleMessageReaction('msg-1', '👍', 'user-1')).toEqual([
      { emoji: '👍', users: ['user-1'], updatedAt: expect.any(Number) },
    ]);

    expect(getMessageReactions('msg-1')).toHaveLength(1);
    expect(toggleMessageReaction('msg-1', '👍', 'user-1')).toEqual([]);
    expect(getMessageReactions('msg-1')).toEqual([]);
    expect(JSON.parse(localStorage.getItem(MESSAGE_REACTIONS_STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('keeps separate users on the same emoji', () => {
    toggleMessageReaction('msg-1', '👀', 'user-1');
    toggleMessageReaction('msg-1', '👀', 'user-2');

    expect(getMessageReactions('msg-1')).toMatchObject([{ emoji: '👀', users: ['user-1', 'user-2'] }]);
  });

  it('dispatches a same-window change event after persisting', () => {
    const listener = vi.fn();
    window.addEventListener(MESSAGE_REACTIONS_EVENT, listener);

    toggleMessageReaction('msg-1', '✅', 'user-1');

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(MESSAGE_REACTIONS_EVENT, listener);
  });
});
