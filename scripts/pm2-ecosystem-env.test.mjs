import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stableNodeBin = '/Users/cy/.uclaw/node/bin';
const stableNode = `${stableNodeBin}/node`;
const pollutedPath = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].join(':');

test('PM2 ecosystem keeps stable Node ahead of caller PATH', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      [
        "const config = require('./ecosystem.config.cjs');",
        "const api = config.apps.find((app) => app.name === 'clowder-api');",
        "const web = config.apps.find((app) => app.name === 'clowder-web');",
        "console.log(JSON.stringify({ api, web }));",
      ].join(' '),
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        PATH: pollutedPath,
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);

  const { api, web } = JSON.parse(result.stdout);
  for (const app of [api, web]) {
    assert.equal(app.interpreter, stableNode);
    assert.equal(app.env.NODE, stableNode);
    assert.equal(app.env.npm_node_execpath, stableNode);
    assert.ok(
      app.env.PATH.startsWith(`${stableNodeBin}:`),
      `${app.name} PATH must start with ${stableNodeBin}`,
    );
    assert.equal(
      app.env.PATH.includes(`${pollutedPath}:${stableNodeBin}`),
      false,
      `${app.name} PATH must not inherit caller ordering`,
    );
  }
});

test('API lifecycle scripts prefer NODE over PATH node resolution', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../packages/api/package.json', import.meta.url), 'utf8'),
  );

  assert.equal(pkg.scripts.predev, '${NODE:-node} scripts/runtime-preflight.mjs');
  assert.equal(pkg.scripts.dev, '${NODE:-node} ../../node_modules/tsx/dist/cli.mjs watch src/index.ts');
  assert.equal(pkg.scripts.prestart, '${NODE:-node} scripts/runtime-preflight.mjs');
  assert.equal(pkg.scripts.start, '${NODE:-node} dist/index.js');
});

test('Web PM2 start runs package prestart guard before next start', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      [
        "const config = require('./ecosystem.config.cjs');",
        "const web = config.apps.find((app) => app.name === 'clowder-web');",
        "console.log(JSON.stringify(web));",
      ].join(' '),
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);

  const web = JSON.parse(result.stdout);
  assert.equal(web.args, 'run start:pm2');

  const pkg = JSON.parse(
    readFileSync(new URL('../packages/web/package.json', import.meta.url), 'utf8'),
  );

  assert.match(pkg.scripts.prestart, /\$\{NODE:-node\} scripts\/ensure-production-build\.mjs/);
  assert.match(pkg.scripts['start:pm2'], /pnpm run prestart && next start -p 3003 -H 0\.0\.0\.0/);
});
