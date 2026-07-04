import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('CollectionAutoRebuildScheduler', () => {
  it('indexes new notes when the auto-refresh cycle runs', async () => {
    const { CollectionAutoRebuildScheduler } = await import(
      '../../dist/domains/memory/CollectionAutoRebuildScheduler.js'
    );
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const root = mkdtempSync(join(tmpdir(), 'collection-auto-root-'));
    writeFileSync(join(root, 'alpha.md'), '# Alpha\n\nFirst knowledge note.');

    const store = new InMemoryEvidenceStore();

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'domain:auto-refresh',
      kind: 'domain',
      name: 'auto-refresh',
      displayName: 'Auto Refresh',
      root,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      readOnly: true,
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const scheduler = new CollectionAutoRebuildScheduler({
      catalog,
      stores: new Map([['domain:auto-refresh', store]]),
      intervalMs: 60_000,
    });

    await scheduler.rebuildAutoCollections();
    assert.ok((await store.search('First knowledge')).some((item) => item.sourcePath === 'alpha.md'));

    writeFileSync(join(root, 'beta.md'), '# Beta\n\nFresh Obsidian note enters the refresh cycle.');
    const result = await scheduler.rebuildAutoCollections();

    assert.equal(result.rebuilt, 1);
    assert.ok(
      (await store.search('Fresh Obsidian')).some((item) => item.sourcePath === 'beta.md'),
      'new note should be searchable after the refresh cycle',
    );
  });

  it('does not rebuild collections with autoRebuild disabled', async () => {
    const { CollectionAutoRebuildScheduler } = await import(
      '../../dist/domains/memory/CollectionAutoRebuildScheduler.js'
    );
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const root = mkdtempSync(join(tmpdir(), 'collection-manual-root-'));
    writeFileSync(join(root, 'manual.md'), '# Manual\n\nManual-only collection.');

    const store = new InMemoryEvidenceStore();

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'domain:manual-only',
      kind: 'domain',
      name: 'manual-only',
      displayName: 'Manual Only',
      root,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const scheduler = new CollectionAutoRebuildScheduler({
      catalog,
      stores: new Map([['domain:manual-only', store]]),
      intervalMs: 60_000,
    });

    const result = await scheduler.rebuildAutoCollections();

    assert.equal(result.rebuilt, 0);
    assert.equal((await store.search('Manual-only')).length, 0);
  });

  it('keeps non-read-only collections out of the background cycle', async () => {
    const { CollectionAutoRebuildScheduler } = await import(
      '../../dist/domains/memory/CollectionAutoRebuildScheduler.js'
    );
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const root = mkdtempSync(join(tmpdir(), 'collection-project-root-'));
    writeFileSync(join(root, 'project.md'), '# Project\n\nProject collection should stay manual.');

    const store = new InMemoryEvidenceStore();
    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'project:manual-project',
      kind: 'project',
      name: 'manual-project',
      displayName: 'Manual Project',
      root,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const scheduler = new CollectionAutoRebuildScheduler({
      catalog,
      stores: new Map([['project:manual-project', store]]),
      intervalMs: 60_000,
    });

    const result = await scheduler.rebuildAutoCollections();

    assert.equal(result.eligible, 0);
    assert.equal((await store.search('Project collection')).length, 0);
  });
});

class InMemoryEvidenceStore {
  items = new Map();

  async search(query) {
    const needle = query.toLowerCase();
    return [...this.items.values()].filter((item) =>
      [item.title, item.summary, item.sourcePath, ...(item.keywords ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }

  async upsert(items) {
    for (const item of items) {
      this.items.set(item.anchor, item);
    }
  }

  async deleteByAnchor(anchor) {
    this.items.delete(anchor);
  }

  async getByAnchor(anchor) {
    return this.items.get(anchor) ?? null;
  }

  async health() {
    return true;
  }

  async initialize() {}

  getDb() {
    return {
      prepare: () => ({
        all: (likePattern) => {
          const prefix = String(likePattern).replace(/%$/, '');
          return [...this.items.keys()].filter((anchor) => anchor.startsWith(prefix)).map((anchor) => ({ anchor }));
        },
      }),
    };
  }
}
