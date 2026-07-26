/**
 * A2 base spec wiring test (batch 4-A): "CLI 启动即退且 stderr 含 EPERM/permission →
 * ... 并触发 A1 的自检立即复跑一次".
 *
 * End-to-end reproduction of the real incident chain (registry file itself
 * unreadable → checkGovernancePreflight throws → invoke-single-cat.ts's existing
 * fail-open retry ALSO fails closed → reasonKind='permission_denied') and verifies
 * invoke-single-cat.ts's new hook calls the registered StartupPermissionCheck
 * singleton's runCheck() — not just that the governance block itself still works
 * (already covered by governance-blocked-event.test.js / governance-preflight.test.js).
 *
 * Setup mirrors invoke-single-cat-preflight.test.js's temp-repo + chdir pattern,
 * but skips git entirely (governance preflight doesn't need it).
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

let invokeSingleCat;
let setActiveStartupPermissionCheck;
let originalCwd;
const tempDirs = [];

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

function makeDeps(threadStore) {
  let counter = 0;
  return {
    registry: {
      create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore,
    apiUrl: 'http://127.0.0.1:3004',
  };
}

describe('invoke-single-cat: A1 recheck trigger on permission_denied (batch 4-A)', () => {
  before(async () => {
    originalCwd = process.cwd();
    const auditDir = await mkdtemp(join(tmpdir(), 'cat-audit-a1trigger-'));
    tempDirs.push(auditDir);
    process.env.AUDIT_LOG_DIR = auditDir;
    const invokeMod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = invokeMod.invokeSingleCat;
    const startupCheckMod = await import('../dist/services/StartupPermissionCheck.js');
    setActiveStartupPermissionCheck = startupCheckMod.setActiveStartupPermissionCheck;
  });

  after(() => {
    process.chdir(originalCwd);
    setActiveStartupPermissionCheck(undefined);
  });

  afterEach(async () => {
    setActiveStartupPermissionCheck(undefined);
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('governance registry unreadable → permission_denied block → registered StartupPermissionCheck.runCheck() is called', async () => {
    const catCafeRoot = await mkdtemp(join(tmpdir(), 'a1trigger-catcafe-'));
    const externalProject = await mkdtemp(join(tmpdir(), 'a1trigger-external-'));
    tempDirs.push(catCafeRoot, externalProject);
    await writeFile(join(catCafeRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    // Register + confirm the external project (writable at this point) so the
    // governance registry FILE exists and has real content to later become unreadable.
    const { GovernanceBootstrapService } = await import('../dist/config/governance/governance-bootstrap.js');
    await mkdir(join(catCafeRoot, 'cat-cafe-skills', 'tdd'), { recursive: true });
    await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'tdd', 'SKILL.md'), '# TDD');
    await new GovernanceBootstrapService(catCafeRoot).bootstrap(externalProject, { dryRun: false });

    const registryFile = join(catCafeRoot, '.cat-cafe', 'governance-registry.json');
    await chmod(registryFile, 0o000);

    let runCheckCalls = 0;
    setActiveStartupPermissionCheck({ runCheck: async () => { runCheckCalls++; } });

    const threadStore = {
      get: async () => ({ projectPath: externalProject, createdAt: Date.now() }),
    };

    process.chdir(catCafeRoot); // findMonorepoRoot(process.cwd()) → catCafeRoot

    const stubService = {
      async *invoke() {
        yield { type: 'text', catId: 'codex', content: 'should not run', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    let msgs;
    try {
      msgs = await collect(
        invokeSingleCat(makeDeps(threadStore), {
          catId: 'codex',
          service: stubService,
          prompt: 'test A1 recheck trigger',
          userId: 'user1',
          threadId: 'thread-a1-recheck-trigger',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(originalCwd);
      await chmod(registryFile, 0o644); // restore so rm() in afterEach can clean up
    }

    // Sanity: this really did hit the governance block (not some unrelated failure).
    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'should end with a done event');
    assert.equal(doneMsg.errorCode, 'PROJECT_PERMISSION_DENIED');

    // The actual point of this test: A1's runCheck() was triggered. The trigger is
    // fire-and-forget (`void import(...).then(...)`), so give the microtask/macrotask
    // queue a moment to run before asserting.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runCheckCalls, 1, "invoke-single-cat.ts's permission_denied branch must call the active StartupPermissionCheck's runCheck() exactly once");
  });

  it('needs_bootstrap block (unrelated to permission) does NOT trigger A1 recheck', async () => {
    const catCafeRoot = await mkdtemp(join(tmpdir(), 'a1trigger-catcafe-nb-'));
    const externalProject = await mkdtemp(join(tmpdir(), 'a1trigger-external-nb-'));
    tempDirs.push(catCafeRoot, externalProject);
    await writeFile(join(catCafeRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await mkdir(join(catCafeRoot, 'cat-cafe-skills'), { recursive: true });

    let runCheckCalls = 0;
    setActiveStartupPermissionCheck({ runCheck: async () => { runCheckCalls++; } });

    const threadStore = { get: async () => ({ projectPath: externalProject, createdAt: Date.now() }) };
    process.chdir(catCafeRoot);

    const stubService = {
      async *invoke() {
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    let msgs;
    try {
      msgs = await collect(
        invokeSingleCat(makeDeps(threadStore), {
          catId: 'codex',
          service: stubService,
          prompt: 'test needs_bootstrap does not trigger A1',
          userId: 'user1',
          threadId: 'thread-needs-bootstrap-no-trigger',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(originalCwd);
    }

    const doneMsg = msgs.find((m) => m.type === 'done');
    assert.equal(doneMsg?.errorCode, 'GOVERNANCE_BOOTSTRAP_REQUIRED');

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runCheckCalls, 0, 'needs_bootstrap must not trigger the permission-only A1 recheck hook');
  });
});
