#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CI_TIERS, selectTests } from './select-ci-tests.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(SCRIPT_DIR, '..');
const WITH_TEST_HOME = resolve(SCRIPT_DIR, 'with-test-home.sh');
const ISOLATED_REDIS_HARNESS = resolve(SCRIPT_DIR, 'run-isolated-redis-tests.sh');
const SETUP_IMPORT = resolve(API_DIR, 'test/helpers/setup-cat-registry.js');
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(value);
}

function parseValueOption(args, index) {
  const argument = args[index];
  const separatorIndex = argument.indexOf('=');
  const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
  const inlineValue = separatorIndex === -1 ? null : argument.slice(separatorIndex + 1);
  const supportedFlags = new Set(['--tier', '--concurrency', '--timeout']);
  if (!supportedFlags.has(flag)) {
    throw new Error(`unknown argument "${argument}"`);
  }

  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return { flag, value, consumed: inlineValue === null ? 2 : 1 };
}

function applyRunnerOption(options, { flag, value }) {
  if (flag === '--tier') return { ...options, tier: value };
  if (flag === '--concurrency') {
    return { ...options, concurrency: parsePositiveInteger(value, flag) };
  }
  return { ...options, timeoutMs: parsePositiveInteger(value, flag) };
}

export function parseRunnerArgs(args) {
  let options = { tier: 'core', concurrency: DEFAULT_CONCURRENCY, timeoutMs: DEFAULT_TIMEOUT_MS };

  for (let index = 0; index < args.length; ) {
    if (args[index] === '--') {
      index += 1;
      continue;
    }
    const parsed = parseValueOption(args, index);
    options = applyRunnerOption(options, parsed);
    index += parsed.consumed;
  }

  if (!CI_TIERS.includes(options.tier)) {
    throw new Error(`unknown tier "${options.tier}"; expected one of ${CI_TIERS.join(', ')}`);
  }
  return options;
}

export function assertRunnerPreconditions({ tier, nodeVersion = process.versions.node, env = process.env }) {
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`test lanes require Node.js >=20; received ${nodeVersion}`);
  }
  if (tier === 'external' && env.RUN_EXTERNAL_TESTS !== '1') {
    throw new Error('external lane requires RUN_EXTERNAL_TESTS=1');
  }
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`node:test terminated by signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export function buildLaneSpawnSpec({ tier, nodeBinary = process.execPath, nodeArgs }) {
  const testCommand = [nodeBinary, ...nodeArgs];
  if (tier === 'redis') {
    return {
      command: 'bash',
      args: [WITH_TEST_HOME, 'bash', ISOLATED_REDIS_HARNESS, '--', ...testCommand],
    };
  }
  return {
    command: 'bash',
    args: [WITH_TEST_HOME, ...testCommand],
  };
}

export async function runTestLane(args = process.argv.slice(2)) {
  const options = parseRunnerArgs(args);
  assertRunnerPreconditions(options);

  const selection = await selectTests({ tier: options.tier, testDir: resolve(API_DIR, 'test') });
  if (selection.selected.length === 0) {
    throw new Error(`tier "${options.tier}" selected zero test files`);
  }

  const testFiles = selection.selected.map(({ absolutePath }) => absolutePath);
  const nodeArgs = [
    '--import',
    SETUP_IMPORT,
    '--test',
    `--test-concurrency=${options.concurrency}`,
    `--test-timeout=${options.timeoutMs}`,
    ...testFiles,
  ];

  process.stdout.write(
    `[test-lane] tier=${options.tier} files=${testFiles.length} concurrency=${options.concurrency} timeout=${options.timeoutMs} node=${process.versions.node}\n`,
  );

  const spawnSpec = buildLaneSpawnSpec({ tier: options.tier, nodeArgs });
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: API_DIR,
    env: {
      ...process.env,
      CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    },
    stdio: 'inherit',
  });
  const exitCode = await waitForChild(child);
  if (exitCode !== 0) {
    throw new Error(`node:test exited with code ${exitCode}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runTestLane().catch((error) => {
    process.stderr.write(`[test-lane] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
