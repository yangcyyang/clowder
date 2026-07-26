/**
 * StartupPermissionCheck tests (batch 4-A, A1 — 启动权限自检).
 * A-AC1: simulate revoked permission (chmod 000) → startup self-check posts an
 * alert card; after recovery, a resolution notice is posted; unchanged status is
 * never re-announced.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

function createFakeMessageStore() {
  const appended = [];
  return {
    appended,
    async append(msg) {
      appended.push(msg);
      return { id: `msg-${appended.length}`, threadId: msg.threadId ?? 'default', ...msg };
    },
  };
}

describe('StartupPermissionCheck', () => {
  /** @type {typeof import('../dist/services/StartupPermissionCheck.js')} */
  let mod;
  /** @type {typeof import('../dist/config/governance/governance-registry.js')} */
  let registryMod;
  /** @type {typeof import('../dist/config/governance/governance-bootstrap.js')} */
  let bootstrapMod;
  let catCafeRoot;

  beforeEach(async () => {
    mod = await import('../dist/services/StartupPermissionCheck.js');
    registryMod = await import('../dist/config/governance/governance-registry.js');
    bootstrapMod = await import('../dist/config/governance/governance-bootstrap.js');
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    await mkdir(join(catCafeRoot, 'cat-cafe-skills', 'tdd'), { recursive: true });
    await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'tdd', 'SKILL.md'), '# TDD');
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
  });

  test('module loads', () => {
    assert.ok(mod.StartupPermissionCheck);
  });

  test('healthy startup (no registered projects, writable data root) posts nothing', async () => {
    const messageStore = createFakeMessageStore();
    const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });
    await check.runCheck();
    assert.equal(messageStore.appended.length, 0, 'no news is good news on a healthy first check');
  });

  test('A-AC1: data root not writable (chmod 000) posts a Chinese alert card to the lobby (DEFAULT_THREAD_ID)', async () => {
    const messageStore = createFakeMessageStore();
    const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });

    await chmod(catCafeRoot, 0o000);
    try {
      await check.runCheck();
    } finally {
      await chmod(catCafeRoot, 0o755); // restore so afterEach's rm() can clean up
    }

    assert.equal(messageStore.appended.length, 1);
    const msg = messageStore.appended[0];
    assert.equal(msg.threadId, 'default');
    assert.equal(msg.userId, 'system');
    assert.equal(msg.catId, null);
    assert.match(msg.content, /权限自检失败/);
    assert.match(msg.content, /完整磁盘访问权限/);
    assert.equal(msg.source.connector, 'startup-permission-check');
    assert.equal(msg.source.meta.presentation, 'system_notice');
    assert.equal(msg.source.meta.noticeTone, 'warning');
  });

  test('A-AC1: recovery after the data root becomes writable again posts a resolution notice', async () => {
    const messageStore = createFakeMessageStore();
    const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });

    await chmod(catCafeRoot, 0o000);
    await check.runCheck();
    await chmod(catCafeRoot, 0o755);
    await check.runCheck();

    assert.equal(messageStore.appended.length, 2);
    assert.equal(messageStore.appended[0].source.meta.noticeTone, 'warning');
    assert.equal(messageStore.appended[1].source.meta.noticeTone, 'success');
    assert.match(messageStore.appended[1].content, /权限自检恢复/);
  });

  test('unchanged status (still broken) is never re-announced', async () => {
    const messageStore = createFakeMessageStore();
    const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });

    await chmod(catCafeRoot, 0o000);
    try {
      await check.runCheck();
      await check.runCheck();
      await check.runCheck();
    } finally {
      await chmod(catCafeRoot, 0o755);
    }
    assert.equal(messageStore.appended.length, 1, 'repeated checks with no status change must not spam the lobby');
  });

  test('unchanged healthy status is never announced across repeated checks', async () => {
    const messageStore = createFakeMessageStore();
    const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });
    await check.runCheck();
    await check.runCheck();
    assert.equal(messageStore.appended.length, 0);
  });

  test('A-AC1: a confirmed registered project that becomes unreadable is reported by path, and recovers', async () => {
    const externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    try {
      const service = new bootstrapMod.GovernanceBootstrapService(catCafeRoot);
      await service.bootstrap(externalProject, { dryRun: false });

      const messageStore = createFakeMessageStore();
      const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });

      await chmod(externalProject, 0o000);
      try {
        await check.runCheck();
      } finally {
        await chmod(externalProject, 0o755);
      }
      assert.equal(messageStore.appended.length, 1);
      assert.match(messageStore.appended[0].content, new RegExp(externalProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(messageStore.appended[0].source.meta.noticeTone, 'warning');

      await check.runCheck(); // now readable again — recovery
      assert.equal(messageStore.appended.length, 2);
      assert.equal(messageStore.appended[1].source.meta.noticeTone, 'success');
    } finally {
      await rm(externalProject, { recursive: true, force: true });
    }
  });

  test('an unconfirmed (pending) registry entry is never probed', async () => {
    const externalProject = await mkdtemp(join(tmpdir(), 'external-project-pending-'));
    try {
      const registry = new registryMod.GovernanceRegistry(catCafeRoot);
      await registry.register(externalProject, {
        packVersion: '1.0.0',
        checksum: 'abc',
        syncedAt: Date.now(),
        confirmedByUser: false,
      });
      // No CLAUDE.md exists in externalProject (never bootstrapped) — if this were
      // probed it would immediately report broken. It must be skipped entirely.
      const messageStore = createFakeMessageStore();
      const check = new mod.StartupPermissionCheck({ catCafeRoot, messageStore });
      await check.runCheck();
      assert.equal(messageStore.appended.length, 0, 'unconfirmed entries must not be read-probed');
    } finally {
      await rm(externalProject, { recursive: true, force: true });
    }
  });
});
