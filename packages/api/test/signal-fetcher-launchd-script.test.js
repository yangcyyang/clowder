// @ci-tier local-os reason="executes Bash launchd helpers and checks executable file modes"
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const launchdScript = resolve(repoRoot, 'scripts', 'signal-fetcher-launchd.sh');
const installScript = resolve(repoRoot, 'scripts', 'install-signal-fetcher.sh');
const uninstallScript = resolve(repoRoot, 'scripts', 'uninstall-signal-fetcher.sh');

describe('signal fetcher launchd scripts', () => {
  it('prints launchd plist with expected label and log paths', () => {
    const result = spawnSync('bash', [launchdScript, 'print-plist'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: '/tmp/cat-cafe-home',
        SIGNAL_FETCHER_LABEL: 'com.cat-cafe.signal-fetcher',
        SIGNAL_FETCH_HOUR: '7',
        SIGNAL_FETCH_MINUTE: '30',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /<string>com.cat-cafe.signal-fetcher<\/string>/);
    assert.match(result.stdout, /<string>\/tmp\/cat-cafe-home\/\.cat-cafe\/signals\/logs\/fetch\.log<\/string>/);
    assert.match(result.stdout, /<string>\/tmp\/cat-cafe-home\/\.cat-cafe\/signals\/logs\/fetch-error\.log<\/string>/);
    assert.match(result.stdout, /<integer>7<\/integer>/);
    assert.match(result.stdout, /<integer>30<\/integer>/);
  });

  it('install/uninstall wrappers exist and are executable', () => {
    accessSync(launchdScript, constants.X_OK);
    accessSync(installScript, constants.X_OK);
    accessSync(uninstallScript, constants.X_OK);

    const installText = readFileSync(installScript, 'utf8');
    const uninstallText = readFileSync(uninstallScript, 'utf8');

    assert.match(installText, /signal-fetcher-launchd\.sh["']?\s+install/);
    assert.match(uninstallText, /signal-fetcher-launchd\.sh["']?\s+uninstall/);
  });

  it('parses single-quoted daily_digest with inline comment from notifications.yaml', () => {
    const signalsRootDir = mkdtempSync(resolve(tmpdir(), 'cat-cafe-signals-'));
    mkdirSync(resolve(signalsRootDir, 'config'), { recursive: true });
    writeFileSync(
      resolve(signalsRootDir, 'config', 'notifications.yaml'),
      ['version: 1', 'notifications:', '  schedule:', "    daily_digest: '09:45' # local morning digest"].join('\n'),
      'utf8',
    );

    const result = spawnSync('bash', [launchdScript, 'print-plist'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: '/tmp/cat-cafe-home',
        SIGNALS_ROOT_DIR: signalsRootDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /<integer>9<\/integer>/);
    assert.match(result.stdout, /<integer>45<\/integer>/);
  });
});
