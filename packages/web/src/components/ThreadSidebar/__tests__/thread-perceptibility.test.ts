import { describe, expect, it } from 'vitest';
import type { ChatMessage, Thread } from '@/stores/chatStore';
import {
  buildRelationOrderedThreadRows,
  deriveActualThreadParticipants,
} from '../thread-perceptibility';

function message(input: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type' | 'content'>): ChatMessage {
  return {
    timestamp: 1,
    ...input,
  };
}

function thread(input: Partial<Thread> & Pick<Thread, 'id' | 'title'>): Thread {
  return {
    projectPath: 'default',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    ...input,
  };
}

describe('thread perceptibility helpers', () => {
  it('derives participants only after viewer-safe message filtering and never promotes hidden active cats', () => {
    const messages = [
      message({
        id: 'public-mention',
        type: 'user',
        content: '@codex help',
        mentions: ['codex'],
      }),
      message({ id: 'public-reply', type: 'assistant', catId: 'opus', content: 'done' }),
      message({
        id: 'secret-mention',
        type: 'user',
        content: '@kimi secret',
        visibility: 'whisper',
        whisperTo: ['kimi'],
        mentions: ['kimi'],
      }),
      message({
        id: 'secret-reply',
        type: 'assistant',
        catId: 'kimi',
        content: 'secret answer',
        visibility: 'whisper',
        whisperTo: ['kimi'],
      }),
    ];

    expect(
      deriveActualThreadParticipants(messages, {
        viewer: { type: 'cat', catId: 'codex' },
        activeInvocations: {
          'inv-visible': { catId: 'codex', mode: 'execute' },
          'inv-hidden': { catId: 'kimi', mode: 'execute' },
        },
      }),
    ).toEqual([
      { catId: 'codex', active: true },
      { catId: 'opus', active: false },
    ]);
  });

  it('keeps whisper derivation unchanged when relation is absent or malformed upstream', () => {
    const messages = [
      message({ id: 'public', type: 'assistant', catId: 'codex', content: 'public' }),
      message({
        id: 'secret',
        type: 'assistant',
        catId: 'kimi',
        content: 'private',
        visibility: 'whisper',
        whisperTo: ['kimi'],
      }),
    ];
    const options = {
      viewer: { type: 'cat' as const, catId: 'codex' },
      activeInvocations: { secret: { catId: 'kimi', mode: 'execute' } },
    };

    const withRelation = deriveActualThreadParticipants(messages, options);
    const degradedRoot = deriveActualThreadParticipants(messages, options);
    expect(withRelation).toEqual([{ catId: 'codex', active: false }]);
    expect(degradedRoot).toEqual(withRelation);
  });

  it('orders relation children after their parent without using branch-like titles', () => {
    const parent = thread({ id: 'parent', title: '书籍研判', lastActiveAt: 30 });
    const renamedChild = thread({
      id: 'child',
      title: '已经改名',
      lastActiveAt: 40,
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'msg-root' },
    });
    const titleOnlyRoot = thread({ id: 'title-root', title: '预算 (分支)', lastActiveAt: 20 });
    const orphan = thread({
      id: 'orphan',
      title: '找不到父线程',
      lastActiveAt: 10,
      relation: { v: 1, kind: 'edit_branch', parentThreadId: 'missing', rootMessageId: 'msg-orphan' },
    });

    expect(buildRelationOrderedThreadRows([renamedChild, parent, titleOnlyRoot, orphan])).toEqual([
      { thread: parent, depth: 0, orphaned: false },
      { thread: renamedChild, depth: 1, orphaned: false },
      { thread: titleOnlyRoot, depth: 0, orphaned: false },
      { thread: orphan, depth: 1, orphaned: true },
    ]);
  });

  it('keeps nested and cyclic relation nodes visible', () => {
    const parent = thread({ id: 'parent', title: 'Parent' });
    const child = thread({
      id: 'child',
      title: 'Child',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'm1' },
    });
    const grandchild = thread({
      id: 'grandchild',
      title: 'Grandchild',
      relation: { v: 1, kind: 'edit_branch', parentThreadId: 'child', rootMessageId: 'm2' },
    });
    const selfCycle = thread({
      id: 'cycle',
      title: 'Cycle',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'cycle', rootMessageId: 'm3' },
    });

    expect(buildRelationOrderedThreadRows([parent, child, grandchild, selfCycle])).toEqual([
      { thread: parent, depth: 0, orphaned: false },
      { thread: child, depth: 1, orphaned: false },
      { thread: grandchild, depth: 2, orphaned: false },
      { thread: selfCycle, depth: 1, orphaned: true },
    ]);
  });
});
