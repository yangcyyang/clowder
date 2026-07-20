// @ts-check
/**
 * 票B B1 — envVars keychain bypass guard.
 *
 * LIVE SENTINELS:
 *  - 12 secret-like envVars samples must ALL be rejected (guard + route 400).
 *  - 6 benign config envVars must ALL pass.
 *  - injection-time defense drops secret-like entries and never logs values.
 *  - startup scan reports a planted leaked account without printing the value.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

const NEGATIVE_CASES = [
  ['OPENAI_API_KEY', 'sk-proj-abc123def456'],
  ['DB_PASSWORD', 'hunter2'],
  ['GITHUB_TOKEN', 'ghp_16C2e42f1c8f4f0a8b7c6d5e4f3a2b1c'],
  ['AUTH_HEADER', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'],
  ['AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'],
  ['CERT_PEM', '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg'],
  ['SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'],
  ['NORMAL_NAME', 'sk-live-9f8e7d6c5b'],
  ['openai_api_key', 'anything'],
  ['API_SECRET', 'topsecret'],
  ['凭证', 'some-value'],
  ['ANTHROPIC_API_KEY', 'sk-ant-api03-aaaabbbb'],
];

const POSITIVE_CASES = [
  ['NODE_ENV', 'production'],
  ['HTTP_PROXY', 'http://proxy.internal:8080'],
  ['LANG', 'zh_CN.UTF-8'],
  ['API_BASE_URL', 'https://api.example.com'],
  ['TOKEN_EXPIRY', '3600'],
  ['MAX_TOKENS', '8192'],
];

async function makeTmpDir(prefix) {
  return mkdtemp(join(homedir(), `.cat-cafe-envvar-guard-${prefix}-`));
}

describe('B1 env-var-secret-guard', () => {
  it('rejects all 12 secret-like samples (name- or value-based)', async () => {
    const { detectEnvVarSecret } = await import('../dist/utils/env-var-secret-guard.js');
    for (const [key, value] of NEGATIVE_CASES) {
      const reason = detectEnvVarSecret(key, value);
      assert.ok(reason, `expected ${key} to be flagged as secret-like`);
    }
  });

  it('passes all 6 benign config samples', async () => {
    const { detectEnvVarSecret } = await import('../dist/utils/env-var-secret-guard.js');
    for (const [key, value] of POSITIVE_CASES) {
      const reason = detectEnvVarSecret(key, value);
      assert.equal(reason, null, `expected ${key} to pass, got reason: ${reason}`);
    }
  });

  it('injection filter drops secret-like entries, keeps benign, never exposes values in drop callback', async () => {
    const { filterAccountEnvVars } = await import('../dist/utils/env-var-secret-guard.js');
    const drops = [];
    const filtered = filterAccountEnvVars(
      {
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'sk-planted-injection-value',
        CAT_CAFE_INTERNAL: 'x',
        GITHUB_TOKEN: 'ghp_deadbeef',
      },
      (drop) => drops.push(drop),
    );
    assert.deepEqual(filtered, { NODE_ENV: 'production' });
    assert.equal(drops.length, 3, 'CAT_CAFE_ + 2 secret-like entries dropped');
    const serialized = JSON.stringify(drops);
    assert.ok(!serialized.includes('sk-planted-injection-value'), 'drop metadata must not contain the secret value');
    assert.ok(!serialized.includes('ghp_deadbeef'), 'drop metadata must not contain the token value');
  });

  it('POST /api/accounts rejects secret-like envVars with human-readable 400', async () => {
    const Fastify = (await import('fastify')).default;
    const { accountsRoutes } = await import('../dist/routes/accounts.js');
    const app = Fastify();
    await app.register(accountsRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('route');
    const savedRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const savedHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectDir;
    process.env.HOME = projectDir;
    try {
      for (const [key, value] of NEGATIVE_CASES.filter(([k]) => /^[A-Z_][A-Za-z0-9_]*$/.test(k))) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify({
            projectPath: projectDir,
            displayName: `neg-${key.toLowerCase()}`,
            authType: 'api_key',
            envVars: { [key]: value },
          }),
        });
        assert.equal(res.statusCode, 400, `expected 400 for envVars.${key}, got ${res.statusCode}: ${res.body}`);
        assert.match(res.body, /credentials/i, `400 message should point at credentials: ${res.body}`);
      }

      for (const [key, value] of POSITIVE_CASES) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/accounts',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          payload: JSON.stringify({
            projectPath: projectDir,
            displayName: `pos-${key.toLowerCase()}`,
            authType: 'api_key',
            envVars: { [key]: value },
          }),
        });
        assert.equal(res.statusCode, 200, `expected 200 for benign envVars.${key}, got ${res.statusCode}: ${res.body}`);
      }
    } finally {
      if (savedRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('PATCH /api/accounts/:id rejects secret-like envVars', async () => {
    const Fastify = (await import('fastify')).default;
    const { accountsRoutes } = await import('../dist/routes/accounts.js');
    const app = Fastify();
    await app.register(accountsRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('patch');
    const savedRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const savedHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectDir;
    process.env.HOME = projectDir;
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ projectPath: projectDir, displayName: 'patch-target', authType: 'api_key' }),
      });
      assert.equal(createRes.statusCode, 200);
      const id = createRes.json().profile.id;

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${id}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({ projectPath: projectDir, envVars: { GITHUB_TOKEN: 'ghp_plantedpatch' } }),
      });
      assert.equal(patchRes.statusCode, 400, `expected 400, got ${patchRes.statusCode}: ${patchRes.body}`);
      assert.match(patchRes.body, /credentials/i);
    } finally {
      if (savedRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('startup scan reports a planted leaked account without printing the value', async () => {
    const { accountStartupHook } = await import('../dist/config/account-startup.js');
    const { writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');

    const projectDir = await makeTmpDir('scan');
    const savedRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const savedHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectDir;
    process.env.HOME = projectDir;
    const warnings = [];
    const fakeLog = { warn: (obj, msg) => warnings.push({ obj, msg }) };
    try {
      writeCatalogAccount(projectDir, 'leaked-account', {
        authType: 'api_key',
        envVars: { OPENAI_API_KEY: 'sk-planted-scan-value', NODE_ENV: 'production' },
      });

      const result = accountStartupHook(projectDir, { log: fakeLog });
      assert.ok(result.leakedEnvVars.length > 0, 'scan must report the planted leaked account');
      const finding = result.leakedEnvVars.find((f) => f.accountId === 'leaked-account');
      assert.ok(finding, 'finding should name the account id');
      assert.ok(!JSON.stringify(result).includes('sk-planted-scan-value'), 'result must not contain the secret value');
      assert.ok(warnings.length > 0, 'scan must warn');
      const warnText = JSON.stringify(warnings);
      assert.ok(!warnText.includes('sk-planted-scan-value'), 'warn output must not contain the secret value');
      assert.ok(!warnText.includes('OPENAI_API_KEY'), 'warn output must mask the key name');
    } finally {
      if (savedRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedRoot;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
