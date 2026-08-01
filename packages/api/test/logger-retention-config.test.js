import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const loggerSource = readFileSync(resolve(import.meta.dirname, '../src/infrastructure/logger.ts'), 'utf-8');

test('logger keeps the current file plus 13 rotations and cleans files left by earlier processes', () => {
  assert.match(
    loggerSource,
    /export const LOG_ROLL_LIMIT = \{\s*count: 13,\s*removeOtherLogFiles: true,\s*\} as const;/,
  );
  assert.match(loggerSource, /limit: LOG_ROLL_LIMIT/);
});
