/**
 * P0-1 (2026-07-23 optimization report §3): handoff-index truncation direction was reversed.
 * Entries are appended to the tail (newest last) via `appendFile`, but the read path truncated
 * via `raw.slice(0, maxChars)` (keeping the head) — every prompt injection showed the OLDEST
 * entries while the most recent handoffs were silently cut off.
 *
 * RED-first: write enough real entries via the real `writeContextHandoffForPromptProjects` to
 * exceed the max-chars budget, then assert the read path returns the newest entries, each kept
 * whole (no mid-entry cut, no reordering) — not just "flip slice(0,n) to slice(-n)" blindly,
 * since that could still slice through the middle of an entry.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

async function importStore() {
  return import('../dist/domains/cats/services/agents/memory/ProjectProgressStore.js');
}

async function writeEntries(writeContextHandoffForPromptProjects, root, count) {
  for (let i = 0; i < count; i++) {
    const day = String(i + 1).padStart(2, '0');
    await writeContextHandoffForPromptProjects(
      {
        timestamp: `2026-07-${day}T10:00:00.000Z`,
        threadId: `thread-${i}`,
        catId: 'codex',
        fromSessionId: `session-${i}`,
        reason: 'threshold',
        trust: 'trusted',
        what: `ENTRY_MARKER_${i}: did some work in round ${i}`,
        next: `continue round ${i + 1}`,
      },
      ['demo'],
      root,
    );
  }
}

describe('P0-1: handoff-index truncation keeps the most recent entries', () => {
  test('readProjectHandoffIndex returns the newest entries, not the oldest, when the file exceeds the budget', async () => {
    const { writeContextHandoffForPromptProjects, readProjectHandoffIndex, PROJECT_HANDOFF_INDEX_MAX_CHARS } =
      await importStore();
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-handoff-truncation-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });

      // Each entry is roughly 300-400 chars; 40 entries comfortably exceeds the 6000-char budget.
      await writeEntries(writeContextHandoffForPromptProjects, root, 40);

      const raw = await readFile(resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-index.md'), 'utf-8');
      assert.ok(raw.length > PROJECT_HANDOFF_INDEX_MAX_CHARS, 'fixture must exceed the max-chars budget');
      assert.ok(raw.includes('ENTRY_MARKER_0'), 'raw file must contain the oldest entry (write-side sanity check)');
      assert.ok(raw.includes('ENTRY_MARKER_39'), 'raw file must contain the newest entry (write-side sanity check)');

      const record = await readProjectHandoffIndex('demo', root);
      assert.ok(record.truncated, 'record should report truncation happened');

      // The core bug: injected content must be the NEWEST entries, not the oldest.
      assert.ok(
        record.content.includes('ENTRY_MARKER_39'),
        'the most recent entry (39) must be present in the injected content',
      );
      assert.ok(
        !record.content.includes('ENTRY_MARKER_0'),
        'the oldest entry (0) must NOT be present — it should have been dropped, not the newest',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('kept entries are whole — never cut mid-entry, and stay in chronological order', async () => {
    const { writeContextHandoffForPromptProjects, readProjectHandoffIndex } = await importStore();
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-handoff-truncation-order-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeEntries(writeContextHandoffForPromptProjects, root, 40);

      const record = await readProjectHandoffIndex('demo', root);

      // Every entry marker that appears must have its full formatted block — heading through
      // the refs list — not a fragment cut off mid-field.
      const markers = [...record.content.matchAll(/ENTRY_MARKER_(\d+)/g)].map((m) => Number(m[1]));
      assert.ok(markers.length >= 2, 'should keep more than one entry given the fixture size');

      // Regression: HANDOFF_ENTRY_DELIMITER already ends in "## " — reconstructing entries must
      // not re-add it (caught in review: doubled into "## ## " heading markup on every kept entry).
      assert.ok(!record.content.includes('## ## '), 'reconstructed entries must not double the "## " heading marker');

      for (const n of new Set(markers)) {
        const entryHeading = new RegExp(
          `## 2026-07-${String(n + 1).padStart(2, '0')}T10:00:00\\.000Z · context-handoff`,
        );
        assert.ok(entryHeading.test(record.content), `entry ${n}'s heading line must be intact`);
        assert.ok(
          record.content.includes(`- **refs**:`),
          'kept entries must retain their trailing refs section (proves the entry was not cut mid-body)',
        );
      }

      // Chronological order preserved among kept entries (ascending, oldest-of-the-kept first).
      const sorted = [...markers].sort((a, b) => a - b);
      assert.deepEqual(markers, sorted, 'kept entries must remain in original chronological order');

      // Highest-numbered marker present must be the very last one written (39).
      assert.equal(Math.max(...markers), 39, 'the newest entry must be the last one kept');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('budget is a hard upper bound — even when the single newest entry alone exceeds it, content is capped, not injected whole', async () => {
    // Caught in review: an entry's `refs` field is an unbounded array, so a single entry can
    // itself blow the budget (repro found 10583 chars vs a 6000-char budget = 76% over).
    const { writeContextHandoffForPromptProjects, readProjectHandoffIndex, PROJECT_HANDOFF_INDEX_MAX_CHARS } =
      await importStore();
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-handoff-truncation-single-oversized-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });

      const hugeRefs = Array.from({ length: 200 }, (_, i) => `ref-${i}-${'x'.repeat(40)}`);
      await writeContextHandoffForPromptProjects(
        {
          timestamp: '2026-08-01T10:00:00.000Z',
          threadId: 'thread-oversized',
          catId: 'codex',
          fromSessionId: 'session-oversized',
          reason: 'threshold',
          trust: 'trusted',
          what: 'ENTRY_MARKER_OVERSIZED: a single entry with an unbounded refs list',
          refs: hugeRefs,
        },
        ['demo'],
        root,
      );

      const raw = await readFile(resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-index.md'), 'utf-8');
      assert.ok(
        raw.length > PROJECT_HANDOFF_INDEX_MAX_CHARS,
        'fixture entry alone must exceed the max-chars budget to exercise the hard-cap path',
      );

      const record = await readProjectHandoffIndex('demo', root);
      assert.ok(
        record.content.length <= PROJECT_HANDOFF_INDEX_MAX_CHARS,
        `content length (${record.content.length}) must not exceed the max-chars budget (${PROJECT_HANDOFF_INDEX_MAX_CHARS}) even for a single oversized entry`,
      );
      assert.ok(record.content.includes('ENTRY_MARKER_OVERSIZED'), 'the truncated entry heading must still be present');
      assert.ok(record.content.includes('已截尾'), 'the per-entry truncation must be marked, not silent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('readProjectHandoffIndexesForBootstrap also carries the newest entries after truncation', async () => {
    const { writeContextHandoffForPromptProjects, readProjectHandoffIndexesForBootstrap } = await importStore();
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-handoff-truncation-bootstrap-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeEntries(writeContextHandoffForPromptProjects, root, 40);

      const content = await readProjectHandoffIndexesForBootstrap(['demo'], root);
      assert.ok(content?.includes('ENTRY_MARKER_39'), 'bootstrap block must include the newest entry');
      assert.ok(!content?.includes('ENTRY_MARKER_0'), 'bootstrap block must not include the oldest entry');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('files without recognizable entry structure fall back to the previous head-truncation behavior', async () => {
    // readProjectFile itself is not exported; exercise the fallback through readProjectBrief,
    // which shares the same generic truncation and must be unaffected by this fix (freeform docs,
    // not an append-only entry log — head-truncation there is unchanged, intentional behavior).
    const { readProjectBrief, PROJECT_BRIEF_MAX_CHARS } = await importStore();
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-handoff-truncation-brief-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      const long = 'A'.repeat(PROJECT_BRIEF_MAX_CHARS + 500);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(root, '.cat-cafe', 'projects', 'demo', 'brief.md'), long, 'utf-8');

      const record = await readProjectBrief('demo', root);
      assert.ok(record.truncated);
      assert.ok(
        record.content.startsWith('A'.repeat(50)),
        'brief.md truncation must remain head-preserving (unchanged behavior)',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
