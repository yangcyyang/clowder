import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertRunnerPreconditions, buildLaneSpawnSpec, parseRunnerArgs } from './run-test-lane.mjs';

describe('parseRunnerArgs', () => {
  test('defaults core to deterministic single-worker execution', () => {
    assert.deepEqual(parseRunnerArgs([]), { tier: 'core', concurrency: 1, timeoutMs: 120_000 });
  });

  test('accepts explicit lane controls', () => {
    assert.deepEqual(parseRunnerArgs(['--', '--tier=redis', '--concurrency', '2', '--timeout=90000']), {
      tier: 'redis',
      concurrency: 2,
      timeoutMs: 90_000,
    });
  });

  test('rejects invalid values', () => {
    assert.throws(() => parseRunnerArgs(['--tier', 'unknown']), /unknown tier/);
    assert.throws(() => parseRunnerArgs(['--concurrency', '0']), /positive integer/);
    assert.throws(() => parseRunnerArgs(['--timeout', 'nope']), /positive integer/);
  });
});

describe('assertRunnerPreconditions', () => {
  test('accepts Node 20 and rejects older runtimes', () => {
    assert.throws(() => assertRunnerPreconditions({ tier: 'core', nodeVersion: '19.9.0', env: {} }), /Node\.js >=20/);
    assert.doesNotThrow(() => assertRunnerPreconditions({ tier: 'core', nodeVersion: '20.19.0', env: {} }));
  });

  test('fails closed for external tests without explicit opt-in', () => {
    assert.throws(
      () => assertRunnerPreconditions({ tier: 'external', nodeVersion: '20.19.0', env: {} }),
      /RUN_EXTERNAL_TESTS=1/,
    );
    assert.doesNotThrow(() =>
      assertRunnerPreconditions({ tier: 'external', nodeVersion: '20.19.0', env: { RUN_EXTERNAL_TESTS: '1' } }),
    );
  });
});

describe('buildLaneSpawnSpec', () => {
  test('routes redis through with-test-home and the isolated Redis harness', () => {
    const spec = buildLaneSpawnSpec({
      tier: 'redis',
      nodeBinary: '/opt/node20/bin/node',
      nodeArgs: ['--test', '/repo/test/redis-store.test.js'],
    });

    assert.equal(spec.command, 'bash');
    assert.match(spec.args[0], /with-test-home\.sh$/);
    assert.equal(spec.args[1], 'bash');
    assert.match(spec.args[2], /run-isolated-redis-tests\.sh$/);
    assert.deepEqual(spec.args.slice(3), ['--', '/opt/node20/bin/node', '--test', '/repo/test/redis-store.test.js']);
  });

  test('runs non-redis lanes directly inside with-test-home', () => {
    const spec = buildLaneSpawnSpec({ tier: 'core', nodeBinary: '/node20', nodeArgs: ['--test', 'a.test.js'] });
    assert.match(spec.args[0], /with-test-home\.sh$/);
    assert.deepEqual(spec.args.slice(1), ['/node20', '--test', 'a.test.js']);
    assert.equal(
      spec.args.some((argument) => argument.includes('run-isolated-redis-tests.sh')),
      false,
    );
  });
});
