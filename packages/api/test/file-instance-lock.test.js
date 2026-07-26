/**
 * FileInstanceLock tests (batch 4-A, A4 — 属主锁最小版).
 * Mirrors api-instance-lease.test.js's style but for the file-layer fallback that
 * protects the case ApiInstanceLease can't: Redis unavailable/disabled.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('FileInstanceLock', () => {
  /** @type {typeof import('../dist/services/FileInstanceLock.js')} */
  let mod;
  let dataRoot;

  beforeEach(async () => {
    mod = await import('../dist/services/FileInstanceLock.js');
    dataRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-lock-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test('module loads', () => {
    assert.ok(mod.FileInstanceLock);
    assert.ok(mod.formatFileInstanceLockConflict);
    assert.equal(mod.FILE_INSTANCE_LOCK_FILENAME, 'api-instance.lock');
  });

  test('first-ever acquire when the data root directory does not exist yet succeeds (creates it)', async () => {
    const freshRoot = join(dataRoot, 'not-created-yet', '.cat-cafe');
    const lock = new mod.FileInstanceLock({ dataRoot: freshRoot, apiPort: 3004, pid: 111 });
    const result = await lock.acquire();
    assert.equal(result.acquired, true);
    const raw = await readFile(join(freshRoot, 'api-instance.lock'), 'utf-8');
    assert.equal(JSON.parse(raw).pid, 111);
  });

  test('first acquire on an empty data root succeeds', async () => {
    const lock = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    const result = await lock.acquire();
    assert.equal(result.acquired, true);
    assert.equal(result.conflict, undefined);

    const raw = await readFile(join(dataRoot, 'api-instance.lock'), 'utf-8');
    const marker = JSON.parse(raw);
    assert.equal(marker.pid, 111);
    assert.equal(marker.apiPort, 3004);
    assert.equal(typeof marker.dev, 'number');
    assert.equal(typeof marker.ino, 'number');
  });

  test('second acquire while the first holder is alive is rejected with conflict info', async () => {
    const first = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111, cwd: '/holder/cwd' });
    await first.acquire();

    const second = new mod.FileInstanceLock({
      dataRoot,
      apiPort: 3004,
      pid: 222,
      isPidAlive: (pid) => pid === 111, // holder (111) reports alive
    });
    const result = await second.acquire();
    assert.equal(result.acquired, false);
    assert.ok(result.conflict);
    assert.equal(result.conflict.pid, 111);
    assert.equal(result.conflict.cwd, '/holder/cwd');
  });

  test('formatFileInstanceLockConflict produces a Chinese human-readable message naming the pid', async () => {
    const first = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    await first.acquire();
    const second = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 222, isPidAlive: () => true });
    const result = await second.acquire();
    const message = mod.formatFileInstanceLockConflict(result.conflict, dataRoot);
    assert.match(message, /另一个 Clowder API/);
    assert.match(message, /111/);
  });

  test('stale marker (dead pid) is automatically taken over, not rejected', async () => {
    const first = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    await first.acquire();

    const second = new mod.FileInstanceLock({
      dataRoot,
      apiPort: 3004,
      pid: 222,
      isPidAlive: () => false, // pid 111 is dead — kill -0 would fail
    });
    const result = await second.acquire();
    assert.equal(result.acquired, true, 'a dead-pid marker must be treated as stale and taken over');

    const raw = await readFile(join(dataRoot, 'api-instance.lock'), 'utf-8');
    assert.equal(JSON.parse(raw).pid, 222);
  });

  test('marker describing a different physical data root (dev/ino mismatch) is treated as foreign/stale, not a live conflict', async () => {
    // Simulate a leftover marker from a deleted+recreated data root: same path,
    // different {dev, ino} than the CURRENT directory's real stat.
    await writeFile(
      join(dataRoot, 'api-instance.lock'),
      JSON.stringify({
        version: 1,
        token: 'foreign-token',
        pid: 111,
        dev: 999999,
        ino: 999999,
        hostname: 'other-host',
        cwd: '/other/cwd',
        apiPort: 3004,
        startedAt: Date.now(),
      }),
    );
    const lock = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 222, isPidAlive: () => true });
    const result = await lock.acquire();
    assert.equal(result.acquired, true, 'dev/ino mismatch must not be treated as a live conflict');
  });

  test('release() removes the marker so a fresh acquire succeeds cleanly', async () => {
    const lock = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    await lock.acquire();
    await lock.release();

    const second = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 222, isPidAlive: () => true });
    const result = await second.acquire();
    assert.equal(result.acquired, true);
  });

  test('release() is a token-guarded no-op if another instance already stole the (stale) lock', async () => {
    const first = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    await first.acquire();

    // A second instance takes over because pid 111 looks dead from ITS perspective.
    const second = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 222, isPidAlive: () => false });
    await second.acquire();

    // The (conceptually stale, but still in-process) first instance now releases —
    // it must NOT delete the second instance's marker out from under it.
    await first.release();

    const raw = await readFile(join(dataRoot, 'api-instance.lock'), 'utf-8');
    assert.equal(JSON.parse(raw).pid, 222, "first instance's release() must not clobber the new holder's marker");
  });

  test('corrupt/foreign-shaped marker JSON is treated as absent, safe to overwrite', async () => {
    await writeFile(join(dataRoot, 'api-instance.lock'), '{"not":"a valid marker"}');
    const lock = new mod.FileInstanceLock({ dataRoot, apiPort: 3004, pid: 111 });
    const result = await lock.acquire();
    assert.equal(result.acquired, true);
  });
});
