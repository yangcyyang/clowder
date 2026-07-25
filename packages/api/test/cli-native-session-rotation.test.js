/**
 * F-G (PRD-memory-upgrade 批次 3): CLI 原生 session 撑爆治理 — 轮转判定单元测试。
 *
 * 覆盖 docs/prd/PRD-memory-upgrade.md F-G 验收要求的核心用例：
 *  - env 关（CLOWDER_CLI_SESSION_MAX_MB 未设置/0）→ 零动作，不做任何 fs 访问
 *  - 超限 + 白名单命中 → 轮转（真实临时目录模拟 GROK_HOME，不 mock fs 模块本身）
 *  - 超限但不在白名单 → 不动
 *  - 归档只改名，绝不删除（rename 后原路径不存在，新路径内容完整保留）
 *  - clientId 不支持（本轮只做 grok）→ 安全短路 path_unresolved，不报错
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const {
  loadCliSessionRotationPolicy,
  isCliSessionRotationEnabledFor,
  resolveNativeSessionPath,
  computeNativeSessionSizeBytes,
  archiveNativeSessionPath,
  maybeRotateCliNativeSession,
} = await import('../dist/domains/cats/services/agents/invocation/cli-native-session-rotation.js');

let tempDir;

async function makeGrokSession({ grokHome, workingDirectory, sessionId, fileSizeBytes }) {
  const sessionDir = join(grokHome, 'sessions', encodeURIComponent(workingDirectory), sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'updates.jsonl'), Buffer.alloc(fileSizeBytes, 'x'));
  return sessionDir;
}

describe('F-G CLI native session rotation', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-session-rotation-'));
  });

  after(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('policy parsing (pure)', () => {
    test('CLOWDER_CLI_SESSION_MAX_MB unset/0 → thresholdBytes 0 (disabled)', () => {
      assert.equal(loadCliSessionRotationPolicy({}).thresholdBytes, 0);
      assert.equal(loadCliSessionRotationPolicy({ CLOWDER_CLI_SESSION_MAX_MB: '0' }).thresholdBytes, 0);
      assert.equal(loadCliSessionRotationPolicy({ CLOWDER_CLI_SESSION_MAX_MB: 'not-a-number' }).thresholdBytes, 0);
      assert.equal(loadCliSessionRotationPolicy({ CLOWDER_CLI_SESSION_MAX_MB: '-5' }).thresholdBytes, 0);
    });

    test('CLOWDER_CLI_SESSION_MAX_MB=8 → thresholdBytes = 8 MiB', () => {
      const policy = loadCliSessionRotationPolicy({ CLOWDER_CLI_SESSION_MAX_MB: '8' });
      assert.equal(policy.thresholdBytes, 8 * 1024 * 1024);
    });

    test('CLOWDER_CLI_SESSION_ROTATE_CATS parses comma-separated catId whitelist', () => {
      const policy = loadCliSessionRotationPolicy({ CLOWDER_CLI_SESSION_ROTATE_CATS: ' grok, kimi ,,grok' });
      assert.deepEqual([...policy.cats].sort(), ['grok', 'kimi']);
    });

    test('isCliSessionRotationEnabledFor: needs BOTH positive threshold AND catId in whitelist', () => {
      const off = { thresholdBytes: 0, cats: new Set(['grok']) };
      assert.equal(isCliSessionRotationEnabledFor(off, 'grok'), false, 'threshold=0 always disabled regardless of whitelist');

      const noWhitelist = { thresholdBytes: 8 * 1024 * 1024, cats: new Set() };
      assert.equal(isCliSessionRotationEnabledFor(noWhitelist, 'grok'), false, 'empty whitelist = nobody opted in');

      const notListed = { thresholdBytes: 8 * 1024 * 1024, cats: new Set(['kimi']) };
      assert.equal(isCliSessionRotationEnabledFor(notListed, 'grok'), false);

      const enabled = { thresholdBytes: 8 * 1024 * 1024, cats: new Set(['grok']) };
      assert.equal(isCliSessionRotationEnabledFor(enabled, 'grok'), true);
    });
  });

  describe('resolveNativeSessionPath (pure)', () => {
    test('grok: builds <GROK_HOME>/sessions/<encodeURIComponent(cwd)>/<sessionId>', () => {
      const cwd = '/Users/cy/.slock/worktrees/clowder-ai-slock-like-webui/packages/api';
      const path = resolveNativeSessionPath({
        clientId: 'grok',
        sessionId: '019f5b79-f9a5-76f2-90ea-5d6f1e520dd9',
        workingDirectory: cwd,
        env: { GROK_HOME: '/tmp/fake-grok-home' },
      });
      assert.equal(
        path,
        '/tmp/fake-grok-home/sessions/%2FUsers%2Fcy%2F.slock%2Fworktrees%2Fclowder-ai-slock-like-webui%2Fpackages%2Fapi/019f5b79-f9a5-76f2-90ea-5d6f1e520dd9',
      );
    });

    test('grok: falls back to ~/.grok when GROK_HOME unset', () => {
      const path = resolveNativeSessionPath({
        clientId: 'grok',
        sessionId: 'sess-1',
        workingDirectory: '/tmp/proj',
        env: {},
      });
      assert.ok(path.endsWith('/.grok/sessions/%2Ftmp%2Fproj/sess-1'));
    });

    test('grok: undefined workingDirectory → path_unresolved (cannot bucket by cwd)', () => {
      assert.equal(
        resolveNativeSessionPath({ clientId: 'grok', sessionId: 'sess-1', workingDirectory: undefined, env: {} }),
        undefined,
      );
    });

    test('unsupported clientId (e.g. anthropic/kimi/gemini) → undefined, never throws', () => {
      for (const clientId of ['anthropic', 'kimi', 'gemini', 'openai', undefined]) {
        assert.equal(
          resolveNativeSessionPath({ clientId, sessionId: 'sess-1', workingDirectory: '/tmp/proj', env: {} }),
          undefined,
          `clientId=${clientId} must resolve to undefined this round`,
        );
      }
    });
  });

  describe('computeNativeSessionSizeBytes + archiveNativeSessionPath (real tmp fs, no mocking)', () => {
    test('sums file sizes recursively; tolerates missing path (returns 0)', async () => {
      const dir = join(tempDir, 'session-a');
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(join(dir, 'a.jsonl'), Buffer.alloc(1000));
      await writeFile(join(dir, 'nested', 'b.jsonl'), Buffer.alloc(2000));
      assert.equal(await computeNativeSessionSizeBytes(dir), 3000);
      assert.equal(await computeNativeSessionSizeBytes(join(tempDir, 'does-not-exist')), 0);
    });

    test('archive: renames with .rotated-<date> suffix, never deletes, content byte-identical', async () => {
      const dir = join(tempDir, 'session-b');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'chat_history.jsonl'), 'hello-world');

      const archived = await archiveNativeSessionPath(dir, Date.parse('2026-07-25T00:00:00Z'));

      assert.equal(archived, `${dir}.rotated-2026-07-25`);
      assert.equal(existsSync(dir), false, 'old path must no longer exist AT ITS OLD NAME');
      assert.equal(existsSync(archived), true, 'archived path must exist (renamed, not deleted)');
      const content = await readFile(join(archived, 'chat_history.jsonl'), 'utf-8');
      assert.equal(content, 'hello-world', 'content must be preserved byte-for-byte');
    });

    test('archive: same-day collision increments -N suffix instead of overwriting', async () => {
      const dir1 = join(tempDir, 'session-c');
      await mkdir(dir1, { recursive: true });
      await writeFile(join(dir1, 'f.jsonl'), 'first');
      const now = Date.parse('2026-07-25T00:00:00Z');
      const archived1 = await archiveNativeSessionPath(dir1, now);
      assert.equal(archived1, `${dir1}.rotated-2026-07-25`);

      // Simulate a second session directory that would archive to the same name.
      const dir2 = join(tempDir, 'session-c'); // recreate at the same original path
      await mkdir(dir2, { recursive: true });
      await writeFile(join(dir2, 'f.jsonl'), 'second');
      const archived2 = await archiveNativeSessionPath(dir2, now);

      assert.equal(archived2, `${dir1}.rotated-2026-07-25-2`, 'collision must bump counter, not clobber the first archive');
      assert.equal(existsSync(archived1), true, 'first archive must survive untouched');
      assert.equal(await readFile(join(archived1, 'f.jsonl'), 'utf-8'), 'first');
      assert.equal(await readFile(join(archived2, 'f.jsonl'), 'utf-8'), 'second');
    });
  });

  describe('maybeRotateCliNativeSession (orchestration, real tmp fs)', () => {
    const workingDirectory = '/tmp/clowder-fake-project';
    const sessionId = 'sess-under-test';

    test('HARD CONSTRAINT: threshold=0 (default/unset) → disabled, zero fs access even with a huge session on disk', async () => {
      const grokHome = join(tempDir, 'grok-home-1');
      const sessionDir = await makeGrokSession({ grokHome, workingDirectory, sessionId, fileSizeBytes: 20 * 1024 * 1024 });

      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId,
        workingDirectory,
        env: { GROK_HOME: grokHome, CLOWDER_CLI_SESSION_ROTATE_CATS: 'grok' }, // no MAX_MB set
      });

      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'disabled');
      assert.equal(existsSync(sessionDir), true, 'session dir must be untouched when the gate is off');
    });

    test('over threshold + catId not on whitelist → not_whitelisted, no rotation', async () => {
      const grokHome = join(tempDir, 'grok-home-2');
      const sessionDir = await makeGrokSession({ grokHome, workingDirectory, sessionId, fileSizeBytes: 2 * 1024 * 1024 });

      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId,
        workingDirectory,
        env: { GROK_HOME: grokHome, CLOWDER_CLI_SESSION_MAX_MB: '1', CLOWDER_CLI_SESSION_ROTATE_CATS: 'kimi' },
      });

      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'not_whitelisted');
      assert.equal(existsSync(sessionDir), true);
    });

    test('under threshold → allow, no rotation', async () => {
      const grokHome = join(tempDir, 'grok-home-3');
      const sessionDir = await makeGrokSession({ grokHome, workingDirectory, sessionId, fileSizeBytes: 100 * 1024 });

      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId,
        workingDirectory,
        env: { GROK_HOME: grokHome, CLOWDER_CLI_SESSION_MAX_MB: '8', CLOWDER_CLI_SESSION_ROTATE_CATS: 'grok' },
      });

      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'under_threshold');
      assert.equal(existsSync(sessionDir), true);
    });

    test('over threshold + whitelisted → rotated: true, session archived (renamed, not deleted)', async () => {
      const grokHome = join(tempDir, 'grok-home-4');
      const sessionDir = await makeGrokSession({ grokHome, workingDirectory, sessionId, fileSizeBytes: 9 * 1024 * 1024 });

      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId,
        workingDirectory,
        env: { GROK_HOME: grokHome, CLOWDER_CLI_SESSION_MAX_MB: '8', CLOWDER_CLI_SESSION_ROTATE_CATS: 'grok' },
        now: () => Date.parse('2026-07-25T12:00:00Z'),
      });

      assert.equal(result.rotated, true);
      assert.equal(result.reason, 'rotated');
      assert.equal(result.sessionPath, sessionDir);
      assert.equal(result.archivedPath, `${sessionDir}.rotated-2026-07-25`);
      assert.ok(result.sizeBytes >= 9 * 1024 * 1024);
      assert.equal(existsSync(sessionDir), false, 'old session must no longer exist AT ITS OLD NAME');
      assert.equal(existsSync(result.archivedPath), true, 'archived copy must exist — never deleted');
    });

    test('no sessionId (fresh thread) → no_session, no fs access needed', async () => {
      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId: undefined,
        workingDirectory,
        env: { CLOWDER_CLI_SESSION_MAX_MB: '8', CLOWDER_CLI_SESSION_ROTATE_CATS: 'grok' },
      });
      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'no_session');
    });

    test('unsupported provider (e.g. claude/anthropic) → path_unresolved, safe no-op even if catId whitelisted', async () => {
      const result = await maybeRotateCliNativeSession({
        catId: 'opus', // hypothetically whitelisted by a misconfigured env
        clientId: 'anthropic',
        sessionId: 'some-claude-session',
        workingDirectory,
        env: { CLOWDER_CLI_SESSION_MAX_MB: '8', CLOWDER_CLI_SESSION_ROTATE_CATS: 'opus' },
      });
      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'path_unresolved');
    });

    test('session directory does not exist on disk → session_not_found, no crash', async () => {
      const grokHome = join(tempDir, 'grok-home-5');
      await mkdir(grokHome, { recursive: true });

      const result = await maybeRotateCliNativeSession({
        catId: 'grok',
        clientId: 'grok',
        sessionId: 'never-existed',
        workingDirectory,
        env: { GROK_HOME: grokHome, CLOWDER_CLI_SESSION_MAX_MB: '8', CLOWDER_CLI_SESSION_ROTATE_CATS: 'grok' },
      });
      assert.equal(result.rotated, false);
      assert.equal(result.reason, 'session_not_found');
    });
  });
});
