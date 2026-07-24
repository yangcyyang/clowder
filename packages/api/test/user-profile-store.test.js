/**
 * 批次 2-D 任务二: 用户画像层 —— UserProfileStore (read/write) +
 * UserProfilePromotionGate (designated enforce tier) + UserProfileWriteQueue
 * (single-writer concurrency).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const STORE_MODULE = '../dist/domains/cats/services/agents/memory/UserProfileStore.js';
const GATE_MODULE = '../dist/domains/cats/services/agents/memory/UserProfilePromotionGate.js';
const QUEUE_MODULE = '../dist/domains/cats/services/agents/memory/UserProfileWriteQueue.js';

let tempRoot;

function memoryDir() {
  return join(tempRoot, '.cat-cafe', 'memory');
}

function userProfilePath() {
  return join(memoryDir(), 'USER.md');
}

async function seedUserProfile(content) {
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(userProfilePath(), content, 'utf-8');
}

function baseProposal(extra = {}) {
  return {
    proposedByCatId: 'opus',
    invocationId: 'inv-user-1',
    threadId: 'thread-user-1',
    now: () => 1_800_000_000_000,
    ...extra,
  };
}

describe('UserProfileStore', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-user-profile-'));
    const gate = await import(GATE_MODULE);
    gate.resetUserProfilePromotionGateForTests();
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  describe('read', () => {
    it('returns exists:false + empty content when USER.md is absent', async () => {
      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.equal(record.exists, false);
      assert.equal(record.content, '');
      assert.equal(record.truncated, false);
    });

    it('readUserProfileForPrompt returns null for empty/whitespace-only content', async () => {
      await seedUserProfile('   \n\n  ');
      const { readUserProfileForPrompt } = await import(STORE_MODULE);
      assert.equal(await readUserProfileForPrompt(tempRoot), null);
    });

    it('reads the three-section template content verbatim', async () => {
      const content = '# 铲屎官画像\n\n## 偏好\n- 中文白话\n\n## 硬约束\n- 生产 Redis 6399 不外连\n\n## 账号级事实\n- 邮箱 928590029cy@gmail.com\n';
      await seedUserProfile(content);
      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.equal(record.exists, true);
      assert.equal(record.content, content);
    });

    it('truncates content over the storage cap with a marker', async () => {
      const { USER_PROFILE_MAX_CHARS } = await import(STORE_MODULE);
      const huge = `# 铲屎官画像\n\n## 偏好\n${'x'.repeat(USER_PROFILE_MAX_CHARS + 500)}\n`;
      await seedUserProfile(huge);
      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.equal(record.truncated, true);
      assert.ok(record.content.includes('已截断'));
      assert.ok(record.content.length < huge.length);
    });
  });

  describe('classifyUserProfileSection heuristic', () => {
    it('routes hard-constraint language to 硬约束', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('硬约束：生产 Redis 端口禁止外连'), '硬约束');
      assert.equal(classifyUserProfileSection('必须先跑测试再提交'), '硬约束');
    });

    it('routes preference language to 偏好', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('回复风格偏好简短'), '偏好');
    });

    it('falls back to 账号级事实 for plain facts', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('邮箱是 928590029cy@gmail.com'), '账号级事实');
    });
  });

  describe('enforce-tier write gate (proposeUserProfileWrite)', () => {
    it('non-fast-track write is HELD in the shared candidate queue, USER.md untouched', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidates } = await import(GATE_MODULE);
      const result = await proposeUserProfileWrite(
        baseProposal({ candidateText: '完成了发票模块 Phase 3，测试全部通过。', userMessageText: '帮我完成发票模块 Phase 3' }),
        tempRoot,
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'pending_review');
      assert.equal(result.evaluation.action, 'candidate');

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.equal(record.exists, false, 'USER.md must stay untouched until human review');

      const candidates = await listUserProfileCandidates(tempRoot);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'pending_review');
      assert.equal(candidates[0].catId, 'USER');
      assert.match(candidates[0].content, /发票模块 Phase 3/);
    });

    it('conflicting write is HELD (hold), old USER.md content keeps serving', async () => {
      await seedUserProfile('# 铲屎官画像\n\n## 偏好\n- 主消息要简短。\n\n## 硬约束\n\n## 账号级事实\n');
      const { proposeUserProfileWrite } = await import(GATE_MODULE);
      const result = await proposeUserProfileWrite(
        baseProposal({ candidateText: '用户要求长报告，以后都输出长报告。' }),
        tempRoot,
      );
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'conflict_hold');
      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.match(record.content, /主消息要简短/);
      assert.ok(!record.content.includes('长报告'));
    });

    it('explicit user "记住：" fast-tracks straight to durable USER.md', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidates } = await import(GATE_MODULE);
      const result = await proposeUserProfileWrite(
        baseProposal({
          candidateText: '硬约束：生产 Redis 端口 6399 禁止外部项目连接。',
          userMessageText: '记住：生产 Redis 端口 6399 禁止外部项目连接。',
        }),
        tempRoot,
      );
      assert.equal(result.status, 'updated');
      assert.equal(result.evaluation.action, 'promote');
      assert.equal(result.evaluation.reviewer, 'user');
      assert.equal(result.section, '硬约束');

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.match(record.content, /生产 Redis 端口 6399 禁止外部项目连接/);
      assert.ok(record.content.indexOf('## 硬约束') < record.content.indexOf('生产 Redis 端口 6399'));

      const candidates = await listUserProfileCandidates(tempRoot);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'promoted');
      assert.equal(candidates[0].reviewer, 'user');
    });

    it('pure session-temp content is skipped, never durable, never queued', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidates } = await import(GATE_MODULE);
      const result = await proposeUserProfileWrite(
        baseProposal({ candidateText: '本次会话临时变量 foo=bar，仅暂存用于本轮计算。' }),
        tempRoot,
      );
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'session_temp');
      assert.deepEqual(await listUserProfileCandidates(tempRoot), []);
    });

    it('is always enforce-tier regardless of CAT_CAFE_MEMORY_PROMOTION_MODE=off', async () => {
      const saved = process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
      process.env.CAT_CAFE_MEMORY_PROMOTION_MODE = 'off';
      try {
        const { proposeUserProfileWrite } = await import(GATE_MODULE);
        const result = await proposeUserProfileWrite(
          baseProposal({ candidateText: '完成了一个未经用户指令确认的观察。' }),
          tempRoot,
        );
        // Even with the global per-cat gate fully OFF, USER.md writes still queue
        // for review — never legacy auto-write-through.
        assert.notEqual(result.status, 'updated');
        const { readUserProfile } = await import(STORE_MODULE);
        assert.equal((await readUserProfile(tempRoot)).exists, false);
      } finally {
        if (saved === undefined) delete process.env.CAT_CAFE_MEMORY_PROMOTION_MODE;
        else process.env.CAT_CAFE_MEMORY_PROMOTION_MODE = saved;
      }
    });
  });

  describe('concurrency (single-writer queue)', () => {
    it('UserProfileWriteQueue serializes interleaved async operations (FIFO, no lost updates)', async () => {
      const { UserProfileWriteQueue } = await import(QUEUE_MODULE);
      const queue = new UserProfileWriteQueue();
      const order = [];
      let counter = 0;

      const jobs = [0, 1, 2, 3, 4].map((i) =>
        queue.enqueue(async () => {
          // Deliberately vary delay so a naive (non-serialized) implementation
          // would interleave and produce an out-of-order `order` array.
          await new Promise((resolve) => setTimeout(resolve, i % 2 === 0 ? 5 : 0));
          order.push(i);
          counter += 1;
          return counter;
        }),
      );

      const results = await Promise.all(jobs);
      assert.deepEqual(order, [0, 1, 2, 3, 4], 'jobs must execute strictly FIFO, not interleaved');
      assert.deepEqual(results, [1, 2, 3, 4, 5], 'each job sees the fully-updated counter from all prior jobs');
    });

    it('concurrent proposeUserProfileWrite fast-track calls never lose an update', async () => {
      const { proposeUserProfileWrite } = await import(GATE_MODULE);
      const contents = [0, 1, 2, 3, 4].map((i) => `账号级事实：测试并发写入条目 #${i}。`);

      const results = await Promise.all(
        contents.map((candidateText, i) =>
          proposeUserProfileWrite(
            baseProposal({
              candidateText,
              userMessageText: `记住：${candidateText}`,
              invocationId: `inv-concurrent-${i}`,
              now: () => 1_800_000_000_000 + i,
            }),
            tempRoot,
          ),
        ),
      );

      for (const result of results) {
        assert.equal(result.status, 'updated', JSON.stringify(result));
      }

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      for (const candidateText of contents) {
        assert.ok(record.content.includes(candidateText), `missing concurrent write: ${candidateText}`);
      }
    });
  });
});
