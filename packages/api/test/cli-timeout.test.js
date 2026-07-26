import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  DEFAULT_CLI_TIMEOUT_MS,
  parseCliTimeoutMs,
  readCliTimeoutMsFromEnv,
  resolveCliTimeoutMs,
  DEFAULT_CLI_IDLE_TIMEOUT_SEC,
  parseCliIdleTimeoutSec,
  readCliIdleTimeoutSecFromEnv,
  resolveCliIdleTimeoutMs,
} = await import('../dist/utils/cli-timeout.js');

describe('cli-timeout', () => {
  describe('parseCliTimeoutMs', () => {
    it('returns undefined for missing or invalid values', () => {
      assert.equal(parseCliTimeoutMs(undefined), undefined);
      assert.equal(parseCliTimeoutMs(''), undefined);
      assert.equal(parseCliTimeoutMs('   '), undefined);
      assert.equal(parseCliTimeoutMs('-1'), undefined);
      assert.equal(parseCliTimeoutMs('NaN'), undefined);
      assert.equal(parseCliTimeoutMs('Infinity'), undefined);
    });

    it('accepts zero and positive finite numbers', () => {
      assert.equal(parseCliTimeoutMs('0'), 0);
      assert.equal(parseCliTimeoutMs('300000'), 300000);
      assert.equal(parseCliTimeoutMs(' 1500 '), 1500);
    });
  });

  describe('readCliTimeoutMsFromEnv', () => {
    it('reads CLI_TIMEOUT_MS from env-like objects', () => {
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '0' }), 0);
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '9000' }), 9000);
      assert.equal(readCliTimeoutMsFromEnv({ CLI_TIMEOUT_MS: '-5' }), undefined);
    });
  });

  describe('resolveCliTimeoutMs', () => {
    it('prefers explicit override, then env, then fallback default', () => {
      assert.equal(resolveCliTimeoutMs(42, { CLI_TIMEOUT_MS: '9000' }), 42);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: '9000' }), 9000);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: '0' }), 0);
      assert.equal(resolveCliTimeoutMs(undefined, { CLI_TIMEOUT_MS: 'NaN' }), DEFAULT_CLI_TIMEOUT_MS);
      assert.equal(resolveCliTimeoutMs(undefined, {}), DEFAULT_CLI_TIMEOUT_MS);
    });
  });

  // R8-1: CLI stream idle watchdog (docs/research/reliability-raft-round8-absorption.md §二)
  describe('parseCliIdleTimeoutSec', () => {
    it('returns undefined for missing or invalid values', () => {
      assert.equal(parseCliIdleTimeoutSec(undefined), undefined);
      assert.equal(parseCliIdleTimeoutSec(''), undefined);
      assert.equal(parseCliIdleTimeoutSec('   '), undefined);
      assert.equal(parseCliIdleTimeoutSec('-1'), undefined);
      assert.equal(parseCliIdleTimeoutSec('NaN'), undefined);
      assert.equal(parseCliIdleTimeoutSec('Infinity'), undefined);
    });

    it('accepts zero and positive finite numbers', () => {
      assert.equal(parseCliIdleTimeoutSec('0'), 0);
      assert.equal(parseCliIdleTimeoutSec('300'), 300);
      assert.equal(parseCliIdleTimeoutSec(' 45 '), 45);
    });
  });

  describe('readCliIdleTimeoutSecFromEnv', () => {
    it('defaults to 0 (disabled) — zero behavior change unless explicitly configured', () => {
      assert.equal(readCliIdleTimeoutSecFromEnv({}), DEFAULT_CLI_IDLE_TIMEOUT_SEC);
      assert.equal(DEFAULT_CLI_IDLE_TIMEOUT_SEC, 0);
      assert.equal(readCliIdleTimeoutSecFromEnv({ CLOWDER_CLI_IDLE_TIMEOUT_SEC: 'garbage' }), 0);
    });

    it('reads CLOWDER_CLI_IDLE_TIMEOUT_SEC from env-like objects', () => {
      assert.equal(readCliIdleTimeoutSecFromEnv({ CLOWDER_CLI_IDLE_TIMEOUT_SEC: '300' }), 300);
      assert.equal(readCliIdleTimeoutSecFromEnv({ CLOWDER_CLI_IDLE_TIMEOUT_SEC: '-5' }), 0);
    });
  });

  describe('resolveCliIdleTimeoutMs', () => {
    it('prefers explicit override (ms) over env (sec, converted to ms)', () => {
      assert.equal(resolveCliIdleTimeoutMs(1234, { CLOWDER_CLI_IDLE_TIMEOUT_SEC: '300' }), 1234);
      assert.equal(resolveCliIdleTimeoutMs(0, { CLOWDER_CLI_IDLE_TIMEOUT_SEC: '300' }), 0);
      assert.equal(resolveCliIdleTimeoutMs(undefined, { CLOWDER_CLI_IDLE_TIMEOUT_SEC: '300' }), 300_000);
      assert.equal(resolveCliIdleTimeoutMs(undefined, {}), 0);
    });
  });
});
