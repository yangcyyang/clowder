/**
 * F-G (PRD-memory-upgrade 批次 3): CLI 原生 session 撑爆治理 — invokeSingleCat 接线集成测试。
 *
 * 覆盖 docs/prd/PRD-memory-upgrade.md F-G 在 invoke-single-cat.ts 里的实际接线：
 *  - 超限 + 白名单命中 → service.invoke() 收到的 sessionId 被清空（等效强制轮转）
 *  - 旧 session 原生文件被改名归档（.rotated-<date>），不是删除
 *  - thread 里追加一条轻量系统通知（extra.systemKind === 'cli_session_rotated'）
 *  - 轮转事件后补一次蒸馏调用（autoUpdateAgentMemory，写入隔离的假 monorepo，不碰真实仓库）
 *  - env 全关时零动作：sessionId 原样传给 service.invoke()，不触碰任何文件
 *
 * 隔离策略（不碰真实仓库的 .cat-cafe/memory/*）：process.chdir 到一个只含
 * pnpm-workspace.yaml 的临时目录，让 findMonorepoRoot()/autoUpdateAgentMemory 的默认
 * projectRoot 都落在这个隔离目录里；thread.projectPath 设为同一目录，
 * isSameProject(workingDirectory, hostProjectRoot) 直接按路径相等短路为 true，
 * 跳过 F070 外部项目治理门（不需要伪造 git 仓库）。
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const CAT_ID = 'grok-rotation-canary-test';

let invokeSingleCat;
let originalCwd;
let originalEnv;
const tempDirs = [];

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

/**
 * Creates an isolated fake monorepo (just a `pnpm-workspace.yaml` marker) and chdir's into
 * it, then returns `process.cwd()` (NOT the raw mkdtemp path) — on macOS `os.tmpdir()` lives
 * under a `/var/folders/...` symlink that resolves to `/private/var/folders/...`; `chdir` +
 * `cwd()` return the resolved form, while `path.resolve()` (used by `isSameProject`) does NOT
 * follow symlinks. Using the raw pre-chdir path anywhere downstream (thread.projectPath, the
 * Grok session bucket encoding) would silently mismatch `hostProjectRoot` and trip the F070
 * external-project governance gate instead of exercising the rotation gate.
 */
function makeFakeMonorepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cli-rotation-repo-'));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  tempDirs.push(dir);
  process.chdir(dir);
  return process.cwd();
}

function makeGrokSessionOnDisk({ grokHome, workingDirectory, sessionId, fileSizeBytes }) {
  const sessionDir = join(grokHome, 'sessions', encodeURIComponent(workingDirectory), sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'updates.jsonl'), Buffer.alloc(fileSizeBytes, 'x'));
  return sessionDir;
}

function makeDeps({ fakeRepo, oldSessionId, messageAppends }) {
  let counter = 0;
  return {
    registry: {
      create: () => ({ invocationId: `inv-rotation-${++counter}`, callbackToken: `tok-${counter}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => oldSessionId,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => fakeRepo,
    },
    threadStore: {
      get: async () => ({ createdAt: Date.now(), projectPath: fakeRepo }),
      getContextResetBoundary: async () => null,
    },
    messageStore: {
      append: async (msg) => {
        messageAppends.push(msg);
        return { id: `msg-${messageAppends.length}`, ...msg };
      },
    },
    apiUrl: 'http://127.0.0.1:3004',
  };
}

describe('F-G invokeSingleCat CLI native session rotation wiring', () => {
  before(async () => {
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    if (!catRegistry.has(CAT_ID)) {
      catRegistry.register(CAT_ID, {
        id: CAT_ID,
        name: 'RotationCanary',
        displayName: 'RotationCanary',
        avatar: '',
        color: { primary: '#000', secondary: '#fff' },
        mentionPatterns: [`@${CAT_ID}`],
        clientId: 'grok',
        defaultModel: 'grok-test',
        mcpSupport: false,
        roleDescription: '',
        personality: '',
      });
    }
    const auditDir = mkdtempSync(join(tmpdir(), 'cat-audit-rotation-'));
    tempDirs.push(auditDir);
    process.env.AUDIT_LOG_DIR = auditDir;
    process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  beforeEach(() => {
    delete process.env.CLOWDER_CLI_SESSION_MAX_MB;
    delete process.env.CLOWDER_CLI_SESSION_ROTATE_CATS;
    delete process.env.GROK_HOME;
  });

  it('over threshold + whitelisted → drops sessionId, archives old session file, posts notice, forces distillation write', async () => {
    const fakeRepo = makeFakeMonorepo();

    const grokHome = mkdtempSync(join(tmpdir(), 'grok-home-rotation-'));
    tempDirs.push(grokHome);
    const oldSessionId = 'old-session-over-limit';
    const sessionDir = makeGrokSessionOnDisk({
      grokHome,
      workingDirectory: fakeRepo,
      sessionId: oldSessionId,
      fileSizeBytes: 9 * 1024 * 1024, // 9 MiB > 1 MiB threshold below
    });

    process.env.CLOWDER_CLI_SESSION_MAX_MB = '1';
    process.env.CLOWDER_CLI_SESSION_ROTATE_CATS = CAT_ID;
    process.env.GROK_HOME = grokHome;

    const messageAppends = [];
    let receivedSessionId = 'not-called';
    const service = {
      async *invoke(_prompt, options) {
        receivedSessionId = options.sessionId;
        yield { type: 'done', catId: CAT_ID, metadata: { provider: 'grok', model: 'grok-test' }, timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps({ fakeRepo, oldSessionId, messageAppends }), {
        catId: CAT_ID,
        service,
        prompt: 'test prompt',
        userId: 'user1',
        threadId: 'thread-rotation-1',
        isLastCat: true,
      }),
    );
    assert.ok(msgs.length > 0);

    assert.equal(receivedSessionId, undefined, 'service.invoke must NOT receive the oversized session id — resume dropped');

    assert.equal(existsSync(sessionDir), false, 'old session path must no longer exist at its old name');
    const archivedPath = `${sessionDir}.rotated-${new Date().toISOString().slice(0, 10)}`;
    assert.equal(existsSync(archivedPath), true, 'old session must be archived by rename (never deleted)');
    const archivedContent = await readFile(join(archivedPath, 'updates.jsonl'));
    assert.equal(archivedContent.length, 9 * 1024 * 1024, 'archived content must be byte-identical (nothing lost)');

    const notice = messageAppends.find((m) => m.extra?.systemKind === 'cli_session_rotated');
    assert.ok(notice, 'a system notice must be posted to the thread');
    assert.equal(notice.threadId, 'thread-rotation-1');
    assert.match(notice.content, /已归档/);
    assert.match(notice.content, new RegExp(CAT_ID));

    // Supplementary distillation write — force:true bypasses the rate limiter and writes
    // into the isolated fake monorepo (never the real repo's .cat-cafe/memory/*).
    const memoryPath = join(fakeRepo, '.cat-cafe', 'memory', `${CAT_ID}.md`);
    assert.equal(existsSync(memoryPath), true, 'rotation distillation must have written the agent memory index file');
    const memoryContent = await readFile(memoryPath, 'utf-8');
    assert.match(memoryContent, /轮转/, 'memory content should mention the rotation event');
  });

  it('CLOWDER_CLI_SESSION_MAX_MB unset (default off) → zero action, sessionId passes through untouched', async () => {
    const fakeRepo = makeFakeMonorepo();

    const grokHome = mkdtempSync(join(tmpdir(), 'grok-home-rotation-off-'));
    tempDirs.push(grokHome);
    const oldSessionId = 'old-session-untouched';
    const sessionDir = makeGrokSessionOnDisk({
      grokHome,
      workingDirectory: fakeRepo,
      sessionId: oldSessionId,
      fileSizeBytes: 20 * 1024 * 1024, // huge — would rotate if the gate were on
    });
    process.env.GROK_HOME = grokHome;
    // CLOWDER_CLI_SESSION_MAX_MB / ROTATE_CATS intentionally left unset (default off).

    const messageAppends = [];
    let receivedSessionId = 'not-called';
    const service = {
      async *invoke(_prompt, options) {
        receivedSessionId = options.sessionId;
        yield { type: 'done', catId: CAT_ID, metadata: { provider: 'grok', model: 'grok-test' }, timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(makeDeps({ fakeRepo, oldSessionId, messageAppends }), {
        catId: CAT_ID,
        service,
        prompt: 'test prompt',
        userId: 'user1',
        threadId: 'thread-rotation-2',
        isLastCat: true,
      }),
    );

    assert.equal(receivedSessionId, oldSessionId, 'default-off gate must pass the session id through unchanged');
    assert.equal(existsSync(sessionDir), true, 'session dir must be completely untouched when the gate is off');
    assert.equal(
      messageAppends.some((m) => m.extra?.systemKind === 'cli_session_rotated'),
      false,
      'no rotation notice when the gate never fired',
    );
    const memoryPath = join(fakeRepo, '.cat-cafe', 'memory', `${CAT_ID}.md`);
    assert.equal(existsSync(memoryPath), false, 'no distillation write when the gate never fired');
  });

  it('over threshold but catId NOT on whitelist → zero action', async () => {
    const fakeRepo = makeFakeMonorepo();

    const grokHome = mkdtempSync(join(tmpdir(), 'grok-home-rotation-notlisted-'));
    tempDirs.push(grokHome);
    const oldSessionId = 'old-session-not-whitelisted';
    const sessionDir = makeGrokSessionOnDisk({
      grokHome,
      workingDirectory: fakeRepo,
      sessionId: oldSessionId,
      fileSizeBytes: 5 * 1024 * 1024,
    });
    process.env.GROK_HOME = grokHome;
    process.env.CLOWDER_CLI_SESSION_MAX_MB = '1';
    process.env.CLOWDER_CLI_SESSION_ROTATE_CATS = 'some-other-cat'; // canary cat not included

    const messageAppends = [];
    let receivedSessionId = 'not-called';
    const service = {
      async *invoke(_prompt, options) {
        receivedSessionId = options.sessionId;
        yield { type: 'done', catId: CAT_ID, metadata: { provider: 'grok', model: 'grok-test' }, timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(makeDeps({ fakeRepo, oldSessionId, messageAppends }), {
        catId: CAT_ID,
        service,
        prompt: 'test prompt',
        userId: 'user1',
        threadId: 'thread-rotation-3',
        isLastCat: true,
      }),
    );

    assert.equal(receivedSessionId, oldSessionId, 'not-whitelisted cat must resume normally');
    assert.equal(existsSync(sessionDir), true, 'session dir must be untouched when the cat is not on the whitelist');
    assert.equal(messageAppends.some((m) => m.extra?.systemKind === 'cli_session_rotated'), false);
  });
});
