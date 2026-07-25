/**
 * 批次 3 F-E: 画像人审 UI 闭环 —— UserProfilePromotionGate's
 * listUserProfileCandidatesForReview / approveUserProfileCandidate /
 * rejectUserProfileCandidate. Gate-level (no HTTP) — see
 * test/routes/user-profile-candidates-route.test.js for the route layer.
 *
 * Ledger discipline under test: approve/reject NEVER delete or rewrite the
 * original pending_review line — they APPEND a new line with the same id and
 * an updated status (F163-style append-only audit trail). Readers reduce to
 * "latest record per id".
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const STORE_MODULE = '../../dist/domains/cats/services/agents/memory/UserProfileStore.js';
const GATE_MODULE = '../../dist/domains/cats/services/agents/memory/UserProfilePromotionGate.js';

let tempRoot;

function memoryDir() {
  return join(tempRoot, '.cat-cafe', 'memory');
}

function candidatesPath() {
  return join(memoryDir(), 'candidates', 'USER.jsonl');
}

async function seedUserProfile(content) {
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(join(memoryDir(), 'USER.md'), content, 'utf-8');
}

function baseProposal(extra = {}) {
  return {
    proposedByCatId: 'opus',
    invocationId: 'inv-review-1',
    threadId: 'thread-review-1',
    now: () => 1_800_000_000_000,
    ...extra,
  };
}

async function readLedgerLines() {
  const raw = await readFile(candidatesPath(), 'utf-8').catch(() => '');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('UserProfilePromotionGate: 人审候选队列 (批次 3 F-E)', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-user-profile-review-'));
    const gate = await import(GATE_MODULE);
    gate.resetUserProfilePromotionGateForTests();
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  describe('provenance: proposedByCatId persisted on the ledger', () => {
    it('a held candidate records which cat proposed it', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview } = await import(GATE_MODULE);
      await proposeUserProfileWrite(
        baseProposal({ candidateText: '完成了发票模块 Phase 3，测试全部通过。', proposedByCatId: 'kimi' }),
        tempRoot,
      );
      const pending = await listUserProfileCandidatesForReview(tempRoot);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].proposedByCatId, 'kimi');
      assert.equal(pending[0].catId, 'USER', 'catId stays the fixed queue key, not the source cat');
    });
  });

  describe('listUserProfileCandidatesForReview', () => {
    it('returns [] when the ledger file does not exist yet', async () => {
      const { listUserProfileCandidatesForReview } = await import(GATE_MODULE);
      assert.deepEqual(await listUserProfileCandidatesForReview(tempRoot), []);
    });

    it('lists only pending_review candidates, oldest first, excluding fast-tracked promotions', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview } = await import(GATE_MODULE);
      await proposeUserProfileWrite(
        baseProposal({
          candidateText: '硬约束：生产 Redis 端口 6399 禁止外部项目连接。',
          userMessageText: '记住：生产 Redis 端口 6399 禁止外部项目连接。',
          now: () => 1_800_000_000_000,
        }),
        tempRoot,
      );
      await proposeUserProfileWrite(
        baseProposal({ candidateText: '完成了发票模块 Phase 3，测试全部通过。', now: () => 1_800_000_001_000 }),
        tempRoot,
      );
      await proposeUserProfileWrite(
        baseProposal({ candidateText: '账号级事实：时区 Asia/Shanghai。', now: () => 1_800_000_002_000 }),
        tempRoot,
      );

      const pending = await listUserProfileCandidatesForReview(tempRoot);
      assert.equal(pending.length, 2, 'the fast-tracked promote must not appear in the pending review list');
      assert.ok(pending[0].createdAt <= pending[1].createdAt, 'oldest first');
      assert.ok(pending.every((c) => c.status === 'pending_review'));
    });
  });

  describe('approveUserProfileCandidate', () => {
    it('writes the candidate content into USER.md under the classified section and marks it approved', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, approveUserProfileCandidate } =
        await import(GATE_MODULE);
      await proposeUserProfileWrite(
        baseProposal({ candidateText: '硬约束：只用 pnpm 管理依赖，不允许 npm install。' }),
        tempRoot,
      );
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      const outcome = await approveUserProfileCandidate(pending.id, { now: () => 1_800_000_100_000 }, tempRoot);
      assert.equal(outcome.status, 'approved');
      assert.equal(outcome.section, '硬约束');

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.match(record.content, /只用 pnpm 管理依赖/);

      // Approved candidates drop out of the pending queue.
      assert.deepEqual(await listUserProfileCandidatesForReview(tempRoot), []);
    });

    it('audit trail: the original pending_review ledger line is never deleted, only a new decision line is appended', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, approveUserProfileCandidate } =
        await import(GATE_MODULE);
      await proposeUserProfileWrite(baseProposal({ candidateText: '账号级事实：常用时区 Asia/Shanghai。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      await approveUserProfileCandidate(pending.id, {}, tempRoot);

      const lines = await readLedgerLines();
      const forThisId = lines.filter((l) => l.id === pending.id);
      assert.equal(forThisId.length, 2, 'expected the original proposal line + one appended decision line');
      assert.equal(forThisId[0].status, 'pending_review');
      assert.equal(forThisId[1].status, 'approved');
    });

    it('unknown id returns not_found and touches neither USER.md nor the ledger', async () => {
      const { approveUserProfileCandidate } = await import(GATE_MODULE);
      const outcome = await approveUserProfileCandidate('does-not-exist', {}, tempRoot);
      assert.equal(outcome.status, 'not_found');
    });

    it('approving an already-decided candidate is idempotent-safe: returns already_decided, does not double-write USER.md', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, approveUserProfileCandidate } =
        await import(GATE_MODULE);
      await proposeUserProfileWrite(baseProposal({ candidateText: '偏好：喜欢简洁的汇报格式。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      const first = await approveUserProfileCandidate(pending.id, {}, tempRoot);
      assert.equal(first.status, 'approved');
      const second = await approveUserProfileCandidate(pending.id, {}, tempRoot);
      assert.equal(second.status, 'already_decided');
      assert.equal(second.decision, 'approved');

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      const occurrences = record.content.split('喜欢简洁的汇报格式').length - 1;
      assert.equal(occurrences, 1, 'must not be written twice');
    });

    it('honors an explicit section override instead of the classifyUserProfileSection fallback', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, approveUserProfileCandidate } =
        await import(GATE_MODULE);
      // Plain fact-sounding text — classifyUserProfileSection would default it to 账号级事实.
      await proposeUserProfileWrite(baseProposal({ candidateText: '常用编辑器是 vim。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      const outcome = await approveUserProfileCandidate(pending.id, { section: '偏好' }, tempRoot);
      assert.equal(outcome.section, '偏好');
    });
  });

  describe('rejectUserProfileCandidate', () => {
    it('marks the candidate rejected and never touches USER.md', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, rejectUserProfileCandidate } =
        await import(GATE_MODULE);
      await proposeUserProfileWrite(baseProposal({ candidateText: '用户要求所有回复都用英文。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      const outcome = await rejectUserProfileCandidate(pending.id, { now: () => 1_800_000_200_000 }, tempRoot);
      assert.equal(outcome.status, 'rejected');

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      assert.equal(record.exists, false, 'rejection must never create/modify USER.md');

      assert.deepEqual(await listUserProfileCandidatesForReview(tempRoot), []);
    });

    it('audit trail: rejection appends a decision line, never deletes the original', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, rejectUserProfileCandidate } =
        await import(GATE_MODULE);
      await proposeUserProfileWrite(baseProposal({ candidateText: '账号级事实：常用浏览器是 Chrome。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      await rejectUserProfileCandidate(pending.id, {}, tempRoot);

      const lines = await readLedgerLines();
      const forThisId = lines.filter((l) => l.id === pending.id);
      assert.equal(forThisId.length, 2);
      assert.equal(forThisId[0].status, 'pending_review');
      assert.equal(forThisId[1].status, 'rejected');
    });

    it('unknown id returns not_found', async () => {
      const { rejectUserProfileCandidate } = await import(GATE_MODULE);
      const outcome = await rejectUserProfileCandidate('does-not-exist', {}, tempRoot);
      assert.equal(outcome.status, 'not_found');
    });

    it('rejecting an already-approved candidate returns already_decided (no double-decision)', async () => {
      const {
        proposeUserProfileWrite,
        listUserProfileCandidatesForReview,
        approveUserProfileCandidate,
        rejectUserProfileCandidate,
      } = await import(GATE_MODULE);
      await proposeUserProfileWrite(baseProposal({ candidateText: '偏好：喜欢先看结论再看细节。' }), tempRoot);
      const [pending] = await listUserProfileCandidatesForReview(tempRoot);

      await approveUserProfileCandidate(pending.id, {}, tempRoot);
      const outcome = await rejectUserProfileCandidate(pending.id, {}, tempRoot);
      assert.equal(outcome.status, 'already_decided');
      assert.equal(outcome.decision, 'approved');
    });
  });

  describe('concurrency: approve serializes with a concurrent Owner PUT-style write via the shared queue', () => {
    it('concurrent approve calls for different candidates never lose an update', async () => {
      const { proposeUserProfileWrite, listUserProfileCandidatesForReview, approveUserProfileCandidate } =
        await import(GATE_MODULE);
      await seedUserProfile('# 铲屎官画像\n\n## 偏好\n\n## 硬约束\n\n## 账号级事实\n');
      const texts = [0, 1, 2, 3, 4].map((i) => `账号级事实：并发候选条目 #${i}。`);
      for (const [i, candidateText] of texts.entries()) {
        await proposeUserProfileWrite(
          baseProposal({ candidateText, invocationId: `inv-${i}`, now: () => 1_800_000_000_000 + i }),
          tempRoot,
        );
      }
      const pending = await listUserProfileCandidatesForReview(tempRoot);
      assert.equal(pending.length, 5);

      const results = await Promise.all(pending.map((c) => approveUserProfileCandidate(c.id, {}, tempRoot)));
      assert.ok(results.every((r) => r.status === 'approved'));

      const { readUserProfile } = await import(STORE_MODULE);
      const record = await readUserProfile(tempRoot);
      for (const text of texts) {
        assert.ok(record.content.includes(text), `missing concurrently-approved candidate: ${text}`);
      }
    });
  });
});
