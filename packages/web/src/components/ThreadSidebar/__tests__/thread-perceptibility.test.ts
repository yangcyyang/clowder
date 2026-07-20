import { describe, expect, it } from 'vitest';
import type { ChatMessage, Thread } from '@/stores/chatStore';
import {
  buildChannelRowModels,
  buildRelationOrderedThreadRows,
  deriveActualThreadParticipants,
  derivePresentThreadAgents,
  resolveThreadBranch,
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

  // ── Whisper hard gate: relation normal vs corrupted must be indistinguishable ──

  const secretBranchMessages = () => [
    message({
      id: 'secret-ask',
      type: 'user',
      content: '@kimi 悄悄话',
      visibility: 'whisper',
      whisperTo: ['kimi'],
      mentions: ['kimi'],
    }),
    message({
      id: 'secret-answer',
      type: 'assistant',
      catId: 'kimi',
      content: '收到，只有你能看到',
      visibility: 'whisper',
      whisperTo: ['kimi'],
    }),
  ];

  it('never leaks whisper participants/summary/active decorators to non-recipients — relation normal or corrupted', () => {
    const parent = thread({ id: 'parent', title: '公开讨论' });
    const branchNormal = thread({
      id: 'secret-branch',
      title: '密谋 (分支)',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'm1' },
    });
    const branchCorrupted = thread({
      id: 'secret-branch',
      title: '密谋 (分支)',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'NOT_THE_REAL_PARENT', rootMessageId: 'm1' },
    });
    const viewer = { type: 'cat' as const, catId: 'codex' };
    const activeInvocations = {
      'inv-secret': { catId: 'kimi', mode: 'execute' },
    };

    // ① Participants: whisper-only cat must be invisible to a non-recipient in BOTH forms.
    const participantsNormal = deriveActualThreadParticipants(secretBranchMessages(), {
      viewer,
      activeInvocations,
    });
    const participantsCorrupted = deriveActualThreadParticipants(secretBranchMessages(), {
      viewer,
      activeInvocations,
    });
    expect(participantsNormal).toEqual([]);
    expect(participantsCorrupted).toEqual(participantsNormal);

    // ② Branch resolution: normal relation resolves to its parent; corrupted degrades
    //    to orphan display WITHOUT inheriting anything from the wrong/missing parent.
    expect(resolveThreadBranch(branchNormal, [parent, branchNormal])).toEqual({ kind: 'branch', parent });
    expect(resolveThreadBranch(branchCorrupted, [parent, branchCorrupted])).toEqual({ kind: 'orphan' });

    // ③ Entry chips / sidebar rows: corrupted relation degrades to root display — never
    //    nested under (and never summarizing) a thread the viewer should not associate.
    const rowsNormal = buildChannelRowModels([parent, branchNormal]);
    const rowsCorrupted = buildChannelRowModels([parent, branchCorrupted]);
    expect(rowsNormal.find((r) => r.thread.id === 'secret-branch')).toMatchObject({ depth: 1, branch: true });
    expect(rowsCorrupted.find((r) => r.thread.id === 'secret-branch')).toMatchObject({
      depth: 0,
      branch: false,
      orphaned: true,
    });

    // ④ Active decorators stay invisible too: the actively-running whisper cat does not
    //    surface as an active participant for the non-recipient in either form.
    expect(
      derivePresentThreadAgents(
        { messages: secretBranchMessages(), activeInvocations },
        viewer,
      ),
    ).toEqual([]);
  });

  it('shows whisper participants to the recipient and to the user viewer', () => {
    const messages = secretBranchMessages();
    expect(deriveActualThreadParticipants(messages, { viewer: { type: 'cat', catId: 'kimi' } })).toEqual([
      { catId: 'kimi', active: false },
    ]);
    expect(deriveActualThreadParticipants(messages, { viewer: { type: 'user' } })).toEqual([
      { catId: 'kimi', active: false },
    ]);
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

  it('resolves branch display from durable relations only, degrading malformed data to root', () => {
    const parent = thread({ id: 'parent', title: 'Parent' });
    const branch = thread({
      id: 'branch',
      title: '已经改名',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'm1' },
    });
    const orphan = thread({
      id: 'orphan',
      title: '孤儿',
      relation: { v: 1, kind: 'edit_branch', parentThreadId: 'gone', rootMessageId: 'm2' },
    });
    const malformedKind = thread({
      id: 'malformed-kind',
      title: '坏数据',
      // Legacy/corrupted payload: unknown kind must not be trusted.
      relation: { v: 1, kind: 'unknown_kind', parentThreadId: 'parent', rootMessageId: 'm3' } as never,
    });
    const malformedVersion = thread({
      id: 'malformed-version',
      title: '坏版本',
      relation: { v: 2, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'm4' } as never,
    });
    const selfParent = thread({
      id: 'self',
      title: '自引用',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'self', rootMessageId: 'm5' },
    });
    const legacyTitleOnly = thread({ id: 'legacy', title: '预算 (分支)' });
    const all = [parent, branch, orphan, malformedKind, malformedVersion, selfParent, legacyTitleOnly];

    expect(resolveThreadBranch(parent, all)).toEqual({ kind: 'root' });
    expect(resolveThreadBranch(branch, all)).toEqual({ kind: 'branch', parent });
    expect(resolveThreadBranch(orphan, all)).toEqual({ kind: 'orphan' });
    // Malformed/legacy relation data degrades to root display (no badge, no fake parent).
    expect(resolveThreadBranch(malformedKind, all)).toEqual({ kind: 'root' });
    expect(resolveThreadBranch(malformedVersion, all)).toEqual({ kind: 'root' });
    expect(resolveThreadBranch(selfParent, all)).toEqual({ kind: 'root' });
    // Title suffix alone never implies branch identity.
    expect(resolveThreadBranch(legacyTitleOnly, all)).toEqual({ kind: 'root' });
    expect(resolveThreadBranch(undefined, all)).toEqual({ kind: 'root' });
  });

  it('builds sidebar channel rows with branch indentation and root display for orphans', () => {
    const parent = thread({ id: 'parent', title: '书籍研判' });
    const child = thread({
      id: 'child',
      title: '回复分支',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'parent', rootMessageId: 'm1' },
    });
    const orphan = thread({
      id: 'orphan',
      title: '断链分支',
      relation: { v: 1, kind: 'inline_reply', parentThreadId: 'missing', rootMessageId: 'm2' },
    });
    const plain = thread({ id: 'plain', title: '普通对话' });

    expect(buildChannelRowModels([parent, child, orphan, plain])).toEqual([
      { thread: parent, depth: 0, branch: false, orphaned: false },
      { thread: child, depth: 1, branch: true, orphaned: false },
      { thread: plain, depth: 0, branch: false, orphaned: false },
      // Orphans keep their slot after roots but degrade to root display.
      { thread: orphan, depth: 0, branch: false, orphaned: true },
    ]);
  });

  it('derives present agents from visible messages, not the config roster', () => {
    const messages = [
      message({ id: 'u1', type: 'user', content: '@codex 看一下', mentions: ['codex'] }),
      message({ id: 'a1', type: 'assistant', catId: 'opus', content: '好了' }),
    ];
    // 名册里的 kimi/glm 从未在本 thread 发言或被 @ —— 不得显示为在场。
    const present = derivePresentThreadAgents(
      {
        messages,
        activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute' } },
      },
      { type: 'user' },
    );
    expect(present).toEqual([
      { catId: 'codex', active: true },
      { catId: 'opus', active: false },
    ]);
    expect(derivePresentThreadAgents(undefined, { type: 'user' })).toEqual([]);
    expect(derivePresentThreadAgents({ messages: [], activeInvocations: {} }, { type: 'user' })).toEqual([]);
  });
});
