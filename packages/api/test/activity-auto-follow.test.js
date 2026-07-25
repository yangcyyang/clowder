/**
 * activity-auto-follow.ts unit tests (batch 3-D)
 * Pure logic + a tiny in-memory IFollowStore fake — no Redis required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoFollowOnAppend, resolveAutoFollowReason } from '../dist/routes/activity-auto-follow.js';

function createFakeFollowStore() {
  const follows = new Map(); // `${userId}:${threadId}` -> reason
  return {
    follows,
    async follow(userId, threadId, reason) {
      const key = `${userId}:${threadId}`;
      if (follows.has(key)) return false;
      follows.set(key, reason);
      return true;
    },
    async unfollow(userId, threadId) {
      return follows.delete(`${userId}:${threadId}`);
    },
    async isFollowing(userId, threadId) {
      return follows.has(`${userId}:${threadId}`);
    },
    async listFollowedThreadIds(userId) {
      return [...follows.keys()].filter((k) => k.startsWith(`${userId}:`)).map((k) => k.slice(userId.length + 1));
    },
    async getFollowedAt() {
      return null;
    },
    async deleteByThread() {},
  };
}

describe('resolveAutoFollowReason (pure)', () => {
  it('human-sent message (catId=null) → participant', () => {
    assert.equal(resolveAutoFollowReason({ catId: null, mentionsUser: false, userId: 'default-user' }), 'participant');
  });

  it('cat reply mentioning the user → mention', () => {
    assert.equal(resolveAutoFollowReason({ catId: 'opus', mentionsUser: true, userId: 'default-user' }), 'mention');
  });

  it('ordinary cat reply, no mention → null (no auto-follow)', () => {
    assert.equal(resolveAutoFollowReason({ catId: 'opus', mentionsUser: false, userId: 'default-user' }), null);
  });

  it('system/scheduler authored message never triggers follow', () => {
    assert.equal(resolveAutoFollowReason({ catId: null, mentionsUser: false, userId: 'system' }), null);
    assert.equal(resolveAutoFollowReason({ catId: null, mentionsUser: true, userId: 'scheduler' }), null);
  });
});

describe('autoFollowOnAppend', () => {
  it('follows the sender when a human participates', async () => {
    const followStore = createFakeFollowStore();
    const messageStore = {
      async getById(id) {
        assert.equal(id, 'msg-1');
        return { id: 'msg-1', threadId: 't-1', userId: 'default-user', catId: null, mentionsUser: false };
      },
    };

    const result = await autoFollowOnAppend({ followStore, messageStore }, { id: 'msg-1' });
    assert.deepEqual(result, { followed: true, reason: 'participant' });
    assert.equal(await followStore.isFollowing('default-user', 't-1'), true);
  });

  it('follows the mentioned user when a cat message mentions them', async () => {
    const followStore = createFakeFollowStore();
    const messageStore = {
      async getById() {
        return { id: 'msg-2', threadId: 't-2', userId: 'default-user', catId: 'opus', mentionsUser: true };
      },
    };

    const result = await autoFollowOnAppend({ followStore, messageStore }, { id: 'msg-2' });
    assert.deepEqual(result, { followed: true, reason: 'mention' });
  });

  it('is idempotent — second append from the same participant is a no-op', async () => {
    const followStore = createFakeFollowStore();
    const messageStore = {
      async getById() {
        return { id: 'msg-3', threadId: 't-3', userId: 'default-user', catId: null, mentionsUser: false };
      },
    };

    const first = await autoFollowOnAppend({ followStore, messageStore }, { id: 'msg-3' });
    const second = await autoFollowOnAppend({ followStore, messageStore }, { id: 'msg-3' });
    assert.equal(first.followed, true);
    assert.equal(second.followed, false);
  });

  it('does not follow on an ordinary unmentioned cat reply', async () => {
    const followStore = createFakeFollowStore();
    const messageStore = {
      async getById() {
        return { id: 'msg-4', threadId: 't-4', userId: 'default-user', catId: 'opus', mentionsUser: false };
      },
    };

    const result = await autoFollowOnAppend({ followStore, messageStore }, { id: 'msg-4' });
    assert.equal(result.followed, false);
    assert.equal(await followStore.isFollowing('default-user', 't-4'), false);
  });

  it('handles a missing message gracefully (no throw)', async () => {
    const followStore = createFakeFollowStore();
    const messageStore = { async getById() { return null; } };
    const result = await autoFollowOnAppend({ followStore, messageStore }, { id: 'missing' });
    assert.equal(result.followed, false);
  });
});
