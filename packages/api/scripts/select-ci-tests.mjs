#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CI_TIERS = Object.freeze(['core', 'redis', 'integration', 'slow', 'local-os', 'external']);

const HEADER_LINE_LIMIT = 12;
const TAG_TOKEN = '@ci-tier';
const TAG_PATTERN = /^\s*\/\/\s*@ci-tier\s+(\S+)(?:\s+reason="([^"]*)")?\s*$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEST_DIR = resolve(SCRIPT_DIR, '../test');

function toPosixPath(path) {
  return path.replaceAll('\\', '/');
}

async function enumerateTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];

  for (const entry of sortedEntries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await enumerateTestFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(entryPath);
    }
  }

  return files;
}

export function parseCiTierHeader(source, filePath = '<unknown>') {
  const sourceLines = source.split(/\r?\n/u);
  const headerLines = sourceLines.slice(0, HEADER_LINE_LIMIT);
  const markerLines = headerLines.filter((line) => line.includes(TAG_TOKEN));
  const lateMarkerLine = sourceLines.slice(HEADER_LINE_LIMIT).findIndex((line) => line.includes(TAG_TOKEN));

  if (lateMarkerLine !== -1) {
    throw new Error(
      `${filePath}: @ci-tier marker must appear in the first ${HEADER_LINE_LIMIT} lines (found at line ${lateMarkerLine + HEADER_LINE_LIMIT + 1})`,
    );
  }

  if (markerLines.length === 0) {
    return { tier: 'core', reason: null, tagged: false };
  }
  if (markerLines.length > 1) {
    throw new Error(`${filePath}: duplicate @ci-tier markers in the first ${HEADER_LINE_LIMIT} lines`);
  }

  const match = TAG_PATTERN.exec(markerLines[0]);
  if (!match) {
    throw new Error(`${filePath}: malformed @ci-tier marker; expected // @ci-tier <tier> reason="<non-empty reason>"`);
  }

  const [, tier, reason = ''] = match;
  if (!CI_TIERS.includes(tier)) {
    throw new Error(`${filePath}: unknown @ci-tier "${tier}"; expected one of ${CI_TIERS.join(', ')}`);
  }
  if (reason.trim().length === 0) {
    throw new Error(`${filePath}: @ci-tier ${tier} requires a non-empty reason="..."`);
  }

  return { tier, reason, tagged: true };
}

export async function discoverTests({ testDir = DEFAULT_TEST_DIR } = {}) {
  const absoluteTestDir = resolve(testDir);
  const files = await enumerateTestFiles(absoluteTestDir);
  const records = await Promise.all(
    files.map(async (absolutePath) => {
      const relativePath = toPosixPath(relative(absoluteTestDir, absolutePath));
      const source = await readFile(absolutePath, 'utf8');
      return {
        path: relativePath,
        absolutePath,
        ...parseCiTierHeader(source, relativePath),
      };
    }),
  );

  return records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export async function selectTests({ tier = 'core', testDir = DEFAULT_TEST_DIR } = {}) {
  if (!CI_TIERS.includes(tier)) {
    throw new Error(`unknown tier "${tier}"; expected one of ${CI_TIERS.join(', ')}`);
  }

  const allTests = await discoverTests({ testDir });
  return {
    tier,
    testDir: resolve(testDir),
    total: allTests.length,
    selected: allTests.filter((testFile) => testFile.tier === tier),
  };
}

function parseSelectorArgument(args, index) {
  const argument = args[index];
  if (argument === '--') {
    return { kind: 'separator', value: null, consumed: 1 };
  }
  if (argument === '--list' || argument === '--json') {
    return { kind: 'format', value: argument.slice(2), consumed: 1 };
  }
  if (argument.startsWith('--tier=')) {
    return { kind: 'tier', value: argument.slice('--tier='.length), consumed: 1 };
  }
  if (argument === '--tier') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--tier requires a value');
    }
    return { kind: 'tier', value, consumed: 2 };
  }
  throw new Error(`unknown argument "${argument}"`);
}

export function parseSelectorArgs(args) {
  let tier = 'core';
  let format = 'summary';

  for (let index = 0; index < args.length; ) {
    const parsed = parseSelectorArgument(args, index);
    index += parsed.consumed;
    if (parsed.kind === 'separator') {
      continue;
    }
    if (parsed.kind === 'tier') {
      tier = parsed.value;
      continue;
    }
    if (format !== 'summary' && format !== parsed.value) {
      throw new Error('--list and --json are mutually exclusive');
    }
    format = parsed.value;
  }

  if (!CI_TIERS.includes(tier)) {
    throw new Error(`unknown tier "${tier}"; expected one of ${CI_TIERS.join(', ')}`);
  }
  return { tier, format };
}

function serializeSelection(selection) {
  return {
    tier: selection.tier,
    total: selection.total,
    count: selection.selected.length,
    files: selection.selected.map(({ path, reason, tagged }) => ({ path, reason, tagged })),
  };
}

export async function runSelectorCli(args = process.argv.slice(2)) {
  const { tier, format } = parseSelectorArgs(args);
  const selection = await selectTests({ tier });

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(serializeSelection(selection), null, 2)}\n`);
    return;
  }
  if (format === 'list') {
    const paths = selection.selected.map(({ path }) => path);
    if (paths.length > 0) {
      process.stdout.write(`${paths.join('\n')}\n`);
    }
    return;
  }

  process.stdout.write(
    `[test-selector] tier=${selection.tier} selected=${selection.selected.length} total=${selection.total}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runSelectorCli().catch((error) => {
    process.stderr.write(`[test-selector] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
