import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageReaction } from '@/stores/chat-types';
import { apiFetch } from '../api-client';
import { getDefaultReactionEmojis, hasUserReaction, toggleMessageReaction } from '../message-reactions';

vi.mock('../api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

describe('message-reactions', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('provides the default reaction palette', () => {
    expect(getDefaultReactionEmojis()).toEqual(['👍', '❤️', '😄', '🎉', '😮', '👀']);
  });

  it('detects whether the current user has reacted', () => {
    const reactions: MessageReaction[] = [{ emoji: '👍', users: ['user-1'], updatedAt: 1 }];

    expect(hasUserReaction(reactions, '👍', 'user-1')).toBe(true);
    expect(hasUserReaction(reactions, '👍', 'user-2')).toBe(false);
    expect(hasUserReaction(reactions, '👀', 'user-1')).toBe(false);
  });

  it('adds a reaction through the backend API', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ reactions: [{ emoji: '👍', users: ['user-1'], updatedAt: 123 }] }), {
        status: 200,
      }),
    );

    await expect(
      toggleMessageReaction({ messageId: 'msg-1', emoji: '👍', userId: 'user-1', active: false }),
    ).resolves.toEqual([{ emoji: '👍', users: ['user-1'], updatedAt: 123 }]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/messages/msg-1/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', emoji: '👍' }),
    });
  });

  it('removes an active reaction through the backend API', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ reactions: [] }), {
        status: 200,
      }),
    );

    await expect(
      toggleMessageReaction({ messageId: 'msg-1', emoji: '👍', userId: 'user-1', active: true }),
    ).resolves.toEqual([]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/messages/msg-1/reactions/%F0%9F%91%8D', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });
  });

  it('surfaces backend errors', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
      }),
    );

    await expect(
      toggleMessageReaction({ messageId: 'msg-1', emoji: '👍', userId: 'user-1', active: false }),
    ).rejects.toThrow('boom');
  });
});
