import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareFailureSignatures,
  compareTestFileCounts,
  failureSignaturesFromVitestJson,
  validateManifest,
} from '../scripts/test-quarantine-lib.mjs';

const failure = {
  relativeFile: 'src/components/__tests__/example.test.ts',
  fullName: 'Example behaves predictably',
  failureKind: 'assertion:contains',
};

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    expectedTotals: { files: 1, tests: 2, failures: 1 },
    entries: [
      {
        relativeFile: failure.relativeFile,
        owner: '@yangcyyang',
        reason: 'Tracked product-contract debt.',
        expiry: '2026-07-29',
        testCount: 2,
        failures: [{ fullName: failure.fullName, failureKind: failure.failureKind }],
      },
    ],
    ...overrides,
  };
}

const validateOptions = {
  webRoot: '/tmp/packages/web',
  now: new Date('2026-07-15T00:00:00Z'),
  fileExists: () => true,
};

test('exact failure signature set passes', () => {
  const result = compareFailureSignatures([failure], [failure]);
  assert.equal(result.pass, true);
});

test('unexpected failure fails closed', () => {
  const unexpected = { ...failure, fullName: 'A newly failing test' };
  const result = compareFailureSignatures([failure], [failure, unexpected]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.unexpected, [unexpected]);
});

test('resolved failure fails closed until the manifest is reduced', () => {
  const result = compareFailureSignatures([failure], []);
  assert.equal(result.pass, false);
  assert.deepEqual(result.resolved, [failure]);
});

test('failure kind change is reported separately', () => {
  const changed = { ...failure, failureKind: 'runtime:null-property-access' };
  const result = compareFailureSignatures([failure], [changed]);
  assert.equal(result.pass, false);
  assert.equal(result.kindChanged[0].actual.failureKind, changed.failureKind);
});

test('expired manifest is rejected', () => {
  const expired = manifest();
  expired.entries[0].expiry = '2026-07-14';
  assert.throws(() => validateManifest(expired, validateOptions), /expired on 2026-07-14/);
});

test('duplicate failure identity is rejected', () => {
  const duplicate = manifest();
  duplicate.entries[0].failures.push({ ...duplicate.entries[0].failures[0] });
  duplicate.expectedTotals.failures = 2;
  assert.throws(() => validateManifest(duplicate, validateOptions), /duplicate failure/);
});

test('valid manifest reports exact aggregate counts', () => {
  assert.deepEqual(validateManifest(manifest(), validateOptions), { files: 1, tests: 2, failures: 1 });
});

test('relative Vitest result paths resolve from webRoot instead of process cwd', () => {
  const signatures = failureSignaturesFromVitestJson(
    {
      testResults: [
        {
          name: failure.relativeFile,
          assertionResults: [
            {
              status: 'failed',
              fullName: failure.fullName,
              failureMessages: ["AssertionError: expected 'actual' to contain 'expected'"],
            },
          ],
        },
      ],
    },
    { webRoot: '/repo/packages/web' },
  );
  assert.deepEqual(signatures, [failure]);
});

test('quarantine report fails when an exact file test count changes', () => {
  const result = compareTestFileCounts(
    [{ relativeFile: failure.relativeFile, testCount: 2 }],
    [{ relativeFile: failure.relativeFile, testCount: 3 }],
  );
  assert.equal(result.pass, false);
  assert.deepEqual(result.countChanged, [{ relativeFile: failure.relativeFile, expected: 2, actual: 3 }]);
});

test('quarantine report fails when the exact file set changes', () => {
  const result = compareTestFileCounts(
    [{ relativeFile: failure.relativeFile, testCount: 2 }],
    [{ relativeFile: 'src/components/__tests__/other.test.ts', testCount: 2 }],
  );
  assert.equal(result.pass, false);
  assert.deepEqual(result.missingFiles, [failure.relativeFile]);
  assert.deepEqual(result.unexpectedFiles, ['src/components/__tests__/other.test.ts']);
});
