import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalQuarantine = process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE;

describe('library rebuild route without sqlite', () => {
  let app;

  beforeEach(async () => {
    process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE = '1';

    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const root = mkdtempSync(join(tmpdir(), 'library-route-root-'));
    writeFileSync(join(root, 'safe.md'), '# Safe\n\nReusable workflow notes.');
    writeFileSync(join(root, 'secret.md'), '# Secret\n\napi_key = sk-abcdefghijklmnopqrstuvwxyz123456');

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'domain:route-rebuild',
      kind: 'domain',
      name: 'route-rebuild',
      displayName: 'Route Rebuild',
      root,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      readOnly: true,
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    app = Fastify();
    await app.register(libraryRoutes, {
      catalog,
      stores: new Map([['domain:route-rebuild', new InMemoryEvidenceStore()]]),
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (originalQuarantine === undefined) delete process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE;
    else process.env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE = originalQuarantine;
  });

  it('force rebuilds by default and returns quarantine details', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/library/domain:route-rebuild/rebuild' });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.indexed, 1);
    assert.equal(firstBody.quarantinedFiles.length, 1);
    assert.equal(firstBody.quarantinedFiles[0].path, 'secret.md');

    const second = await app.inject({ method: 'POST', url: '/api/library/domain:route-rebuild/rebuild' });
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.indexed, 1, 'manual route defaults to force=true');
    assert.equal(secondBody.skipped, 0);
  });

  it('validates force flag type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/domain:route-rebuild/rebuild',
      payload: { force: 'yes' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /force/);
  });

  it('rejects non-read-only collections to avoid project/global index pollution', async () => {
    const Fastify = (await import('fastify')).default;
    const { libraryRoutes } = await import('../../dist/routes/library.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const root = mkdtempSync(join(tmpdir(), 'library-route-project-root-'));
    writeFileSync(join(root, 'project.md'), '# Project\n\nProject notes.');

    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'project:cat-cafe',
      kind: 'project',
      name: 'cat-cafe',
      displayName: 'Project',
      root,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const projectApp = Fastify();
    await projectApp.register(libraryRoutes, {
      catalog,
      stores: new Map([['project:cat-cafe', new InMemoryEvidenceStore()]]),
    });
    await projectApp.ready();

    try {
      const res = await projectApp.inject({ method: 'POST', url: '/api/library/project:cat-cafe/rebuild' });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /read-only/);
    } finally {
      await projectApp.close();
    }
  });
});

class InMemoryEvidenceStore {
  items = new Map();

  async search() {
    return [...this.items.values()];
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
