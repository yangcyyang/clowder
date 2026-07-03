import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rebuildScriptPath = join(root, 'scripts', 'rebuild-native.sh');
const runtimePreflightPath = join(root, 'packages', 'api', 'scripts', 'runtime-preflight.mjs');

test('rebuild-native script pins Node and verifies better-sqlite3 ABI', () => {
  assert.equal(existsSync(rebuildScriptPath), true, 'scripts/rebuild-native.sh should exist');
  const script = readFileSync(rebuildScriptPath, 'utf8');

  assert.match(script, /\/Users\/cy\/\.uclaw\/node\/bin/, 'script should pin the known-good Node directory');
  assert.match(script, /\/Applications\/Xcode\.app\/Contents\/Developer\/usr\/bin/, 'script should prefer Xcode python for node-gyp');
  assert.match(script, /pnpm rebuild better-sqlite3/, 'script should rebuild better-sqlite3');
  assert.match(script, /npm run build-release/, 'script should fall back to the package build script when pnpm rebuild is ineffective');
  assert.match(script, /require\('better-sqlite3'\)/, 'script should verify better-sqlite3 can be required');
});

test('runtime preflight points native ABI failures at rebuild-native script', () => {
  const preflight = readFileSync(runtimePreflightPath, 'utf8');

  assert.match(preflight, /scripts\/rebuild-native\.sh/, 'preflight failure hint should name rebuild-native.sh');
});
