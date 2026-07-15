// @ci-tier redis reason="requires isolated Redis read-state and message stores"
/**
 * RedisThreadReadStateStore tests (F069)
 * 有 Redis → 测全量；无 Redis → skip
 *
 * Real data model: cat messages and user messages share the same userId (tenant ID).
 * User's own message: catId=null, no source.
 * Cat message: catId='opus' (or any CatId).
 * Connector message: source={...}.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisThreadReadStateStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisThreadReadStateStore;
  let RedisMessageStore;
  let createRedisClient;
  let redis;
  let store;
  let messageStore;
  let connected = false;
  let testSeq = 0;

  const uniqueId = (prefix) => `${prefix}-${++testSeq}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisThreadReadStateStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisThreadReadStateStore.js');
    RedisThreadReadStateStore = storeModule.RedisThreadReadStateStore;
    const msgModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = msgModule.RedisMessageStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-read-state-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisThreadReadStateStore(redis);
    messageStore = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['read-state:*', 'msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
  });

  // --- ack basics ---

  it('get() returns null for unread thread', async () => {
    const tid = uniqueId('t');
    const result = await store.get('user1', tid);
    assert.equal(result, null);
  });

  it('ack() sets cursor and get() retrieves it', async () => {
    const tid = uniqueId('t');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, true);

    const state = await store.get('user1', tid);
    assert.equal(state.userId, 'user1');
    assert.equal(state.threadId, tid);
    assert.equal(state.lastReadMessageId, 'msg-001');
    assert.ok(state.updatedAt > 0);
  });

  it('ack() monotonic: rejects older message ID', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-002');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, false);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-002');
  });

  it('ack() monotonic: accepts newer message ID', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    const advanced = await store.ack('user1', tid, 'msg-003');
    assert.equal(advanced, true);

    const state = await store.get('user1', tid);
    assert.equal(state.lastReadMessageId, 'msg-003');
  });

  it('ack() same ID is no-op', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    const advanced = await store.ack('user1', tid, 'msg-001');
    assert.equal(advanced, false);
  });

  // --- getUnreadSummaries (realistic data model: same userId for user + cat messages) ---

  it('getUnreadSummaries() counts cat messages as unread', async () => {
    const tid = uniqueId('t');
    // Cat messages share same userId as tenant — catId distinguishes them
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'world',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'test',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].threadId, tid);
    assert.equal(summaries[0].unreadCount, 2);
    assert.equal(summaries[0].hasUserMention, false);
    assert.equal(summaries[0].lastReadMessageId, m1.id);
  });

  it('getUnreadSummaries() excludes user own messages (catId=null)', async () => {
    const tid = uniqueId('t');
    // Cat message (catId='opus') — should be counted
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'cat reply',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    // User's own message (catId=null) — should NOT be counted
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: 'my question',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    // Cat reply (catId='opus') — should be counted
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'cat reply 2',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    // Only 1 unread (cat reply 2), user's own message excluded
    assert.equal(summaries[0].unreadCount, 1);
  });

  it('getUnreadSummaries() excludes deleted messages from count', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    const m2 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'to delete',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'keep',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);
    await messageStore.softDelete(m2.id, 'user1');

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    // Only 1 unread (keep), deleted message excluded
    assert.equal(summaries[0].unreadCount, 1);
  });

  it('getUnreadSummaries() excludes internal tool-only and telemetry fallback messages', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'visible baseline',
      mentions: [],
      timestamp: Date.now() - 4000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'gpt52',
      content: '',
      toolEvents: [{ id: 't1', type: 'tool_use', label: 'Read file', timestamp: Date.now() }],
      mentions: [],
      timestamp: Date.now() - 3000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'gpt52',
      content: 'Codex 本轮已完成，但没有输出最终总结。最后进度：command_execution completed exit_code=0',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: null,
      content: '运行服务已恢复，已自动接续 gpt52 的 1 个进行中请求；已发送的消息会保留。',
      source: {
        connector: 'startup-reconciler',
        label: '重启通知',
        icon: '⚠️',
        meta: { presentation: 'system_notice' },
      },
      mentions: [],
      timestamp: Date.now() - 1500,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'system',
      catId: null,
      content: '专家猫 → Codex',
      extra: { systemKind: 'a2a_routing' },
      mentions: [],
      timestamp: Date.now() - 1200,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'system',
      catId: null,
      content: 'Codex 仍在工作中… 30s',
      extra: { systemKind: 'progress_heartbeat' },
      mentions: [],
      timestamp: Date.now() - 1100,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'gpt52',
      content: '真正给用户看的结论',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].unreadCount, 1);
  });

  it('getUnreadSummaries() detects mentionsUser', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tid,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: '@铲屎官 look',
      mentions: [],
      mentionsUser: true,
      timestamp: Date.now() - 1000,
      threadId: tid,
    });

    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].hasUserMention, true);
  });

  it('getUnreadSummaries() returns 0 for fully read thread', async () => {
    const tid = uniqueId('t');
    const m1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });
    await store.ack('user1', tid, m1.id);

    const summaries = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(summaries[0].unreadCount, 0);
  });

  it('getUnreadSummaries() seeds a cold-start baseline and counts the next visible message', async () => {
    const tid = uniqueId('t');
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tid,
    });
    const baselineMessage = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'world',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });

    // The first hydration keeps legacy history read, but must persist its latest
    // message as a baseline so future messages can survive a refresh as unread.
    const initial = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(initial[0].unreadCount, 0);
    assert.equal(initial[0].hasUserMention, false);
    assert.equal(initial[0].lastReadMessageId, baselineMessage.id);
    assert.equal((await store.get('user1', tid)).lastReadMessageId, baselineMessage.id);

    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'new after baseline',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: tid,
    });

    const afterNewMessage = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(afterNewMessage[0].unreadCount, 1);
    assert.equal(afterNewMessage[0].lastReadMessageId, baselineMessage.id);
  });

  it('a focused tab ack clears the shared cursor for another store instance', async () => {
    const tid = uniqueId('t');
    const first = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'baseline',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });
    await store.ack('user1', tid, first.id);
    const latest = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'new reply',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: tid,
    });

    const otherTabStore = new RedisThreadReadStateStore(redis);
    assert.equal((await otherTabStore.getUnreadSummaries('user1', [tid], messageStore))[0].unreadCount, 1);

    // A genuinely focused tab reads the message. Shared cursor semantics are intentional.
    await store.ack('user1', tid, latest.id);
    assert.equal((await otherTabStore.getUnreadSummaries('user1', [tid], messageStore))[0].unreadCount, 0);
  });

  it('seeds an empty-thread baseline so its first visible reply is unread', async () => {
    const tid = uniqueId('t');

    const initial = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(initial[0].unreadCount, 0);
    assert.equal(initial[0].lastReadMessageId, '0');

    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'first reply',
      mentions: [],
      timestamp: Date.now(),
      threadId: tid,
    });

    const afterFirstReply = await store.getUnreadSummaries('user1', [tid], messageStore);
    assert.equal(afterFirstReply[0].unreadCount, 1);
    assert.equal(afterFirstReply[0].lastReadMessageId, '0');
  });

  it('getUnreadSummaries() handles multiple threads (mixed cursor states)', async () => {
    const tA = uniqueId('t');
    const tB = uniqueId('t');
    const mA1 = await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'a1',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId: tA,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'a2',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId: tA,
    });
    await messageStore.append({
      userId: 'user1',
      catId: 'opus',
      content: 'b',
      mentions: [],
      timestamp: Date.now(),
      threadId: tB,
    });

    // Ack thread A at first message → 1 unread; thread B seeds its current message as baseline.
    await store.ack('user1', tA, mA1.id);

    const summaries = await store.getUnreadSummaries('user1', [tA, tB], messageStore);
    const map = new Map(summaries.map((s) => [s.threadId, s]));
    assert.equal(map.get(tA).unreadCount, 1);
    assert.equal(map.get(tA).lastReadMessageId, mA1.id);
    assert.equal(map.get(tB).unreadCount, 0);
    assert.ok(map.get(tB).lastReadMessageId);
  });

  // --- deleteByThread ---

  it('deleteByThread() cleans up cursor', async () => {
    const tid = uniqueId('t');
    await store.ack('user1', tid, 'msg-001');
    await store.deleteByThread(tid);
    const state = await store.get('user1', tid);
    assert.equal(state, null);
  });

  it('different users have independent cursors', async () => {
    const tid = uniqueId('t');
    await store.ack('userA', tid, 'msg-003');
    await store.ack('userB', tid, 'msg-001');

    const stateA = await store.get('userA', tid);
    const stateB = await store.get('userB', tid);
    assert.equal(stateA.lastReadMessageId, 'msg-003');
    assert.equal(stateB.lastReadMessageId, 'msg-001');
  });
});
