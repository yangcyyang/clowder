/**
 * activity.ts route tests (batch 3-D) — Activity aggregated inbox.
 * Uses the real in-memory ThreadStore/MessageStore/TaskStore (no Redis) plus
 * tiny in-memory fakes for IFollowStore/IThreadReadStateStore, driven through
 * the actual Fastify plugin via app.inject — no network, no Redis required.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const USER_HEADER = { 'x-cat-cafe-user': 'default-user' };
const USER = 'default-user';

function createFakeFollowStore() {
  const entries = new Map(); // `${userId}:${threadId}` -> { reason, followedAt }
  return {
    async follow(userId, threadId, reason) {
      const key = `${userId}:${threadId}`;
      if (entries.has(key)) return false;
      entries.set(key, { reason, followedAt: Date.now() });
      return true;
    },
    async unfollow(userId, threadId) {
      return entries.delete(`${userId}:${threadId}`);
    },
    async isFollowing(userId, threadId) {
      return entries.has(`${userId}:${threadId}`);
    },
    async listFollowedThreadIds(userId) {
      const prefix = `${userId}:`;
      return [...entries.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    async getFollowedAt(userId, threadId) {
      return entries.get(`${userId}:${threadId}`)?.followedAt ?? null;
    },
    async deleteByThread(threadId) {
      for (const key of [...entries.keys()]) {
        if (key.endsWith(`:${threadId}`)) entries.delete(key);
      }
    },
  };
}

function createFakeReadStateStore() {
  const cursors = new Map(); // `${userId}:${threadId}` -> lastReadMessageId
  return {
    async get(userId, threadId) {
      const key = `${userId}:${threadId}`;
      if (!cursors.has(key)) return null;
      return { userId, threadId, lastReadMessageId: cursors.get(key), updatedAt: Date.now() };
    },
    async ack(userId, threadId, messageId) {
      const key = `${userId}:${threadId}`;
      const cur = cursors.get(key);
      if (cur && messageId <= cur) return false;
      cursors.set(key, messageId);
      return true;
    },
    async getUnreadSummaries() {
      return [];
    },
    async deleteByThread() {},
  };
}

describe('Activity aggregated inbox routes', () => {
  let threadStore;
  let messageStore;
  let taskStore;
  let followStore;
  let readStateStore;
  let activityRoutes;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    ({ activityRoutes } = await import('../dist/routes/activity.js'));

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    followStore = createFakeFollowStore();
    readStateStore = createFakeReadStateStore();
  });

  async function createApp() {
    const app = Fastify();
    await app.register(activityRoutes, { threadStore, messageStore, taskStore, followStore, readStateStore });
    return app;
  }

  function appendUserMessage(threadId, over = {}) {
    return messageStore.append({
      userId: USER,
      catId: null,
      content: '你好',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      ...over,
    });
  }

  function appendCatReply(threadId, over = {}) {
    return messageStore.append({
      userId: USER,
      catId: 'opus',
      content: '好的，收到',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      ...over,
    });
  }

  function appendMention(threadId, over = {}) {
    return appendCatReply(threadId, { content: '@铲屎官 需要你确认一下', mentionsUser: true, ...over });
  }

  function appendTaskStatusNotice(threadId, over = {}) {
    return messageStore.append({
      userId: 'system',
      catId: null,
      content: 'task #1 状态：进行中 → 待验收。',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      source: {
        connector: 'task-system',
        label: 'Task',
        icon: '📋',
        meta: { presentation: 'system_notice', noticeTone: 'info', eventType: 'task_status_changed' },
      },
      ...over,
    });
  }

  test('GET /api/activity is empty when following nothing', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/activity', headers: USER_HEADER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.unreadCount, 0);
    assert.equal(body.hasMore, false);
  });

  test('follow then a cat reply surfaces as a reply item; own typed messages never do', async () => {
    const thread = threadStore.create(USER, 'General');
    appendUserMessage(thread.id); // the human's own message — must not appear

    const app = await createApp();
    const followRes = await app.inject({
      method: 'POST',
      url: '/api/activity/follow',
      headers: USER_HEADER,
      payload: { threadId: thread.id },
    });
    assert.equal(followRes.statusCode, 200);
    assert.equal(followRes.json().followed, true);

    // Posted *after* the follow started — realistic ordering (a synthetic
    // watermark from followedAt intentionally treats pre-follow history as
    // already read; see activity.ts's module doc).
    const reply = appendCatReply(thread.id);

    const feedRes = await app.inject({ method: 'GET', url: '/api/activity?filter=all', headers: USER_HEADER });
    const body = feedRes.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'reply');
    assert.equal(body.items[0].messageId, reply.id);
    assert.equal(body.items[0].threadTitle, 'General');
    assert.equal(body.unreadCount, 1);
  });

  test('mentions filter only returns @-mention items', async () => {
    const thread = threadStore.create(USER, 'Mentions channel');
    appendCatReply(thread.id); // plain reply — not a mention
    const mention = appendMention(thread.id);
    await followStore.follow(USER, thread.id, 'mention');

    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/activity?filter=mentions', headers: USER_HEADER });
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'mention');
    assert.equal(body.items[0].messageId, mention.id);
  });

  test('task_status_changed system notices surface as task_status items', async () => {
    const thread = threadStore.create(USER, 'Task channel');
    const notice = appendTaskStatusNotice(thread.id);
    await followStore.follow(USER, thread.id, 'participant');

    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/activity?filter=all', headers: USER_HEADER });
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'task_status');
    assert.equal(body.items[0].messageId, notice.id);
  });

  test('unread filter + POST /api/activity/read acks and removes the item from unread', async () => {
    const thread = threadStore.create(USER, 'Read state channel');
    const reply = appendCatReply(thread.id);
    await followStore.follow(USER, thread.id, 'participant');

    const app = await createApp();
    const before = await app.inject({ method: 'GET', url: '/api/activity?filter=unread', headers: USER_HEADER });
    assert.equal(before.json().items.length, 1);

    const ack = await app.inject({
      method: 'POST',
      url: '/api/activity/read',
      headers: USER_HEADER,
      payload: { threadId: thread.id, messageId: reply.id },
    });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().advanced, true);

    const after = await app.inject({ method: 'GET', url: '/api/activity?filter=unread', headers: USER_HEADER });
    assert.equal(after.json().items.length, 0);

    const allAfter = await app.inject({ method: 'GET', url: '/api/activity?filter=all', headers: USER_HEADER });
    assert.equal(allAfter.json().items.length, 1);
    assert.equal(allAfter.json().items[0].read, true);
  });

  test('task-discussion branch of a followed thread contributes items ("含任务讨论分支")', async () => {
    const parent = threadStore.create(USER, 'Parent channel');
    const branch = threadStore.create(USER, null, undefined, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: 'root-msg' },
    });
    taskStore.create({ threadId: parent.id, title: '写报告', why: 'because', createdBy: 'user', taskThreadId: branch.id });
    const branchReply = appendCatReply(branch.id);
    await followStore.follow(USER, parent.id, 'participant');

    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/activity?filter=all', headers: USER_HEADER });
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].messageId, branchReply.id);
    assert.equal(body.items[0].threadId, branch.id);
    assert.equal(body.items[0].sourceThreadId, parent.id);
    assert.equal(body.items[0].isBranch, true);
    assert.equal(body.items[0].threadTitle, 'Parent channel');
  });

  test('unfollow removes the thread from the feed', async () => {
    const thread = threadStore.create(USER, 'Unfollow me');
    appendCatReply(thread.id);
    await followStore.follow(USER, thread.id, 'participant');

    const app = await createApp();
    const before = await app.inject({ method: 'GET', url: '/api/activity', headers: USER_HEADER });
    assert.equal(before.json().items.length, 1);

    const unfollowRes = await app.inject({
      method: 'POST',
      url: '/api/activity/unfollow',
      headers: USER_HEADER,
      payload: { threadId: thread.id },
    });
    assert.equal(unfollowRes.json().unfollowed, true);

    const after = await app.inject({ method: 'GET', url: '/api/activity', headers: USER_HEADER });
    assert.equal(after.json().items.length, 0);
  });

  test('cursor pagination walks the full feed without gaps or repeats', async () => {
    const thread = threadStore.create(USER, 'Paginated channel');
    await followStore.follow(USER, thread.id, 'participant');
    const posted = [];
    for (let i = 0; i < 5; i++) {
      posted.push(appendCatReply(thread.id, { content: `reply #${i}`, timestamp: Date.now() + i }));
    }

    const app = await createApp();
    const seen = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const url = `/api/activity?filter=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: USER_HEADER });
      const body = res.json();
      seen.push(...body.items.map((i) => i.messageId));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    assert.equal(seen.length, 5);
    assert.deepEqual(new Set(seen), new Set(posted.map((m) => m.id)));
    // newest-first, and no duplicates across pages
    assert.equal(new Set(seen).size, seen.length);
  });

  test('POST /api/activity/read-all acks every followed thread (and its task branch) to latest', async () => {
    const parent = threadStore.create(USER, 'Parent');
    const branch = threadStore.create(USER, null, undefined, {
      relation: { v: 1, kind: 'task_thread', parentThreadId: parent.id, rootMessageId: 'root-msg' },
    });
    taskStore.create({ threadId: parent.id, title: 'T', why: 'w', createdBy: 'user', taskThreadId: branch.id });
    appendCatReply(parent.id);
    appendCatReply(branch.id);
    await followStore.follow(USER, parent.id, 'participant');

    const app = await createApp();
    const beforeUnread = (await app.inject({ method: 'GET', url: '/api/activity?filter=unread', headers: USER_HEADER })).json();
    assert.equal(beforeUnread.items.length, 2);

    const readAll = await app.inject({ method: 'POST', url: '/api/activity/read-all', headers: USER_HEADER });
    assert.equal(readAll.statusCode, 200);
    assert.equal(readAll.json().totalThreads, 2);

    const afterUnread = (await app.inject({ method: 'GET', url: '/api/activity?filter=unread', headers: USER_HEADER })).json();
    assert.equal(afterUnread.items.length, 0);
  });
});
