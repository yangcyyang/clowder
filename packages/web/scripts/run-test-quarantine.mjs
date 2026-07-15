#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareFailureSignatures,
  compareTestFileCounts,
  discoverVitestFiles,
  failureSignaturesFromManifest,
  failureSignaturesFromVitestJson,
  testFileCountsFromVitestJson,
  validateManifest,
} from './test-quarantine-lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const manifestPath = resolve(webRoot, 'test', 'quarantine-manifest.json');
const wrapperPath = resolve(scriptDir, 'run-with-node-env-test.mjs');
const forbiddenExtraFlags = ['--passWithNoTests', '--exclude', '--reporter', '--outputFile'];
const globMeta = new Set('*?[]{}!');

function isForbiddenExtraArg(arg) {
  return (
    forbiddenExtraFlags.some((flag) => arg.includes(flag)) || [...arg].some((character) => globMeta.has(character))
  );
}

function usage() {
  console.error('Usage: node scripts/run-test-quarantine.mjs <validate|blocking|quarantine> [-- <vitest args>]');
}

function runVitest(files, extraArgs, reporterArgs = []) {
  if (files.length === 0) throw new Error('refusing to run Vitest with an empty exact file list');
  for (const arg of extraArgs) {
    if (isForbiddenExtraArg(arg)) throw new Error(`forbidden Vitest argument: ${arg}`);
  }
  return spawnSync(
    process.execPath,
    [wrapperPath, 'pnpm', 'exec', 'vitest', 'run', ...files, ...extraArgs, ...reporterArgs],
    { cwd: webRoot, env: process.env, stdio: 'inherit' },
  );
}

function printSignatures(label, values) {
  if (values.length === 0) return;
  console.error(`${label}:`);
  for (const value of values) {
    console.error(`- ${value.relativeFile} :: ${value.fullName} :: ${value.failureKind}`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this CLI fail-closes across three explicit modes and their ratchet diagnostics.
function main() {
  const [mode, separator, ...rest] = process.argv.slice(2);
  if (!mode || !['validate', 'blocking', 'quarantine'].includes(mode)) {
    usage();
    return 2;
  }
  if (separator && separator !== '--') {
    usage();
    return 2;
  }
  const extraArgs = separator === '--' ? rest : [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const totals = validateManifest(manifest, { webRoot });

  if (mode === 'validate') {
    console.log(
      `Web quarantine manifest valid: ${totals.files} files / ${totals.tests} tests / ${totals.failures} failures`,
    );
    return 0;
  }

  const quarantineFiles = manifest.entries.map((entry) => entry.relativeFile).sort();
  if (mode === 'blocking') {
    const quarantined = new Set(quarantineFiles);
    const blockingFiles = discoverVitestFiles(webRoot).filter((file) => !quarantined.has(file));
    const result = runVitest(blockingFiles, extraArgs);
    return result.status ?? 2;
  }

  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'clowder-web-quarantine-'));
  const reportPath = resolve(tempDirectory, 'vitest-report.json');
  try {
    const result = runVitest(quarantineFiles, extraArgs, ['--reporter=json', `--outputFile=${reportPath}`]);
    if (result.status !== 0 && result.status !== 1) {
      console.error(`Vitest quarantine infrastructure failed with exit ${result.status ?? 'unknown'}`);
      return 2;
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const expectedFileCounts = manifest.entries.map((entry) => ({
      relativeFile: entry.relativeFile,
      testCount: entry.testCount,
    }));
    const actualFileCounts = testFileCountsFromVitestJson(report, { webRoot });
    const shapeComparison = compareTestFileCounts(expectedFileCounts, actualFileCounts);
    if (!shapeComparison.pass) {
      for (const relativeFile of shapeComparison.missingFiles)
        console.error(`Missing quarantine file: ${relativeFile}`);
      for (const relativeFile of shapeComparison.unexpectedFiles) {
        console.error(`Unexpected quarantine file: ${relativeFile}`);
      }
      for (const change of shapeComparison.countChanged) {
        console.error(`Test count changed: ${change.relativeFile} :: ${change.expected} -> ${change.actual}`);
      }
      for (const relativeFile of shapeComparison.duplicates)
        console.error(`Duplicate quarantine file: ${relativeFile}`);
      return 1;
    }

    const expected = failureSignaturesFromManifest(manifest);
    const actual = failureSignaturesFromVitestJson(report, { webRoot });
    const comparison = compareFailureSignatures(expected, actual);
    if (!comparison.pass) {
      printSignatures('Unexpected failures', comparison.unexpected);
      printSignatures('Resolved failures still present in manifest', comparison.resolved);
      for (const change of comparison.kindChanged) {
        console.error(
          `Failure kind changed: ${change.expected.relativeFile} :: ${change.expected.fullName} :: ${change.expected.failureKind} -> ${change.actual.failureKind}`,
        );
      }
      printSignatures('Duplicate failure identities', comparison.duplicates);
      return 1;
    }

    console.log(
      `Web quarantine ratchet matched exactly: ${totals.files} files / ${totals.tests} tests / ${actual.length} failures`,
    );
    return 0;
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
