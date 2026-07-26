// @ci-tier redis reason="requires isolated Redis to verify assignee-incapacitation tag/clear persistence (C1 lesson)"
/**
 * 批次4-B3 失能打标 —— 隔离 Redis 红→绿护栏验证.
 *
 * C1 学费是铁律: 默认开的自动化，护栏必须在隔离 Redis(真实存储路径)上验证过才准默认开。
 * 本测试验证 assignee_incapacitated / assignee_recovered 两个记账事件在真实 RedisTaskStore
 * 上正确落库、二次扫描不重复打标/不重复清标——同 ClaimedIdleScheduler/
 * ReviewReminderScheduler 的隔离 Redis 护栏证明形状。
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const CLEANUP_PATTERNS = ['task:*', 'tasks:*'];
const OWNER = 'opus';

function createMessageStore() {
  const messages = [];
  return {
    messages,
    async append(input) {
      const stored = { ...input, id: `msg-${messages.length + 1}` };
      messages.push(stored);
      return stored;
    },
  };
}

function createSocketManager() {
  const userEmits = [];
  return { userEmits, broadcastToRoom() {}, emitToUser(userId, event, data) { userEmits.push({ userId, event, data }); } };
}

describe('AssigneeIncapacitationScheduler — RedisTaskStore 护栏', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let AssigneeIncapacitationScheduler;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'AssigneeIncapacitationScheduler Redis 护栏');
    ({ RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
    ({ AssigneeIncapacitationScheduler } = await import(
      '../dist/domains/cats/services/agents/invocation/AssigneeIncapacitationScheduler.js'
    ));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
    store = new RedisTaskStore(redis);
  });

  it('打标记账跨两次扫描持久化，第二次扫描不得重复打标/重复通知', async () => {
    const task = await store.create({
      threadId: 'thread-main',
      title: '隔离 Redis 失能打标回归',
      why: '防止重复打标',
      createdBy: OWNER,
      userId: 'user-1',
      ownerCatId: OWNER,
      status: 'doing',
    });

    const messageStore = createMessageStore();
    const socketManager = createSocketManager();
    const since = Date.now() - 40 * 60_000; // 40 minutes ago — past the 30min default threshold
    const tracker = { getSignal: () => ({ kind: 'incapacitated', classification: 'quota_exhausted', since }) };
    const scheduler = new AssigneeIncapacitationScheduler({
      taskStore: store,
      messageStore,
      socketManager,
      tracker,
      env: {},
    });

    await scheduler.tick();
    let updated = await store.get(task.id);
    assert.equal(updated.events.filter((e) => e.type === 'assignee_incapacitated').length, 1, '首次扫描应打标一次');
    assert.equal(socketManager.userEmits.length, 1, '首次扫描应通知一次 owner');
    assert.equal(messageStore.messages.length, 1, '首次扫描应发一次频道通知');

    await scheduler.tick(); // second scan, same tracker signal
    updated = await store.get(task.id);
    assert.equal(
      updated.events.filter((e) => e.type === 'assignee_incapacitated').length,
      1,
      '第二次扫描不得重复打标（这正是 C1 事故复现的形状）',
    );
    assert.equal(socketManager.userEmits.length, 1, '不得重复通知 owner');
    assert.equal(messageStore.messages.length, 1, '不得重复发频道通知');
  });

  it('恢复清标记账持久化，第二次扫描不得重复清标；真空期事件字段完整落库', async () => {
    const since = Date.now() - 90 * 60_000;
    const task = await store.create({
      threadId: 'thread-main',
      title: '隔离 Redis 失能恢复回归',
      why: '防止重复清标',
      createdBy: OWNER,
      userId: 'user-1',
      ownerCatId: OWNER,
      status: 'doing',
      events: [{ ts: new Date(since + 5000).toISOString(), catId: 'system', type: 'assignee_incapacitated', data: { classification: 'process_abnormal', since } }],
    });

    const messageStore = createMessageStore();
    const socketManager = createSocketManager();
    const tracker = { getSignal: () => ({ kind: 'healthy' }) };
    const scheduler = new AssigneeIncapacitationScheduler({ taskStore: store, messageStore, socketManager, tracker, env: {} });

    await scheduler.tick();
    let updated = await store.get(task.id);
    const recoveredEvents = updated.events.filter((e) => e.type === 'assignee_recovered');
    assert.equal(recoveredEvents.length, 1, '首次扫描应清标一次');
    assert.equal(recoveredEvents[0].data.classification, 'process_abnormal');
    assert.equal(recoveredEvents[0].data.since, since);
    assert.ok(recoveredEvents[0].data.durationMs > 0, '真空期时长必须落库');

    await scheduler.tick();
    updated = await store.get(task.id);
    assert.equal(
      updated.events.filter((e) => e.type === 'assignee_recovered').length,
      1,
      '第二次扫描不得重复清标',
    );
  });
});
