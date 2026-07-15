import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GLOB_META = new Set('*?[]{}!');

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizePath(value) {
  return value.split(sep).join('/');
}

function relativeResultFile(resultName, webRoot) {
  const absoluteFile = isAbsolute(resultName) ? resultName : resolve(webRoot, resultName);
  const relativeFile = normalizePath(relative(webRoot, absoluteFile));
  if (relativeFile.startsWith('../')) throw new Error(`Vitest reported a file outside packages/web: ${resultName}`);
  return relativeFile;
}

export function classifyFailureKind(failureMessages) {
  const headline =
    (failureMessages ?? []).find((message) => typeof message === 'string' && message.trim())?.split('\n')[0] ?? '';

  if (/to be called \d+ times?/.test(headline)) return 'assertion:call-count';
  if (/to be defined/.test(headline)) return 'assertion:defined';
  if (/invalid for this assertion/.test(headline)) return 'assertion:invalid-input';
  if (/ to contain /.test(headline)) return 'assertion:contains';
  if (/Object\.is equality/.test(headline)) return 'assertion:object-is';
  if (/to be truthy/.test(headline)) return 'assertion:truthy';
  if (/not to be null/.test(headline)) return 'assertion:not-null';
  if (/^TypeError: Cannot read properties of null/.test(headline)) return 'runtime:null-property-access';
  if (/^TypeError: Cannot read properties of undefined/.test(headline)) return 'runtime:undefined-property-access';
  if (/^Error: .*not found/.test(headline)) return 'runtime:missing-element';
  if (/^AssertionError:/.test(headline)) return 'assertion:other';

  const runtimeError = /^([A-Za-z]+Error):/.exec(headline);
  if (runtimeError) return `runtime:${runtimeError[1].toLowerCase()}`;
  return 'runtime:unknown';
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed validation deliberately reports all malformed fields in one pass.
export function validateManifest(
  manifest,
  { webRoot, now = new Date(), fileExists = existsSync, expectedOwner = '@yangcyyang' } = {},
) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('quarantine manifest must be an object');
  }
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push('entries must be a non-empty array');
  }

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const seenFiles = new Set();
  const seenTests = new Set();
  const today = isoDate(now);
  let testCount = 0;
  let failureCount = 0;

  for (const [entryIndex, entry] of entries.entries()) {
    const prefix = `entries[${entryIndex}]`;
    const relativeFile = entry?.relativeFile;
    if (typeof relativeFile !== 'string' || !relativeFile) {
      errors.push(`${prefix}.relativeFile must be a non-empty string`);
      continue;
    }
    if (relativeFile.startsWith('/') || relativeFile.includes('\\') || relativeFile.split('/').includes('..')) {
      errors.push(`${relativeFile}: path must be package-relative POSIX syntax`);
    }
    if ([...relativeFile].some((character) => GLOB_META.has(character))) {
      errors.push(`${relativeFile}: glob syntax is forbidden`);
    }
    if (!relativeFile.startsWith('src/') || !TEST_FILE_RE.test(relativeFile)) {
      errors.push(`${relativeFile}: path must identify an exact Vitest file under src/`);
    }
    if (seenFiles.has(relativeFile)) errors.push(`${relativeFile}: duplicate file entry`);
    seenFiles.add(relativeFile);
    if (webRoot && !fileExists(resolve(webRoot, relativeFile))) errors.push(`${relativeFile}: file does not exist`);

    if (entry.owner !== expectedOwner) errors.push(`${relativeFile}: owner must be ${expectedOwner}`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${relativeFile}: reason is required`);
    if (typeof entry.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiry)) {
      errors.push(`${relativeFile}: expiry must use YYYY-MM-DD`);
    } else if (entry.expiry < today) {
      errors.push(`${relativeFile}: quarantine expired on ${entry.expiry}`);
    }
    if (!Number.isInteger(entry.testCount) || entry.testCount < 1) {
      errors.push(`${relativeFile}: testCount must be a positive integer`);
    } else {
      testCount += entry.testCount;
    }
    if (!Array.isArray(entry.failures) || entry.failures.length === 0) {
      errors.push(`${relativeFile}: failures must be a non-empty array`);
      continue;
    }

    failureCount += entry.failures.length;
    for (const [failureIndex, failure] of entry.failures.entries()) {
      const fullName = failure?.fullName;
      const failureKind = failure?.failureKind;
      if (typeof fullName !== 'string' || !fullName.trim()) {
        errors.push(`${relativeFile}: failures[${failureIndex}].fullName is required`);
        continue;
      }
      if (typeof failureKind !== 'string' || !/^(?:assertion|runtime):[a-z0-9-]+$/.test(failureKind)) {
        errors.push(`${relativeFile}: ${fullName}: invalid failureKind`);
      }
      const testKey = `${relativeFile}\0${fullName}`;
      if (seenTests.has(testKey)) errors.push(`${relativeFile}: duplicate failure for ${fullName}`);
      seenTests.add(testKey);
    }
  }

  const totals = { files: entries.length, tests: testCount, failures: failureCount };
  for (const key of Object.keys(totals)) {
    if (manifest.expectedTotals?.[key] !== totals[key]) {
      errors.push(`expectedTotals.${key} must equal computed ${totals[key]}`);
    }
  }

  if (errors.length > 0) throw new Error(`invalid quarantine manifest:\n- ${errors.join('\n- ')}`);
  return totals;
}

export function failureSignaturesFromManifest(manifest) {
  return manifest.entries.flatMap((entry) =>
    entry.failures.map((failure) => ({
      relativeFile: entry.relativeFile,
      fullName: failure.fullName,
      failureKind: failure.failureKind,
    })),
  );
}

export function failureSignaturesFromVitestJson(report, { webRoot }) {
  if (!report || !Array.isArray(report.testResults)) throw new Error('Vitest JSON report is missing testResults');
  return report.testResults.flatMap((result) => {
    const relativeFile = relativeResultFile(result.name, webRoot);
    return (result.assertionResults ?? [])
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => ({
        relativeFile,
        fullName: assertion.fullName,
        failureKind: classifyFailureKind(assertion.failureMessages),
      }));
  });
}

export function testFileCountsFromVitestJson(report, { webRoot }) {
  if (!report || !Array.isArray(report.testResults)) throw new Error('Vitest JSON report is missing testResults');
  return report.testResults.map((result) => ({
    relativeFile: relativeResultFile(result.name, webRoot),
    testCount: Array.isArray(result.assertionResults) ? result.assertionResults.length : 0,
  }));
}

export function compareTestFileCounts(expected, actual) {
  const collect = (values) => {
    const byFile = new Map();
    const duplicates = [];
    for (const value of values) {
      if (byFile.has(value.relativeFile)) duplicates.push(value.relativeFile);
      else byFile.set(value.relativeFile, value.testCount);
    }
    return { byFile, duplicates };
  };
  const expectedSet = collect(expected);
  const actualSet = collect(actual);
  const missingFiles = [];
  const unexpectedFiles = [];
  const countChanged = [];

  for (const [relativeFile, expectedCount] of expectedSet.byFile) {
    if (!actualSet.byFile.has(relativeFile)) missingFiles.push(relativeFile);
    else if (actualSet.byFile.get(relativeFile) !== expectedCount) {
      countChanged.push({ relativeFile, expected: expectedCount, actual: actualSet.byFile.get(relativeFile) });
    }
  }
  for (const relativeFile of actualSet.byFile.keys()) {
    if (!expectedSet.byFile.has(relativeFile)) unexpectedFiles.push(relativeFile);
  }

  const duplicates = [...expectedSet.duplicates, ...actualSet.duplicates];
  return {
    pass:
      missingFiles.length === 0 && unexpectedFiles.length === 0 && countChanged.length === 0 && duplicates.length === 0,
    missingFiles,
    unexpectedFiles,
    countChanged,
    duplicates,
  };
}

export function compareFailureSignatures(expected, actual) {
  const idOf = (signature) => `${signature.relativeFile}\0${signature.fullName}`;
  const collect = (values) => {
    const byId = new Map();
    const duplicates = [];
    for (const value of values) {
      const id = idOf(value);
      if (byId.has(id)) duplicates.push(value);
      else byId.set(id, value);
    }
    return { byId, duplicates };
  };

  const expectedSet = collect(expected);
  const actualSet = collect(actual);
  const unexpected = [];
  const resolved = [];
  const kindChanged = [];

  for (const [id, expectedValue] of expectedSet.byId) {
    const actualValue = actualSet.byId.get(id);
    if (!actualValue) resolved.push(expectedValue);
    else if (actualValue.failureKind !== expectedValue.failureKind) {
      kindChanged.push({ expected: expectedValue, actual: actualValue });
    }
  }
  for (const [id, actualValue] of actualSet.byId) {
    if (!expectedSet.byId.has(id)) unexpected.push(actualValue);
  }

  const duplicates = [...expectedSet.duplicates, ...actualSet.duplicates];
  return {
    pass: unexpected.length === 0 && resolved.length === 0 && kindChanged.length === 0 && duplicates.length === 0,
    unexpected,
    resolved,
    kindChanged,
    duplicates,
  };
}

export function discoverVitestFiles(webRoot) {
  const srcRoot = resolve(webRoot, 'src');
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && TEST_FILE_RE.test(entry.name) && statSync(absolute).isFile()) {
        files.push(normalizePath(relative(webRoot, absolute)));
      }
    }
  };
  visit(srcRoot);
  return files.sort();
}
