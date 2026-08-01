import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

describe('Query Capture — collection routing metadata (AC-E1)', () => {
  let app;
  let db;
  let capturedQuery;
  let capturedOptions;

  beforeEach(() => {
    process.env.F163_AUTHORITY_BOOST = 'on';
    capturedQuery = undefined;
    capturedOptions = undefined;
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS f163_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        effective_flags TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS f163_cohorts (
        thread_id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL
      );
    `);
  });

  afterEach(async () => {
    delete process.env.F163_AUTHORITY_BOOST;
    if (app) await app.close();
    if (db) db.close();
  });

  function mockStore() {
    return {
      search: async () => [
        { anchor: 'test:a', kind: 'feature', status: 'active', title: 'A', updatedAt: '2026-01-01' },
      ],
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
      getDb: () => db,
    };
  }

  function mockResolver() {
    return {
      resolve: async (query, opts) => {
        capturedQuery = query;
        capturedOptions = opts;
        return {
          results: [
            {
              anchor: 'world:lexander:doc/lore',
              kind: 'lore',
              status: 'active',
              title: 'Lore',
              updatedAt: '2026-01-01',
            },
            {
              anchor: 'project:cat-cafe:doc/f186',
              kind: 'feature',
              status: 'active',
              title: 'F186',
              updatedAt: '2026-01-01',
            },
          ],
          sources: ['project'],
          query,
          collectionGroups: [
            {
              collectionId: 'world:lexander',
              sensitivity: 'private',
              status: 'ok',
              durationMs: 5,
              items: [
                {
                  anchor: 'world:lexander:doc/lore',
                  kind: 'lore',
                  status: 'active',
                  title: 'Lore',
                  updatedAt: '2026-01-01',
                },
              ],
            },
            {
              collectionId: 'project:cat-cafe',
              sensitivity: 'internal',
              status: 'ok',
              durationMs: 3,
              items: [
                {
                  anchor: 'project:cat-cafe:doc/f186',
                  kind: 'feature',
                  status: 'active',
                  title: 'F186',
                  updatedAt: '2026-01-01',
                },
              ],
            },
          ],
        };
      },
    };
  }

  it('forwards scope, dimension, and collections to the resolver and returns collection summaries', async () => {
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    app = Fastify();
    await app.register(evidenceRoutes, {
      hindsightClient: {
        recall: async () => [],
        retain: async () => {},
        reflect: async () => '',
        ensureBank: async () => {},
        isHealthy: async () => true,
      },
      sharedBank: 'test',
      evidenceStore: mockStore(),
      knowledgeResolver: mockResolver(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/evidence/search?q=lore&scope=docs&dimension=library&collections=world:lexander,project:cat-cafe',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedQuery, 'lore');
    assert.equal(capturedOptions.scope, 'docs');
    assert.equal(capturedOptions.dimension, 'library');
    assert.deepEqual(capturedOptions.collections, ['world:lexander', 'project:cat-cafe']);

    const body = JSON.parse(res.body);
    assert.deepEqual(body.collectionGroups, [
      { collectionId: 'world:lexander', sensitivity: 'private', status: 'ok', itemCount: 1, durationMs: 5 },
      { collectionId: 'project:cat-cafe', sensitivity: 'internal', status: 'ok', itemCount: 1, durationMs: 3 },
    ]);
  });
});
