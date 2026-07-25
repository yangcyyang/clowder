/**
 * 批次 3-H: GET/PUT /api/user-profile — Owner 直接编辑 `.cat-cafe/memory/USER.md`。
 * Distinct from UserProfilePromotionGate's candidate-queue path (see
 * user-profile-store.test.js) — this route is the authoritative Owner-edit
 * path and writes straight through, serialized via userProfileWriteQueue.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const OWNER_ID = 'test-owner-3h';

describe('GET/PUT /api/user-profile (batch 3-H)', () => {
  let app;
  let projectRoot;

  function memoryDir() {
    return join(projectRoot, '.cat-cafe', 'memory');
  }

  function userProfilePath() {
    return join(memoryDir(), 'USER.md');
  }

  async function seedUserProfile(content) {
    await mkdir(memoryDir(), { recursive: true });
    await writeFile(userProfilePath(), content, 'utf-8');
  }

  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'user-profile-route-'));
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
  });

  describe('GET', () => {
    it('returns empty sections + rawExists:false when USER.md is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/user-profile' });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.deepEqual(body.sections, { preferences: '', constraints: '', facts: '' });
      assert.equal(body.rawExists, false);
      assert.equal(body.tokenEstimate, 0);
    });

    it('reads the three sections from an existing USER.md verbatim', async () => {
      await seedUserProfile(
        [
          '# 铲屎官画像',
          '',
          '## 偏好',
          '- 全中文交流。',
          '- 简短汇报。',
          '',
          '## 硬约束',
          '- 生产 Redis 6399 不外连。',
          '',
          '## 账号级事实',
          '- 时区 Asia/Shanghai。',
          '',
        ].join('\n'),
      );
      const res = await app.inject({ method: 'GET', url: '/api/user-profile' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.rawExists, true);
      assert.equal(body.sections.preferences, '- 全中文交流。\n- 简短汇报。');
      assert.equal(body.sections.constraints, '- 生产 Redis 6399 不外连。');
      assert.equal(body.sections.facts, '- 时区 Asia/Shanghai。');
      assert.ok(body.tokenEstimate > 0);
    });
  });

  describe('PUT auth', () => {
    it('without identity header → 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        payload: { preferences: 'p', constraints: 'c', facts: 'f' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('by non-owner → 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': 'some-cat' },
        payload: { preferences: 'p', constraints: 'c', facts: 'f' },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('PUT by owner', () => {
    it('creates USER.md from the default template shape when absent', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload: { preferences: '- 喜欢简短。', constraints: '', facts: '- 邮箱 a@b.com' },
      });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload);
      assert.equal(body.sections.preferences, '- 喜欢简短。');
      assert.equal(body.sections.constraints, '');
      assert.equal(body.sections.facts, '- 邮箱 a@b.com');
      assert.equal(body.rawExists, true);

      const raw = await readFile(userProfilePath(), 'utf-8');
      assert.match(raw, /^# 铲屎官画像/);
      assert.match(raw, /## 偏好/);
      assert.match(raw, /## 硬约束/);
      assert.match(raw, /## 账号级事实/);
      assert.match(raw, /- 喜欢简短。/);
    });

    it('round-trips: PUT then GET reflects the exact new content, old content is replaced not merged', async () => {
      await seedUserProfile('# 铲屎官画像\n\n## 偏好\n- 旧偏好条目\n\n## 硬约束\n\n## 账号级事实\n');
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload: { preferences: '- 新偏好条目', constraints: '- 新硬约束', facts: '- 新事实' },
      });
      assert.equal(putRes.statusCode, 200);

      const getRes = await app.inject({ method: 'GET', url: '/api/user-profile' });
      const body = JSON.parse(getRes.payload);
      assert.equal(body.sections.preferences, '- 新偏好条目');
      assert.equal(body.sections.constraints, '- 新硬约束');
      assert.equal(body.sections.facts, '- 新事实');
      assert.ok(!body.sections.preferences.includes('旧偏好条目'), 'old content must not survive the overwrite');
    });

    it('preserves multi-line free-form text verbatim (no auto-dated bullet prefixing)', async () => {
      const payload = {
        preferences: '- 第一行偏好\n- 第二行偏好',
        constraints: '硬约束不带项目符号也要保留',
        facts: '- 事实 A\n- 事实 B\n- 事实 C',
      };
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.sections.preferences, payload.preferences);
      assert.equal(body.sections.constraints, payload.constraints);
      assert.equal(body.sections.facts, payload.facts);
      // No "[YYYY-MM-DD]" auto-dated bullet prefix — that formatting belongs
      // only to the cat-proposal promotion-gate path (appendUserProfileLine),
      // not the Owner direct-edit path.
      const raw = await readFile(userProfilePath(), 'utf-8');
      assert.ok(!/\[\d{4}-\d{2}-\d{2}\]/.test(raw), 'owner edits must not be auto-dated like promotion-gate writes');
    });
  });

  describe('length defense', () => {
    it('rejects a single section over the per-section cap with 400', async () => {
      const { USER_PROFILE_SECTION_MAX_CHARS } = await import(
        '../../dist/domains/cats/services/agents/memory/UserProfileStore.js'
      );
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload: {
          preferences: 'x'.repeat(USER_PROFILE_SECTION_MAX_CHARS + 1),
          constraints: '',
          facts: '',
        },
      });
      assert.equal(res.statusCode, 400, `expected 400 but got ${res.statusCode}: ${res.payload}`);
      // The bad write must never land on disk.
      assert.equal(
        await readFile(userProfilePath(), 'utf-8').catch(() => null),
        null,
      );
    });

    it('accepts all three sections right at the per-section cap and echoes tokenEstimate', async () => {
      const { USER_PROFILE_SECTION_MAX_CHARS } = await import(
        '../../dist/domains/cats/services/agents/memory/UserProfileStore.js'
      );
      const body = 'x'.repeat(USER_PROFILE_SECTION_MAX_CHARS);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/user-profile',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload: { preferences: body, constraints: body, facts: body },
      });
      assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      const parsed = JSON.parse(res.payload);
      assert.ok(parsed.tokenEstimate > 0);
    });
  });

  describe('concurrency (single-writer queue)', () => {
    it('concurrent PUTs never interleave — final file is exactly one full payload, not a corrupted mix', async () => {
      const attempts = [0, 1, 2, 3, 4].map((i) => ({
        preferences: `偏好-${i}`,
        constraints: `硬约束-${i}`,
        facts: `事实-${i}`,
      }));

      const responses = await Promise.all(
        attempts.map((payload) =>
          app.inject({
            method: 'PUT',
            url: '/api/user-profile',
            headers: { 'x-cat-cafe-user': OWNER_ID },
            payload,
          }),
        ),
      );
      for (const res of responses) {
        assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
      }

      const raw = await readFile(userProfilePath(), 'utf-8');
      const winner = attempts.find(
        (payload) =>
          raw.includes(payload.preferences) && raw.includes(payload.constraints) && raw.includes(payload.facts),
      );
      assert.ok(winner, `final file must match exactly one full attempt, got:\n${raw}`);
      // No cross-contamination: exactly one attempt's markers should be present.
      const matchingCount = attempts.filter((payload) => raw.includes(payload.preferences)).length;
      assert.equal(matchingCount, 1, 'exactly one attempt should have won the race, not an interleaved mix');
    });
  });
});
