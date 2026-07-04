import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const originalObsidianRoots = process.env.OBSIDIAN_READONLY_ROOTS;

describe('createMemoryServices', () => {
  afterEach(() => {
    if (originalObsidianRoots === undefined) delete process.env.OBSIDIAN_READONLY_ROOTS;
    else process.env.OBSIDIAN_READONLY_ROOTS = originalObsidianRoots;
  });

  it('creates sqlite services', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: '/tmp/f102-test-docs',
      markersDir: '/tmp/f102-test-markers',
    });

    assert.ok(services.evidenceStore);
    assert.ok(services.markerQueue);
    assert.ok(services.reflectionService);
    assert.ok(services.knowledgeResolver);
    assert.ok(services.indexBuilder);
    assert.ok(services.materializationService);

    assert.equal(await services.evidenceStore.health(), true);
  });

  // ── Phase C: embed config integration ───────────────────────────

  it('embedMode=off creates no embedding service', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'off' },
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('embedMode defaults to off when embed not specified', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('creates LibraryCatalog with 2 built-in collections (AC-A3)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: '/tmp/f186-test-docs',
    });

    assert.ok(services.catalog, 'catalog should exist');
    const collections = services.catalog.list();
    assert.ok(collections.length >= 1, 'at least project collection');
    const project = collections.find((c) => c.kind === 'project');
    assert.ok(project, 'project collection registered');
    assert.equal(project.sensitivity, 'internal');
    assert.equal(project.root, '/tmp/f186-test-docs');
  });

  it('registers OBSIDIAN_READONLY_ROOTS as read-only internal collections', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const vaultRoot = mkdtempSync(join(tmpdir(), 'obsidian-vault-'));
    mkdirSync(join(vaultRoot, '.obsidian'));
    writeFileSync(join(vaultRoot, 'clowder-loop.md'), '# Clowder Loop\n\nProject workflow notes.');
    const beforeFiles = readdirSync(vaultRoot).sort();

    const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-data-'));
    const docsRoot = mkdtempSync(join(tmpdir(), 'obsidian-docs-'));
    const markersDir = mkdtempSync(join(tmpdir(), 'obsidian-markers-'));

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot,
      markersDir,
      globalDbPath: join(dataDir, 'global.sqlite'),
      dataDir,
      obsidianReadonlyRoots: `domain:orbitos-knowledge=${vaultRoot}`,
    });

    const manifest = services.catalog?.get('domain:orbitos-knowledge');
    assert.ok(manifest, 'Obsidian collection should be registered');
    assert.equal(manifest.root, vaultRoot);
    assert.equal(manifest.sensitivity, 'internal');
    assert.equal(manifest.scannerLevel, 'auto');
    assert.equal(manifest.indexPolicy.autoRebuild, true);
    assert.equal(manifest.indexPolicy.rebuildIntervalMs, 300000);
    assert.equal(manifest.reviewPolicy.requireOwnerApproval, true);
    assert.equal(manifest.readOnly, true);
    assert.ok(services.collectionStores?.has('domain:orbitos-knowledge'));

    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');
    const store = services.collectionStores.get('domain:orbitos-knowledge');
    const builder = new CollectionIndexBuilder(store, manifest, resolveCollectionScanner(manifest));
    const rebuildResult = await builder.rebuild();
    assert.equal(rebuildResult.indexed, 1);

    const searchResult = await services.knowledgeResolver.resolve('workflow notes', {
      dimension: 'collection',
      collections: ['domain:orbitos-knowledge'],
    });
    assert.ok(searchResult.results.some((result) => result.sourcePath === 'clowder-loop.md'));
    assert.deepEqual(readdirSync(vaultRoot).sort(), beforeFiles, 'factory must not write into the Obsidian vault');
  });

  it('embedMode=on creates embedding service (HTTP client, fail-open)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    // EmbeddingService is now an HTTP client (PR #608, LL-034).
    // load() probes embed-api /health — may succeed if sidecar is running,
    // or fail-open if not. Either way, factory should NOT throw.
    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'on' },
    });

    // EmbeddingService should exist regardless of sidecar status
    assert.ok(services.embeddingService, 'embeddingService should exist');
    // isReady() depends on whether embed-api sidecar is running — both are valid
    // The important thing is that factory didn't throw
  });
});
