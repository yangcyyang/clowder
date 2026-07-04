import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { Thread } from '@/stores/chat-types';
import { buildQuickSwitchItems } from '../quick-switcher';

const CODEX_CAT: CatData = {
  id: 'codex',
  displayName: '老者-codex',
  color: { primary: '#f26aa3', secondary: '#ffd6e8' },
  mentionPatterns: ['@codex'],
  clientId: 'openai',
  defaultModel: 'gpt-5',
  avatar: 'cat',
  roleDescription: 'test',
  personality: 'test',
};

function thread(partial: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  const { id, ...rest } = partial;
  return {
    id,
    projectPath: partial.projectPath ?? 'default',
    title: partial.title ?? null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: partial.lastActiveAt ?? 1,
    createdAt: 1,
    ...rest,
  };
}

describe('buildQuickSwitchItems', () => {
  it('finds direct messages by cat identity and emits thread hrefs', () => {
    const items = buildQuickSwitchItems({
      threads: [
        thread({ id: 'thread-roadmap', title: '路线图', lastActiveAt: 10 }),
        thread({ id: 'dm-codex', title: null, isDM: true, preferredCats: ['codex'], lastActiveAt: 20 }),
      ],
      cats: [CODEX_CAT],
      query: 'codex',
      pathname: '/thread/thread-roadmap',
      currentSearch: '',
    });

    expect(items[0]).toMatchObject({
      type: 'dm',
      label: '老者-codex',
      href: '/thread/dm-codex',
      threadId: 'dm-codex',
    });
  });

  it('adds a global search action carrying the current query', () => {
    const items = buildQuickSwitchItems({
      threads: [thread({ id: 'thread-roadmap', title: '路线图' })],
      cats: [],
      query: '设计 agent',
      pathname: '/thread/thread-roadmap',
      currentSearch: '',
    });

    expect(items.at(-1)).toMatchObject({
      type: 'search',
      href: '/search?from=thread-roadmap&q=%E8%AE%BE%E8%AE%A1+agent',
    });
  });
});
