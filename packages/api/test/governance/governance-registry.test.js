import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

describe('GovernanceRegistry', () => {
  let tmpDir;
  let registry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gov-registry-'));
    registry = new GovernanceRegistry(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeMeta = (version = '1.0.0') => ({
    packVersion: version,
    checksum: 'abc123def456',
    syncedAt: Date.now(),
    confirmedByUser: true,
  });

  it('registers a new project', async () => {
    await registry.register('/path/to/project', makeMeta());
    const entry = await registry.get('/path/to/project');
    assert.ok(entry);
    assert.strictEqual(entry.packVersion, '1.0.0');
    assert.strictEqual(entry.confirmedByUser, true);
  });

  it('returns undefined for unknown project', async () => {
    const entry = await registry.get('/nonexistent');
    assert.strictEqual(entry, undefined);
  });

  it('updates existing project on re-register', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    await registry.register('/a', makeMeta('2.0.0'));
    const entry = await registry.get('/a');
    assert.strictEqual(entry.packVersion, '2.0.0');
    const all = await registry.listAll();
    assert.strictEqual(all.length, 1);
  });

  it('lists all registered projects', async () => {
    await registry.register('/a', makeMeta());
    await registry.register('/b', makeMeta());
    await registry.register('/c', makeMeta());
    const all = await registry.listAll();
    assert.strictEqual(all.length, 3);
  });

  it('checkHealth returns never-synced for unknown project', async () => {
    const health = await registry.checkHealth('/unknown');
    assert.strictEqual(health.status, 'never-synced');
    assert.strictEqual(health.packVersion, null);
  });

  it('checkHealth returns healthy for matching version', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    const health = await registry.checkHealth('/a', '1.0.0');
    assert.strictEqual(health.status, 'healthy');
  });

  it('checkHealth returns stale for version mismatch', async () => {
    await registry.register('/a', makeMeta('0.9.0'));
    const health = await registry.checkHealth('/a', '1.0.0');
    assert.strictEqual(health.status, 'stale');
  });

  it('empty registry returns empty list', async () => {
    const all = await registry.listAll();
    assert.strictEqual(all.length, 0);
  });

  it('lookup works with Windows-style backslash paths', async () => {
    await registry.register('C:\\Users\\Dev\\project', makeMeta('1.0.0'));
    const entry = await registry.get('C:\\Users\\Dev\\project');
    assert.ok(entry, 'should find entry with backslash path');
    assert.strictEqual(entry.packVersion, '1.0.0');
    // Case-insensitive matching is tested in project-path.test.js via pathsEqual(a, b, 'win32')
  });

  it('re-register with same path updates entry instead of duplicating', async () => {
    await registry.register('/projects/alpha', makeMeta('1.0.0'));
    await registry.register('/projects/alpha', makeMeta('2.0.0'));
    const all = await registry.listAll();
    const matches = all.filter((e) => e.projectPath === '/projects/alpha');
    assert.strictEqual(matches.length, 1, 'should have exactly 1 entry, not duplicate');
    assert.strictEqual(matches[0].packVersion, '2.0.0');
  });

  // ─── batch 4-A / A3: registry query resilience (real incident — "designe agent" ───
  // project, confirmed via /api/governance/confirm at some point, later queried as
  // needs_bootstrap by checkGovernancePreflight() because GovernanceRegistry.get()
  // returned undefined for a project that WAS registered. Two independently
  // reproducible root causes found in governance-registry.ts's current code:
  // (1) register() does an unguarded read-modify-write on the single JSON file —
  //     concurrent register() calls silently lose whichever entry was added by the
  //     call whose write lost the race (classic lost-update); production log shows
  //     five projects registered within under a minute (11:42:43-11:43:29 UTC),
  //     exactly the shape that triggers this.
  // (2) read() swallows EVERY readFile error (ENOENT alike EPERM/EACCES) into an
  //     empty {entries:[]} — indistinguishable from "genuinely nothing registered
  //     yet", which is exactly the ambiguity checkGovernancePreflight()'s
  //     "Governance not bootstrapped... Use POST /api/governance/confirm" message
  //     reports whenever the registry file itself is transiently unreadable.

  it('A3 (race): concurrent register() calls for DIFFERENT projects must not lose either entry', async () => {
    // governance/confirm is a fire-and-forget POST per request — two projects
    // confirmed close together is a realistic production shape, not a contrived one.
    await Promise.all([
      registry.register('/projects/race-a', makeMeta('1.0.0')),
      registry.register('/projects/race-b', makeMeta('1.0.0')),
    ]);
    const a = await registry.get('/projects/race-a');
    const b = await registry.get('/projects/race-b');
    assert.ok(a, 'race-a must survive a concurrent register() (lost-update regression)');
    assert.ok(b, 'race-b must survive a concurrent register() (lost-update regression)');
    const all = await registry.listAll();
    assert.strictEqual(all.length, 2, 'both entries must be persisted, not just the last writer');
  });

  it('A3 (race): many concurrent register() calls for distinct projects all survive', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/projects/concurrent-${i}`);
    await Promise.all(paths.map((p) => registry.register(p, makeMeta('1.0.0'))));
    const all = await registry.listAll();
    assert.strictEqual(all.length, 12, `expected all 12 concurrent registrations to survive, got ${all.length}`);
    for (const p of paths) {
      assert.ok(await registry.get(p), `${p} must be registered`);
    }
  });

  it('A3 (EPERM honesty): read() must not silently report "not registered" when the registry file itself is unreadable', async () => {
    await registry.register('/a', makeMeta('1.0.0'));
    const registryFile = join(tmpDir, '.cat-cafe', 'governance-registry.json');
    await chmod(registryFile, 0o000);
    try {
      await assert.rejects(
        () => registry.get('/a'),
        'get() must throw/reject on an unreadable registry file instead of returning undefined ' +
          '(undefined is indistinguishable from "genuinely never registered" — see checkGovernancePreflight\'s ' +
          'needs_bootstrap message, which is wrong here: the project WAS confirmed, we just cannot read the proof)',
      );
    } finally {
      await chmod(registryFile, 0o644); // restore so afterEach's rm() can clean up
    }
  });

  it('A3 (EPERM honesty): a genuinely missing registry file (first-time use, ENOENT) still returns an empty registry, not an error', async () => {
    // Sanity companion to the EPERM test above: ENOENT must stay silent/empty
    // (first Clowder run, no project ever registered yet) — only unexpected errors
    // (EPERM/EACCES/etc.) must surface as a distinguishable failure.
    const entry = await registry.get('/never-registered');
    assert.strictEqual(entry, undefined);
    const all = await registry.listAll();
    assert.strictEqual(all.length, 0);
  });

  it('A3 (pure-string normalization): a trailing slash must not defeat lookup', async () => {
    await registry.register('/projects/trailing/', makeMeta('1.0.0'));
    const entry = await registry.get('/projects/trailing');
    assert.ok(entry, 'query without trailing slash must find an entry registered with one');
  });

  it('A3 (pure-string normalization): registering with and without a trailing slash must not create a duplicate entry', async () => {
    await registry.register('/projects/dup', makeMeta('1.0.0'));
    await registry.register('/projects/dup/', makeMeta('2.0.0'));
    const all = await registry.listAll();
    const matches = all.filter((e) => e.projectPath.replace(/\/$/, '') === '/projects/dup');
    assert.strictEqual(matches.length, 1, 'trailing-slash variant must update the same entry, not duplicate it');
    assert.strictEqual(matches[0].packVersion, '2.0.0');
  });
});
