import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('CollectionIndexBuilder — secret gate (AC-C1)', () => {
  let CollectionIndexBuilder, FlatScanner, SqliteEvidenceStore;
  let store, dbPath;
  let previousQuarantineFlag;

  beforeEach(async () => {
    previousQuarantineFlag = process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE;
    delete process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE;
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'col-sec-')), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {}
    if (previousQuarantineFlag === undefined) {
      delete process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE;
    } else {
      process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE = previousQuarantineFlag;
    }
  });

  const makeManifest = (root) => ({
    id: 'test:sec',
    kind: 'domain',
    name: 'sec',
    displayName: 'Sec',
    root,
    sensitivity: 'private',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
    createdAt: '2026-05-05',
    updatedAt: '2026-05-05',
  });

  it('blocks indexing when secret detected (fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-secret-'));
    writeFileSync(join(dir, 'safe.md'), '# Safe\n\nNo secrets here.');
    writeFileSync(join(dir, 'dangerous.md'), '# Config\n\naws_key: AKIAIOSFODNN7EXAMPLE\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const result = await builder.rebuild();
    assert.equal(result.blocked, true, 'rebuild should be blocked');
    assert.ok(result.secretFindings.length >= 1);
    assert.equal(result.indexed, 0, 'nothing indexed when secrets found');
  });

  it('indexes normally when no secrets detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-clean-'));
    writeFileSync(join(dir, 'doc.md'), '# Clean\n\nJust regular content.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const result = await builder.rebuild();
    assert.equal(result.blocked, false);
    assert.equal(result.indexed, 1);
    assert.deepEqual(result.secretFindings, []);
  });

  it('reports all secret findings even when blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-multi-'));
    writeFileSync(join(dir, 'a.md'), '# A\n\ntoken = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n');
    writeFileSync(join(dir, 'b.md'), '# B\n\naws: AKIAIOSFODNN7EXAMPLE\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const result = await builder.rebuild();
    assert.equal(result.blocked, true);
    assert.ok(result.secretFindings.length >= 2);
  });

  it('does not write any evidence when blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-nowrite-'));
    writeFileSync(join(dir, 'clean.md'), '# Clean\n\nSafe content.');
    writeFileSync(join(dir, 'dirty.md'), '# Dirty\n\nsk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ab\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    await builder.rebuild();
    const clean = await store.getByAnchor('test:sec:doc/clean');
    assert.equal(clean, null, 'even safe files should not be indexed when batch blocked');
  });

  it('re-indexes when authorityCeiling changes even if content unchanged (R5-P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-ceiling-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nStable content.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const first = await builder.rebuild();
    assert.equal(first.indexed, 1);
    const before = await store.getByAnchor('test:sec:doc/doc');
    assert.equal(before.authority, 'validated');

    manifest.reviewPolicy.authorityCeiling = 'research';
    const builder2 = new CollectionIndexBuilder(store, manifest, scanner);
    const second = await builder2.rebuild();
    assert.equal(second.skipped, 0, 'must not skip when authority ceiling changed');
    assert.equal(second.indexed, 1);
    const after = await store.getByAnchor('test:sec:doc/doc');
    assert.equal(after.authority, 'research', 'authority must reflect new ceiling');
  });

  it('purges pre-existing entries when rebuild is blocked by secrets (P1-A)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-purge-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nSafe content.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const first = await builder.rebuild();
    assert.equal(first.indexed, 1);
    const existing = await store.getByAnchor('test:sec:doc/doc');
    assert.ok(existing, 'doc should be indexed after clean rebuild');

    writeFileSync(join(dir, 'leaked.md'), '# Leaked\n\ntoken: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n');
    const second = await builder.rebuild();
    assert.equal(second.blocked, true);
    const purged = await store.getByAnchor('test:sec:doc/doc');
    assert.equal(purged, null, 'pre-existing entries must be purged when rebuild blocked');
  });

  it('quarantines toxic files and indexes safe files when quarantine flag is enabled', async () => {
    process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE = '1';
    const dir = mkdtempSync(join(tmpdir(), 'col-quarantine-'));
    writeFileSync(join(dir, 'safe.md'), '# Safe\n\nSafe content should remain searchable.');
    writeFileSync(join(dir, 'dirty.md'), '# Dirty\n\naws_key: AKIAIOSFODNN7EXAMPLE\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const result = await builder.rebuild();
    assert.equal(result.blocked, false, 'quarantine mode should not block the whole collection');
    assert.equal(result.indexed, 1, 'safe file should still be indexed');
    assert.ok(result.secretFindings.length >= 1);
    assert.equal(result.quarantinedFiles.length, 1);
    assert.equal(result.quarantinedFiles[0].path, 'dirty.md');
    assert.equal(result.quarantinedFiles[0].anchor, 'test:sec:doc/dirty');
    assert.ok(await store.getByAnchor('test:sec:doc/safe'), 'safe file should be searchable');
    assert.equal(await store.getByAnchor('test:sec:doc/dirty'), null, 'toxic file must not be indexed');
  });

  it('removes previously indexed toxic files while keeping safe files in quarantine mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-quarantine-cleanup-'));
    writeFileSync(join(dir, 'safe.md'), '# Safe\n\nStable safe content.');
    writeFileSync(join(dir, 'later-dirty.md'), '# Initially Safe\n\nNo credentials yet.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:sec');
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const first = await builder.rebuild();
    assert.equal(first.indexed, 2);
    assert.ok(await store.getByAnchor('test:sec:doc/later-dirty'));

    process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE = '1';
    writeFileSync(join(dir, 'later-dirty.md'), '# Dirty\n\ntoken: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n');
    const second = await builder.rebuild();

    assert.equal(second.blocked, false);
    assert.equal(second.quarantinedFiles.length, 1);
    assert.ok(await store.getByAnchor('test:sec:doc/safe'), 'safe existing file should remain indexed');
    assert.equal(
      await store.getByAnchor('test:sec:doc/later-dirty'),
      null,
      'previously indexed toxic file must be removed from search',
    );
  });
});
