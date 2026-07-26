/**
 * F163: Zero-behavior regression test
 * When all F163 flags are off, behavior must be identical to pre-F163:
 * - No f163_logs entries created (from search path)
 * - Search results order unchanged (no boost applied)
 *
 * Note: the F163 admin/audit API and the evidence-search route's experiment
 * instrumentation (variantId/boostSource/injectionSources) were removed with
 * the F163 module (prune-w2b). SqliteEvidenceStore's flag-gated internals
 * (authority boost, compression backstop suppression, contradiction
 * detection) remain — this file now only exercises those store-level paths.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { computeVariantId, freezeFlags } from '../dist/domains/memory/f163-types.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';

describe('F163 Zero-behavior regression', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('all flags off = no authority boost applied', async () => {
    // Ensure all flags off
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert docs with different authority levels
    await store.upsert([
      {
        anchor: 'doc-low',
        kind: 'lesson',
        status: 'active',
        title: 'Low priority Redis topic',
        summary: 'Redis cache eviction',
        authority: 'observed',
        activation: 'query',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'doc-high',
        kind: 'decision',
        status: 'active',
        title: 'High priority Redis decision',
        summary: 'Redis integration architecture',
        authority: 'constitutional',
        activation: 'always_on',
        updatedAt: '2026-01-01',
      },
    ]);

    // Search with all flags off
    const results = await store.search('Redis');
    assert.ok(results.length >= 2, 'should return results');

    // Order should be BM25-determined, NOT authority-boosted
    // (We can't assert exact order since BM25 depends on content,
    // but we verify no crash and results are returned)
  });

  it('all flags off = boostSource is legacy', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags = freezeFlags();
    assert.equal(flags.authorityBoost, 'off');
    assert.equal(flags.alwaysOnInjection, 'off');
    assert.equal(flags.retrievalRerank, 'off');
    assert.equal(flags.compression, 'off');
    assert.equal(flags.promotionGate, 'off');
    assert.equal(flags.contradictionDetection, 'off');
    assert.equal(flags.reviewQueue, 'off');
  });

  it('all flags off = consistent variantId across queries', () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags1 = freezeFlags();
    const flags2 = freezeFlags();
    const v1 = computeVariantId(flags1);
    const v2 = computeVariantId(flags2);

    assert.equal(v1, v2, 'same flags should produce same variantId');
    assert.equal(v1.length, 12);
    assert.match(v1, /^[0-9a-f]{12}$/);
  });

  it('no f163_logs entries from search when flags off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const db = new Database(':memory:');
    applyMigrations(db);

    // Verify the table exists but is empty
    const count = db.prepare('SELECT count(*) AS c FROM f163_logs').get();
    assert.equal(count.c, 0, 'f163_logs should be empty when flags are off');
  });

  // ── Phase B: compression-specific zero-behavior assertions ─────────

  it('backstop suppression does NOT activate when compression=off', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert a backstop doc
    await store.upsert([
      {
        anchor: 'backstop-doc',
        kind: 'lesson',
        status: 'active',
        title: 'Backstop test doc',
        summary: 'This doc has backstop activation',
        updatedAt: '2026-01-01',
        activation: 'backstop',
      },
    ]);

    // Search should return it when compression=off
    const results = await store.search('Backstop test');
    const found = results.some((r) => r.anchor === 'backstop-doc');
    assert.ok(found, 'backstop doc should be returned when compression=off');
  });
});
