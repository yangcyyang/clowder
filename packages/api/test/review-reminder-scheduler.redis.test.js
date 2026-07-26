// @ci-tier redis reason="requires isolated Redis to verify review-reminder bookkeeping persistence (C1 lesson: in-memory-only tests are not enough for default-on scanners)"
/**
 * 批次4-B2 分轨超时提醒 —— 隔离 Redis 红→绿护栏验证.
 *
 * C1 学费是铁律 (docs/prd/batch4-codex-execution.md §现场情报 2): 默认开的自动化，
 * 护栏必须在隔离 Redis(真实存储路径)上验证过才准默认开。ClaimedIdleScheduler 的教训
 * 正是"内存 TaskStore 测试全绿，但生产 Redis 路径上 nudge 计数疑似未落库/读不回，每次
 * 扫描都以为是第 0 次"——本测试对 ReviewReminderScheduler 的 review_reminder_sent /
 * review_timeout_reverted 记账做同款验证：真实 RedisTaskStore 上连续两次扫描 tick，
 * 断言第二次不重复提醒/不重复状态动作。
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
const GATE_REVIEWER = 'gpt52';
const OWNER = 'opus';

function createQueue() {
  const enqueued = [];
  return {
    enqueued,
    hasActiveIdempotencyKey: () => false,
    enqueue(input) {
      const entry = { id: `entry-${enqueued.length + 1}`, ...input };
      enqueued.push(entry);
      return { outcome: 'enqueued', entry, deduped: false, queuePosition: enqueued.length };
    },
    async persistEntry() {},
  };
}

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

describe('ReviewReminderScheduler — RedisTaskStore 护栏', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisTaskStore;
  let ReviewReminderScheduler;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'ReviewReminderScheduler Redis 护栏');
    ({ RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
    ({ ReviewReminderScheduler } = await import(
      '../dist/domains/cats/services/agents/invocation/ReviewReminderScheduler.js'
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

  it('gate 轨: reviewerId 与 review_reminder_sent 记账跨扫描持久化，第二次扫描不得重复提醒', async () => {
    const initialNow = Date.now();
    const reviewStartedAt = initialNow - 25 * 3600_000; // past the 24h default gate threshold
    const task = await store.create({
      threadId: 'thread-main',
      taskThreadId: 'thread-work',
      title: '隔离 Redis 分轨提醒回归 — gate',
      why: '防止重复提醒',
      createdBy: OWNER,
      userId: 'user-1',
      ownerCatId: OWNER,
      status: 'in_review',
      reviewerId: GATE_REVIEWER,
      events: [{ ts: new Date(reviewStartedAt).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: GATE_REVIEWER } }],
    });

    // Sanity: reviewerId itself must survive the Redis round-trip (RedisTaskStore.hydrateTask).
    const fetched = await store.get(task.id);
    assert.equal(fetched.reviewerId, GATE_REVIEWER, 'reviewerId 必须能从 Redis 读回，否则轨道判定会失真');

    const queue = createQueue();
    const messageStore = createMessageStore();
    let now = initialNow;
    const scheduler = new ReviewReminderScheduler({
      taskStore: store,
      messageStore,
      socketManager: { broadcastToRoom() {} },
      invocationQueue: queue,
      queueProcessor: { async tryAutoExecute() {} },
      now: () => now,
      env: {},
    });

    await scheduler.tick();
    assert.equal(queue.enqueued.length, 1, '首次扫描应提醒一次');
    const afterFirst = await store.get(task.id);
    assert.equal((afterFirst.events ?? []).filter((e) => e.type === 'review_reminder_sent').length, 1);

    now += 10 * 60_000; // 10 minutes later — well within the same scan cycle
    await scheduler.tick();
    assert.equal(queue.enqueued.length, 1, '第二次扫描不得重复提醒（这正是 C1 事故复现的形状）');
    const afterSecond = await store.get(task.id);
    assert.equal(
      (afterSecond.events ?? []).filter((e) => e.type === 'review_reminder_sent').length,
      1,
      '事件账本里也必须仍是恰好一条 review_reminder_sent',
    );
  });

  it('human 轨: 三级提醒记账在 Redis 上正确累加且互不重复，第三级正确落库为状态动作', async () => {
    const initialNow = Date.now();
    const reviewStartedAt = initialNow - 11 * 24 * 3600_000; // 11 days ago — past every threshold including default level-3 (10 days)
    const level1At = initialNow - 10 * 24 * 3600_000;
    const level2At = initialNow - 9 * 24 * 3600_000;
    const task = await store.create({
      threadId: 'thread-main',
      taskThreadId: 'thread-work',
      title: '隔离 Redis 分轨提醒回归 — human',
      why: '防止重复提醒/重复状态动作',
      createdBy: OWNER,
      userId: 'user-1',
      ownerCatId: OWNER,
      status: 'in_review',
      reviewerId: 'human',
      events: [
        { ts: new Date(reviewStartedAt).toISOString(), catId: 'system', type: 'review_requested', data: { reviewerId: 'human' } },
        { ts: new Date(level1At).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 1 } },
        { ts: new Date(level2At).toISOString(), catId: 'system', type: 'review_reminder_sent', data: { track: 'human', level: 2 } },
      ],
    });

    const messageStore = createMessageStore();
    let now = initialNow;
    const scheduler = new ReviewReminderScheduler({
      taskStore: store,
      messageStore,
      socketManager: { broadcastToRoom() {} },
      now: () => now,
      env: {},
    });

    await scheduler.tick();
    let updated = await store.get(task.id);
    assert.equal(updated.status, 'doing', '第三级状态动作应在 Redis 路径上真实生效——打回 doing');
    assert.equal(
      (updated.events ?? []).filter((e) => e.type === 'review_timeout_reverted').length,
      1,
      '应恰好一条 review_timeout_reverted',
    );
    assert.equal(
      (updated.events ?? []).filter((e) => e.type === 'review_reminder_sent').length,
      2,
      '既有的两条提醒事件应原样保留，不被状态动作覆盖',
    );

    now += 10 * 60_000;
    await scheduler.tick();
    updated = await store.get(task.id);
    assert.equal(updated.status, 'doing', '任务已不在 in_review，第二次扫描应彻底跳过');
    assert.equal(
      (updated.events ?? []).filter((e) => e.type === 'review_timeout_reverted').length,
      1,
      '不得二次打回/重复状态动作',
    );
    assert.equal(messageStore.messages.length, 1, '通知也只应出现一次');
  });
});
