import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chatStore';
import {
  buildMessageReminderText,
  getDefaultReminderTargetCatId,
  getMessageReminderExcerpt,
  getTonightReminderTime,
  parseDatetimeLocalValue,
  toDatetimeLocalValue,
} from '../message-reminders';

function cat(id: string): CatData {
  return {
    id,
    displayName: id,
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [],
    clientId: 'openai',
    defaultModel: '',
    avatar: '',
    roleDescription: '',
    personality: '',
  };
}

describe('message reminder helpers', () => {
  it('builds a stable source-message anchored reminder message', () => {
    const message: ChatMessage = {
      id: 'msg-1',
      type: 'assistant',
      catId: 'codex',
      content: '第一行\n第二行',
      timestamp: 1,
    };

    expect(buildMessageReminderText(message)).toContain('跟进这条消息：第一行 第二行');
    expect(buildMessageReminderText(message)).toContain('消息 ID：msg-1');
  });

  it('chooses author, explicit target, then roster fallback', () => {
    const cats = [cat('codex'), cat('claude')];
    expect(
      getDefaultReminderTargetCatId({ id: 'a', type: 'assistant', catId: 'claude', content: '', timestamp: 1 }, cats),
    ).toBe('claude');
    expect(
      getDefaultReminderTargetCatId(
        { id: 'b', type: 'user', content: '', timestamp: 1, extra: { targetCats: ['codex'] } },
        cats,
      ),
    ).toBe('codex');
    expect(getDefaultReminderTargetCatId({ id: 'c', type: 'user', content: '', timestamp: 1 }, cats)).toBe('codex');
  });

  it('keeps tonight in the future and round-trips datetime-local values', () => {
    const todayMorning = new Date(2026, 6, 4, 9, 0, 0).getTime();
    const lateNight = new Date(2026, 6, 4, 22, 0, 0).getTime();

    expect(getTonightReminderTime(todayMorning)).toBe(new Date(2026, 6, 4, 21, 0, 0).getTime());
    expect(getTonightReminderTime(lateNight)).toBe(new Date(2026, 6, 5, 21, 0, 0).getTime());
    expect(parseDatetimeLocalValue(toDatetimeLocalValue(todayMorning))).toBe(todayMorning);
  });

  it('truncates long excerpts', () => {
    const excerpt = getMessageReminderExcerpt('x'.repeat(20), 10);
    expect(excerpt).toBe('xxxxxxxxx…');
  });
});
