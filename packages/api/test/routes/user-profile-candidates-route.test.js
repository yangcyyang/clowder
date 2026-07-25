/**
 * 批次 3 F-E: GET/POST /api/user-profile/candidates(/:id/approve|/reject) —
 * 画像人审 UI 的后端闭环。Owner 鉴权同 PUT /api/user-profile（see
 * user-profile-route.test.js）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const OWNER_ID = 'test-owner-3fe-candidates';

describe('GET/POST /api/user-profile/candidates (batch 3 F-E)', () => {
  let app;
  let projectRoot;
  let gate;

  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'user-profile-candidates-route-'));
    gate = await import('../../dist/domains/cats/services/agents/memory/UserProfilePromotionGate.js');
    const { userProfileRoutes } = await import('../../dist/routes/user-profile.js');
    app = Fastify();
    await app.register(userProfileRoutes, { projectRoot });
    await app.ready();
  });

  after(async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true, force: true });
    gate.resetUserProfilePromotionGateForTests();
  });

  async function seedPendingCandidate(candidateText, extra = {}) {
    const result = await gate.proposeUserProfileWrite(
      {
        candidateText,
        proposedByCatId: 'kimi',
        invocationId: 'inv-route-test',
        threadId: 'thread-route-test',
        ...extra,
      },
      projectRoot,
    );
    assert.equal(result.status, 'held', `expected the seed candidate to be held, got ${JSON.stringify(result)}`);
    const pending = await gate.listUserProfileCandidatesForReview(projectRoot);
    return pending.find((c) => c.content === candidateText);
  }

  describe('GET /api/user-profile/candidates auth', () => {
    it('without identity header -> 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/user-profile/candidates' });
      assert.equal(res.statusCode, 400);
    });

    it('by non-owner -> 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': 'some-cat' },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('GET /api/user-profile/candidates by owner', () => {
    it('empty queue -> candidates:[], pendingCount:0', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.deepEqual(body.candidates, []);
      assert.equal(body.pendingCount, 0);
    });

    it('lists a pending candidate with content/来源猫/action/时间', async () => {
      await seedPendingCandidate('完成了发票模块 Phase 3，测试全部通过。');

      const res = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.pendingCount, 1);
      assert.equal(body.candidates.length, 1);
      const [candidate] = body.candidates;
      assert.match(candidate.content, /发票模块 Phase 3/);
      assert.equal(candidate.sourceCatId, 'kimi');
      assert.ok(candidate.action);
      assert.ok(typeof candidate.createdAt === 'number');
      assert.ok('id' in candidate);
    });

    it('does not list an already fast-tracked (promoted) write', async () => {
      await gate.proposeUserProfileWrite(
        {
          candidateText: '硬约束：生产 Redis 端口 6399 禁止外部项目连接。',
          userMessageText: '记住：生产 Redis 端口 6399 禁止外部项目连接。',
          proposedByCatId: 'opus',
          invocationId: 'inv-fasttrack',
          threadId: 'thread-fasttrack',
        },
        projectRoot,
      );
      const res = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      const body = JSON.parse(res.payload);
      assert.equal(body.pendingCount, 0);
    });
  });

  describe('POST /api/user-profile/candidates/:id/approve', () => {
    it('auth: without identity -> 400; by non-owner -> 403', async () => {
      const noAuth = await app.inject({ method: 'POST', url: '/api/user-profile/candidates/whatever/approve' });
      assert.equal(noAuth.statusCode, 400);
      const nonOwner = await app.inject({
        method: 'POST',
        url: '/api/user-profile/candidates/whatever/approve',
        headers: { 'x-cat-cafe-user': 'some-cat' },
      });
      assert.equal(nonOwner.statusCode, 403);
    });

    it('approves a pending candidate: writes USER.md and drops it from the pending list', async () => {
      const candidate = await seedPendingCandidate('硬约束：只用 pnpm，不允许 npm install。');

      const res = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/approve`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.status, 'approved');
      assert.equal(body.section, '硬约束');

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/user-profile',
      });
      const profileBody = JSON.parse(getRes.payload);
      assert.match(profileBody.sections.constraints, /只用 pnpm/);

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(JSON.parse(listRes.payload).pendingCount, 0);
    });

    it('unknown id -> 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/user-profile/candidates/does-not-exist/approve',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 404);
    });

    it('approving an already-decided candidate -> 409', async () => {
      const candidate = await seedPendingCandidate('账号级事实：常用时区 Asia/Shanghai。');
      const first = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/approve`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(first.statusCode, 200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/approve`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(second.statusCode, 409);
      const body = JSON.parse(second.payload);
      assert.equal(body.decision, 'approved');
    });
  });

  describe('POST /api/user-profile/candidates/:id/reject', () => {
    it('auth: without identity -> 400; by non-owner -> 403', async () => {
      const noAuth = await app.inject({ method: 'POST', url: '/api/user-profile/candidates/whatever/reject' });
      assert.equal(noAuth.statusCode, 400);
      const nonOwner = await app.inject({
        method: 'POST',
        url: '/api/user-profile/candidates/whatever/reject',
        headers: { 'x-cat-cafe-user': 'some-cat' },
      });
      assert.equal(nonOwner.statusCode, 403);
    });

    it('rejects a pending candidate: marks it decided, never touches USER.md, keeps the audit line (not physically deleted)', async () => {
      const candidate = await seedPendingCandidate('用户要求所有回复都用英文。');

      const res = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/reject`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      assert.equal(JSON.parse(res.payload).status, 'rejected');

      const getRes = await app.inject({ method: 'GET', url: '/api/user-profile' });
      const profileBody = JSON.parse(getRes.payload);
      assert.equal(profileBody.rawExists, false, 'reject must never create USER.md');

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(JSON.parse(listRes.payload).pendingCount, 0, 'rejected candidate must drop out of the pending list');

      // Audit trail preserved on disk — both the original candidate line and
      // the reject decision line are still present in the ledger file.
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(projectRoot, '.cat-cafe', 'memory', 'candidates', 'USER.jsonl'), 'utf-8');
      const lines = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.id === candidate.id);
      assert.equal(lines.length, 2, 'reject must append a decision line, never delete the original');
      assert.equal(lines[0].status, 'pending_review');
      assert.equal(lines[1].status, 'rejected');
    });

    it('unknown id -> 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/user-profile/candidates/does-not-exist/reject',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(res.statusCode, 404);
    });

    it('rejecting an already-decided candidate -> 409', async () => {
      const candidate = await seedPendingCandidate('偏好：喜欢先看结论再看细节。');
      const first = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/reject`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(first.statusCode, 200);

      const second = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidate.id}/reject`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(second.statusCode, 409);
    });
  });

  describe('end-to-end human-review demo path', () => {
    it('propose -> pending in GET list -> approve via POST -> content lands in USER.md', async () => {
      await seedPendingCandidate('账号级事实：常用编辑器是 vim。');

      const before = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      const beforeBody = JSON.parse(before.payload);
      assert.equal(beforeBody.pendingCount, 1);
      const candidateId = beforeBody.candidates[0].id;

      const approve = await app.inject({
        method: 'POST',
        url: `/api/user-profile/candidates/${candidateId}/approve`,
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(approve.statusCode, 200);

      const profile = await app.inject({ method: 'GET', url: '/api/user-profile' });
      const profileBody = JSON.parse(profile.payload);
      assert.match(profileBody.sections.facts, /常用编辑器是 vim/);

      const after = await app.inject({
        method: 'GET',
        url: '/api/user-profile/candidates',
        headers: { 'x-cat-cafe-user': OWNER_ID },
      });
      assert.equal(JSON.parse(after.payload).pendingCount, 0);
    });
  });
});
