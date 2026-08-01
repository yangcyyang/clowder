import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const checkerPath = resolve(scriptDir, 'check-followup-tails.mjs');

test('fails closed when the configured Git base ref cannot be resolved', () => {
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FOLLOWUP_TAILS_BASE_REF: 'refs/heads/__missing_followup_tails_base__',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to resolve Git base ref/);
});
