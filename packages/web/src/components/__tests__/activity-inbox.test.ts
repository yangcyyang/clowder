import { describe, expect, it } from 'vitest';
import { buildActivityInboxItems, countActivityUnread } from '@/components/activity-inbox';
import type { Thread } from '@/stores/chat-types';

function thread(id: string, title: string, lastActiveAt: number): Thread {
  return {
    id,
    title,
    lastActiveAt,
    createdAt: lastActiveAt - 1000,
    createdBy: 'user',
    participants: [],
    projectPath: '',
  };
}

describe('activity inbox aggregation', () => {
  it('aggregates unread mentions, replies, and thread updates', () => {
    const items = buildActivityInboxItems([
      {
        thread: thread('thread-a', '需求讨论', 100),
        state: {
          unreadCount: 2,
          hasUserMention: true,
          lastActivity: 300,
          messages: [
            {
              id: 'msg-1',
              threadId: 'thread-a',
              type: 'assistant',
              content: '@yangcyyang 这里需要你确认',
              timestamp: 200,
              mentionsUser: true,
            },
          ],
        },
      },
      {
        thread: thread('thread-b', '实现线程', 90),
        state: {
          unreadCount: 1,
          hasUserMention: false,
          lastActivity: 250,
          messages: [
            {
              id: 'msg-2',
              threadId: 'thread-b',
              type: 'assistant',
              content: '我回复你的问题',
              timestamp: 350,
              replyTo: 'user-msg',
            },
          ],
        },
      },
      {
        thread: thread('thread-c', '普通更新', 80),
        state: {
          unreadCount: 3,
          hasUserMention: false,
          lastActivity: 180,
          messages: [],
        },
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(['reply', 'mention', 'mention', 'thread']);
    expect(items[0]).toMatchObject({ threadId: 'thread-b', messageId: 'msg-2' });
    expect(items.find((item) => item.messageId === 'msg-1')).toMatchObject({ threadId: 'thread-a' });
    expect(items.find((item) => item.id === 'mention:thread-a:thread')).toMatchObject({
      threadId: 'thread-a',
      content: '有新的 @你 消息',
    });
    expect(items.find((item) => item.threadId === 'thread-c')).toMatchObject({ content: '3 条未读更新' });
  });

  it('counts unread badges across non-deleted threads only', () => {
    const total = countActivityUnread([
      {
        thread: thread('thread-a', 'A', 100),
        state: { unreadCount: 2, hasUserMention: false, lastActivity: 100, messages: [] },
      },
      {
        thread: { ...thread('thread-b', 'B', 100), deletedAt: Date.now() },
        state: { unreadCount: 9, hasUserMention: true, lastActivity: 100, messages: [] },
      },
    ]);

    expect(total).toBe(2);
  });
});
