/**
 * [thread-task-design] §2 root cause 2: notifyBranchThreadReply — the real-time
 * "something changed" nudge for branch threads (manual inline_reply/edit_branch
 * and F194 task_thread alike). Covers:
 *  - persisted extra.slockThread.replyCount refresh on the source message
 *  - thread_reply_count_updated socket emit to the PARENT thread room (not the
 *    branch room), so users who never joined the branch still see it move
 *  - race-safety: no-op until the branch link is actually claimed
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { notifyBranchThreadReply } = await import('../dist/routes/thread-reply-summary.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

function makeSocketManager() {
  const events = [];
  return { events, broadcastToRoom: (...args) => events.push(args) };
}

describe('notifyBranchThreadReply', () => {
  it('bumps the persisted replyCount by 1 and emits thread_reply_count_updated to the parent room', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = makeSocketManager();

    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '@opus 修复登录',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const branch = await threadStore.create('alice', '修复登录 (分支)', parent.projectPath, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: source.id },
    });
    // Source copy into the branch — establishes the link (mirrors ensureTaskDiscussionThread).
    await messageStore.append({ userId: 'alice', catId: null, content: '@opus 修复登录', mentions: ['opus'], timestamp: Date.now(), threadId: branch.id });
    await messageStore.updateExtra(source.id, { slockThread: { branchThreadId: branch.id, replyCount: 0 } });

    // First real reply lands in the branch.
    await messageStore.append({ userId: 'x', catId: 'opus', content: '在查了', mentions: [], timestamp: Date.now(), threadId: branch.id });

    const result = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: branch.id });

    assert.equal(result.notified, true);
    assert.equal(result.replyCount, 1, 'one source copy + one reply → replyCount 1');

    const refreshedSource = await messageStore.getById(source.id);
    assert.equal(refreshedSource.extra.slockThread.replyCount, 1, 'persisted replyCount must be refreshed');
    assert.equal(refreshedSource.extra.slockThread.branchThreadId, branch.id);

    const emits = socketManager.events.filter(([, name]) => name === 'thread_reply_count_updated');
    assert.equal(emits.length, 1, 'must emit exactly one thread_reply_count_updated');
    const [room, , payload] = emits[0];
    assert.equal(room, `thread:${parent.id}`, 'must target the PARENT thread room, not the branch room');
    assert.deepEqual(payload, { sourceMessageId: source.id, branchThreadId: branch.id, replyCount: 1 });
  });

  it('replyCount keeps incrementing as more replies land', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = makeSocketManager();

    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '问一下',
      mentions: [],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const branch = await threadStore.create('alice', '问一下 (分支)', parent.projectPath, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: source.id },
    });
    await messageStore.append({ userId: 'alice', catId: null, content: '问一下', mentions: [], timestamp: Date.now(), threadId: branch.id });
    await messageStore.updateExtra(source.id, { slockThread: { branchThreadId: branch.id, replyCount: 0 } });

    await messageStore.append({ userId: 'x', catId: 'opus', content: '回复1', mentions: [], timestamp: Date.now(), threadId: branch.id });
    const r1 = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: branch.id });
    assert.equal(r1.replyCount, 1);

    await messageStore.append({ userId: 'x', catId: 'opus', content: '回复2', mentions: [], timestamp: Date.now(), threadId: branch.id });
    const r2 = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: branch.id });
    assert.equal(r2.replyCount, 2);

    const emits = socketManager.events.filter(([, name]) => name === 'thread_reply_count_updated');
    assert.equal(emits.length, 2);
    assert.equal(emits[1][2].replyCount, 2);
  });

  it('is a no-op for a thread with no relation (not a branch thread)', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = makeSocketManager();

    const plain = await threadStore.create('alice', '普通对话');
    await messageStore.append({ userId: 'alice', catId: null, content: '你好', mentions: [], timestamp: Date.now(), threadId: plain.id });

    const result = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: plain.id });

    assert.equal(result.notified, false);
    assert.equal(socketManager.events.length, 0, 'must not emit for a non-branch thread');
  });

  it('is a no-op (race-safe) before the branch link is claimed on the source message', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = makeSocketManager();

    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '修复登录',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const branch = await threadStore.create('alice', '修复登录 (分支)', parent.projectPath, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: source.id },
    });
    // Source copy appended, but the link (extra.slockThread on the ORIGINAL
    // source message) has NOT been claimed yet — mirrors the moment between
    // threadStore.create() and claimBranchThreadLink()/updateExtra() during
    // setup, where this must never race the atomic claim.
    await messageStore.append({ userId: 'alice', catId: null, content: '修复登录', mentions: ['opus'], timestamp: Date.now(), threadId: branch.id });

    const result = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: branch.id });

    assert.equal(result.notified, false, 'must not touch the source message before the link is claimed');
    assert.equal(socketManager.events.length, 0);
    const untouchedSource = await messageStore.getById(source.id);
    assert.equal(untouchedSource.extra, undefined, 'source message extra must be untouched pre-claim');
  });

  it('is a no-op when the source message is linked to a DIFFERENT branch thread', async () => {
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const socketManager = makeSocketManager();

    const parent = await threadStore.create('alice', '大厅');
    const source = await messageStore.append({
      userId: 'alice',
      catId: null,
      content: '修复登录',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: parent.id,
    });
    const otherBranch = await threadStore.create('alice', '别的分支');
    await messageStore.updateExtra(source.id, { slockThread: { branchThreadId: otherBranch.id, replyCount: 0 } });

    const branch = await threadStore.create('alice', '修复登录 (分支)', parent.projectPath, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: source.id },
    });
    await messageStore.append({ userId: 'x', catId: 'opus', content: '回复', mentions: [], timestamp: Date.now(), threadId: branch.id });

    const result = await notifyBranchThreadReply({ threadStore, messageStore, socketManager }, { branchThreadId: branch.id });

    assert.equal(result.notified, false);
    const untouchedSource = await messageStore.getById(source.id);
    assert.equal(untouchedSource.extra.slockThread.branchThreadId, otherBranch.id, 'must not steal the link');
  });
});
