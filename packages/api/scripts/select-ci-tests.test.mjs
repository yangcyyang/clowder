import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { discoverTests, parseCiTierHeader, parseSelectorArgs, selectTests } from './select-ci-tests.mjs';

function createFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'clowder-ci-selector-'));
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, source);
  }
  return root;
}

describe('parseCiTierHeader', () => {
  test('defaults untagged files to core', () => {
    assert.deepEqual(parseCiTierHeader("import test from 'node:test';\n", 'plain.test.js'), {
      tier: 'core',
      reason: null,
      tagged: false,
    });
  });

  test('parses a valid marker in the first twelve lines', () => {
    assert.deepEqual(parseCiTierHeader('// @ci-tier redis reason="requires isolated Redis"\n', 'redis.test.js'), {
      tier: 'redis',
      reason: 'requires isolated Redis',
      tagged: true,
    });
  });

  test('fails closed for unknown, duplicate, malformed, and reasonless markers', () => {
    assert.throws(
      () => parseCiTierHeader('// @ci-tier mystery reason="unknown"', 'unknown.test.js'),
      /unknown @ci-tier/,
    );
    assert.throws(
      () => parseCiTierHeader('// @ci-tier slow reason="one"\n// @ci-tier external reason="two"', 'duplicate.test.js'),
      /duplicate @ci-tier/,
    );
    assert.throws(() => parseCiTierHeader('// @ci-tier slow', 'reasonless.test.js'), /requires a non-empty reason/);
    assert.throws(() => parseCiTierHeader('// @ci-tier slow reason=oops', 'malformed.test.js'), /malformed/);
  });

  test('fails closed when a marker appears after the first twelve lines', () => {
    const source = `${Array.from({ length: 12 }, () => '// header').join('\n')}\n// @ci-tier slow reason="too late"`;
    assert.throws(() => parseCiTierHeader(source, 'late.test.js'), /must appear in the first 12 lines.*line 13/);
  });
});

describe('test discovery and selection', () => {
  test('recursively discovers test files with deterministic paths', async () => {
    const testDir = createFixture({
      'zeta.test.js': '// no tag',
      'nested/alpha.test.js': '// @ci-tier slow reason="timing sensitive"',
      'nested/not-a-test.js': '// ignored',
    });

    const discovered = await discoverTests({ testDir });
    assert.deepEqual(
      discovered.map(({ path, tier }) => ({ path, tier })),
      [
        { path: 'nested/alpha.test.js', tier: 'slow' },
        { path: 'zeta.test.js', tier: 'core' },
      ],
    );

    const selected = await selectTests({ tier: 'slow', testDir });
    assert.deepEqual(
      selected.selected.map(({ path }) => path),
      ['nested/alpha.test.js'],
    );
  });
});

describe('parseSelectorArgs', () => {
  test('supports tier, list, and json modes', () => {
    assert.deepEqual(parseSelectorArgs([]), { tier: 'core', format: 'summary' });
    assert.deepEqual(parseSelectorArgs(['--tier', 'redis', '--list']), { tier: 'redis', format: 'list' });
    assert.deepEqual(parseSelectorArgs(['--tier=slow', '--json']), { tier: 'slow', format: 'json' });
    assert.deepEqual(parseSelectorArgs(['--list', '--', '--tier', 'integration']), {
      tier: 'integration',
      format: 'list',
    });
  });

  test('rejects conflicting formats and unknown arguments', () => {
    assert.throws(() => parseSelectorArgs(['--list', '--json']), /mutually exclusive/);
    assert.throws(() => parseSelectorArgs(['--wat']), /unknown argument/);
  });
});
