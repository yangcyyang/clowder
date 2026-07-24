const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// service-manager.js has no 'electron' dependency (only child_process, path,
// net, http, fs, os, crypto), so it's safe to require and instantiate
// directly in a plain node:test process — no Electron runtime needed.
const ServiceManager = require('./service-manager');

function makeManager() {
  return new ServiceManager('/fake/root', { frontendPort: 3003, apiPort: 3004, onStatus: () => {} });
}

function withEnvVar(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('_buildApiEnv sets safe behavior-flag defaults for standalone-spawn mode', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'service-manager-env-'));
  try {
    const env = makeManager()._buildApiEnv(tempRoot);
    assert.equal(env.CAT_CAFE_STEER_V2_CLAUDE, '1');
    assert.equal(env.CAT_CAFE_CONTEXT_LAYERS, '1');
    assert.equal(env.CAT_CAFE_COLLECTION_SECRET_QUARANTINE, '1');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('_buildApiEnv passes through machine-specific CAT_CAFE_*/OBSIDIAN_* vars instead of hardcoding them', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'service-manager-env-'));
  try {
    withEnvVar('CAT_CAFE_PROJECT_CONTEXT_IDS', 'proj-a,proj-b', () => {
      withEnvVar('OBSIDIAN_READONLY_ROOTS', '/Users/example/vault', () => {
        withEnvVar('CAT_CAFE_SOME_FUTURE_FLAG', 'passthrough-check', () => {
          const env = makeManager()._buildApiEnv(tempRoot);
          assert.equal(env.CAT_CAFE_PROJECT_CONTEXT_IDS, 'proj-a,proj-b');
          assert.equal(env.OBSIDIAN_READONLY_ROOTS, '/Users/example/vault');
          assert.equal(env.CAT_CAFE_SOME_FUTURE_FLAG, 'passthrough-check');
        });
      });
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('_buildApiEnv does not let passthrough clobber its own explicit defaults', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'service-manager-env-'));
  try {
    // Simulate a host environment that happens to already define one of the
    // hardcoded flags with a conflicting value — the explicit default set
    // inside _buildApiEnv must win, since passthrough only fills gaps.
    withEnvVar('CAT_CAFE_STEER_V2_CLAUDE', '0', () => {
      const env = makeManager()._buildApiEnv(tempRoot);
      assert.equal(env.CAT_CAFE_STEER_V2_CLAUDE, '1');
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('_buildApiEnv does not pass through unrelated env vars', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'service-manager-env-'));
  try {
    withEnvVar('SOME_UNRELATED_VAR', 'should-not-appear', () => {
      const env = makeManager()._buildApiEnv(tempRoot);
      assert.equal(env.SOME_UNRELATED_VAR, undefined);
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
