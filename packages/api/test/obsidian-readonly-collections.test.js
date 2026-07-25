/**
 * obsidian-readonly-collections.ts tests.
 *
 * Regression test for a parseRootEntry bug found while investigating F-H
 * (batch 0): when the "id=" half of an "id=path" entry fails
 * validateCollectionId (e.g. non-ASCII / digit-leading name — exactly what
 * the repo's own .env currently has: `domain:400知识库=/path/to/vault`), the
 * catch fallback used to return the *raw, unsplit* entry string as the root
 * path (still carrying the invalid "id=" prefix glued to the front). That
 * bogus path almost never exists on disk, so isExistingDirectory() silently
 * skipped the whole collection — the vault mount would vanish on the next
 * clean process start with no error anywhere. Fixed to fall back to the
 * already-split `root` substring (the part after "="), letting allocateId()
 * derive a usable ascii-slug id instead of losing the collection.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadObsidianReadonlyCollections } from '../dist/domains/memory/obsidian-readonly-collections.js';

describe('loadObsidianReadonlyCollections — parseRootEntry fallback', () => {
  test('an invalid, non-ASCII/digit-leading id prefix still loads the collection (falls back to path, not raw entry)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-ro-idbug-'));
    try {
      // Mirrors the exact shape currently in the repo's .env:
      // OBSIDIAN_READONLY_ROOTS="domain:400知识库=/abs/path/to/vault"
      const raw = `domain:400知识库=${dir}`;
      const manifests = loadObsidianReadonlyCollections(raw);

      assert.equal(manifests.length, 1, 'collection must still load despite the invalid id prefix');
      const m = manifests[0];
      assert.equal(m.root, dir, 'root must be the actual existing directory, not the raw "id=path" string');
      assert.match(m.id, /^domain:[a-z][a-z0-9-]*$/, 'a valid ascii-slug id must be auto-allocated');
      assert.equal(m.readOnly, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a valid ascii id prefix is still honored as before (no regression on the happy path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-ro-validid-'));
    try {
      const raw = `domain:my-vault=${dir}`;
      const manifests = loadObsidianReadonlyCollections(raw);

      assert.equal(manifests.length, 1);
      assert.equal(manifests[0].id, 'domain:my-vault');
      assert.equal(manifests[0].root, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bare path with no "id=" prefix still works (no regression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-ro-bare-'));
    try {
      const manifests = loadObsidianReadonlyCollections(dir);
      assert.equal(manifests.length, 1);
      assert.equal(manifests[0].root, dir);
      assert.match(manifests[0].id, /^domain:[a-z][a-z0-9-]*$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-existent root (whether or not it has an id prefix) is silently skipped', () => {
    const manifests = loadObsidianReadonlyCollections('domain:ghost=/definitely/does/not/exist/anywhere');
    assert.deepEqual(manifests, []);
  });
});
