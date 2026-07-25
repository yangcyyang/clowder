/**
 * LibraryRebuildScheduler tests (F-H batch 0, item 1 — periodic auto-rebuild
 * for read-only library collections).
 *
 * Uses real SqliteEvidenceStore + LibraryCatalog + FlatScanner/StructuredScanner
 * against tiny temp-directory "vaults" (mirroring the auto-retry-scheduler.test.js
 * style of exercising real collaborators over fakes where cheap to do so).
 * No Redis involved — this scheduler is intentionally Redis-independent.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';
import {
  isLibraryRebuildEnabled,
  LibraryRebuildScheduler,
  resolveLibraryRebuildHours,
} from '../dist/domains/memory/LibraryRebuildScheduler.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

function makeManifest(overrides) {
  const now = new Date().toISOString();
  return {
    id: 'domain:test-vault',
    kind: 'domain',
    name: 'test-vault',
    displayName: 'Test Vault (Obsidian Read-only)',
    root: '/tmp/does-not-matter',
    sensitivity: 'internal',
    scannerLevel: 'auto',
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
    readOnly: true,
    exclude: ['.obsidian/**'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('LibraryRebuildScheduler — env parsing', () => {
  test('resolveLibraryRebuildHours: unset/blank/invalid -> default 24; 0 is a valid off value', () => {
    assert.equal(resolveLibraryRebuildHours({}), 24);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: '' }), 24);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: '   ' }), 24);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: 'not-a-number' }), 24);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: '-5' }), 24);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: '0' }), 0);
    assert.equal(resolveLibraryRebuildHours({ CLOWDER_LIBRARY_REBUILD_HOURS: '6' }), 6);
  });

  test('isLibraryRebuildEnabled: false only when hours resolves to 0', () => {
    assert.equal(isLibraryRebuildEnabled({ CLOWDER_LIBRARY_REBUILD_HOURS: '0' }), false);
    assert.equal(isLibraryRebuildEnabled({}), true);
    assert.equal(isLibraryRebuildEnabled({ CLOWDER_LIBRARY_REBUILD_HOURS: 'garbage' }), true);
  });
});

describe('LibraryRebuildScheduler — tick()', () => {
  test('env off (hours=0): zero action even when forced due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-rebuild-off-'));
    try {
      writeFileSync(join(dir, 'a.md'), '# A\n\nhello world');
      const manifest = makeManifest({ id: 'domain:off-test', root: dir });
      const catalog = new LibraryCatalog();
      catalog.register(manifest);

      const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
      await store.initialize();
      const stores = new Map([[manifest.id, store]]);

      const scheduler = new LibraryRebuildScheduler({
        catalog,
        stores,
        env: { CLOWDER_LIBRARY_REBUILD_HOURS: '0' },
      });
      scheduler._forceDueForTest();
      await scheduler.tick();

      const doc = await store.getByAnchor(`${manifest.id}:doc/a`);
      assert.equal(doc, null, 'disabled scheduler must not have indexed anything');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('due: rebuilds only readOnly:true collections via the real CollectionIndexBuilder path', async () => {
    const roDir = mkdtempSync(join(tmpdir(), 'lib-rebuild-ro-'));
    const rwDir = mkdtempSync(join(tmpdir(), 'lib-rebuild-rw-'));
    try {
      writeFileSync(join(roDir, 'note.md'), '# Hello\n\nSome body text.');
      writeFileSync(join(rwDir, 'note2.md'), '# Two\n\nBody.');

      const roManifest = makeManifest({ id: 'domain:due-test', root: roDir });
      const rwManifest = makeManifest({
        id: 'project:not-readonly',
        kind: 'project',
        root: rwDir,
        readOnly: false,
      });

      const catalog = new LibraryCatalog();
      catalog.register(roManifest);
      catalog.register(rwManifest);

      const roStore = new SqliteEvidenceStore(join(roDir, 'evidence.sqlite'));
      await roStore.initialize();
      const rwStore = new SqliteEvidenceStore(join(rwDir, 'evidence.sqlite'));
      await rwStore.initialize();
      const stores = new Map([
        [roManifest.id, roStore],
        [rwManifest.id, rwStore],
      ]);

      const scheduler = new LibraryRebuildScheduler({ catalog, stores, env: {} });
      scheduler._forceDueForTest();
      await scheduler.tick();

      const doc = await roStore.getByAnchor(`${roManifest.id}:doc/note`);
      assert.ok(doc, 'readOnly collection should have been rebuilt');
      assert.equal(doc.title, 'Hello');

      const rwCount = rwStore.getDb().prepare('SELECT count(*) AS c FROM evidence_docs').get().c;
      assert.equal(rwCount, 0, 'non-readOnly collection must NOT be touched by this scheduler');

      roStore.close();
      rwStore.close();
    } finally {
      rmSync(roDir, { recursive: true, force: true });
      rmSync(rwDir, { recursive: true, force: true });
    }
  });

  test('a failing collection does not throw, and gets retried on the very next tick instead of waiting a full window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-rebuild-fail-'));
    try {
      writeFileSync(join(dir, 'note.md'), '# Hello\n\nBody.');
      const manifest = makeManifest({ id: 'domain:fail-test', root: dir });
      const catalog = new LibraryCatalog();
      catalog.register(manifest);

      let calls = 0;
      const failingStore = {
        async getByAnchor() {
          return null;
        },
        async upsert() {
          calls++;
          throw new Error('boom');
        },
      };
      const stores = new Map([[manifest.id, failingStore]]);

      const scheduler = new LibraryRebuildScheduler({
        catalog,
        stores,
        env: {},
        now: () => 1_000_000, // fixed clock — irrelevant once forced due with -Infinity
      });
      scheduler._forceDueForTest();

      await assert.doesNotReject(() => scheduler.tick());
      assert.equal(calls, 1, 'rebuild should have been attempted once');

      // lastRunAt must NOT have advanced after a failed pass -> still due immediately
      await assert.doesNotReject(() => scheduler.tick());
      assert.equal(calls, 2, 'a failed pass must be retried on the next tick, not deferred a full window');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overlapping ticks are guarded: a tick already in flight is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-rebuild-overlap-'));
    try {
      writeFileSync(join(dir, 'note.md'), '# Hello\n\nBody.');
      const manifest = makeManifest({ id: 'domain:overlap-test', root: dir });
      const catalog = new LibraryCatalog();
      catalog.register(manifest);

      let inFlight = 0;
      let maxConcurrent = 0;
      const slowStore = {
        async getByAnchor() {
          return null;
        },
        async upsert() {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight--;
        },
        // CollectionIndexBuilder.cleanStale() reads via getDb() after indexing —
        // stub it out so this test only exercises the overlap guard, not a
        // (harmless but noisy) secondary failure path.
        getDb() {
          return { prepare: () => ({ all: () => [] }) };
        },
      };
      const stores = new Map([[manifest.id, slowStore]]);

      const scheduler = new LibraryRebuildScheduler({ catalog, stores, env: {} });
      scheduler._forceDueForTest();

      const p1 = scheduler.tick();
      const p2 = scheduler.tick(); // should observe `ticking` and return immediately
      await Promise.all([p1, p2]);

      assert.equal(maxConcurrent, 1, 'overlapping tick() calls must not run rebuilds concurrently');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
