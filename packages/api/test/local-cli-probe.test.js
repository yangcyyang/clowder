import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCAL_CLI_ALLOWLIST, probeLocalAgentClis } from '../dist/utils/local-cli-probe.js';

const TEST_HOME = '/__cat-cafe-local-cli-probe-test-home__';

function probeWithIsolatedHome(options) {
  return probeLocalAgentClis({
    homeDir: TEST_HOME,
    async readFile(path) {
      assert.ok(path.startsWith(TEST_HOME), `probe escaped isolated HOME: ${path}`);
      throw new Error('model config fixture not provided');
    },
    ...options,
  });
}

describe('probeLocalAgentClis', () => {
  it('detects grok and parses only model IDs from its human-readable catalog', async () => {
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        return command === 'grok' ? '/opt/bin/grok' : null;
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'grok 0.2.93', stderr: '' };
        assert.deepEqual(args, ['models']);
        return {
          stdout: [
            'You are logged in with grok.com.',
            '',
            'Default model: grok-4.5',
            '',
            'Available models:',
            '  * grok-4.5 (default)',
            '  - grok-composer-2.5-fast',
          ].join('\n'),
          stderr: '',
        };
      },
    });

    const grok = results.find((item) => item.id === 'grok');
    assert.equal(grok?.installed, true);
    assert.equal(grok?.clientId, 'grok');
    assert.equal(grok?.defaultModel, 'grok-4.5');
    assert.equal(grok?.modelsStatus, 'ok');
    assert.deepEqual(grok?.models, [
      { id: 'grok-4.5', source: 'cli', isDefault: true },
      { id: 'grok-composer-2.5-fast', source: 'cli' },
    ]);
  });

  it('only probes the fixed agent CLI allowlist', async () => {
    const resolved = [];
    const executed = [];
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        resolved.push(command);
        return command === 'codex' ? '/usr/local/bin/codex' : null;
      },
      async runCommand(file, args) {
        executed.push({ file, args: [...args] });
        if (args[0] !== '--version') throw new Error('model command unavailable in this test');
        return { stdout: 'codex 1.2.3\n', stderr: '' };
      },
    });

    assert.deepEqual(
      resolved,
      LOCAL_CLI_ALLOWLIST.flatMap((item) => [item.command, ...(item.commandAliases ?? [])]),
    );
    assert.deepEqual(executed, [
      { file: '/usr/local/bin/codex', args: ['--version'] },
      { file: '/usr/local/bin/codex', args: ['debug', 'models', '--bundled'] },
    ]);
    assert.equal(results.find((item) => item.id === 'codex')?.installed, true);
    assert.equal(results.find((item) => item.id === 'codex')?.defaultModel, 'gpt-5.6-sol');
    assert.equal(results.find((item) => item.id === 'codex')?.models[0]?.id, 'gpt-5.6-sol');
    assert.equal(results.find((item) => item.id === 'codex')?.models[0]?.source, 'static');
    assert.equal(results.find((item) => item.id === 'codex')?.modelsStatus, 'static_only');
    assert.equal(results.find((item) => item.id === 'gemini')?.installed, false);
  });

  it('does not read credential state and marks auth as unknown', async () => {
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        return command === 'claude' ? '/opt/bin/claude' : null;
      },
      async runCommand() {
        return { stdout: 'claude 5.0.0', stderr: '' };
      },
    });

    const claude = results.find((item) => item.id === 'claude');
    assert.equal(claude?.installed, true);
    assert.equal(claude?.authStatus, 'unknown');
    assert.match(claude?.authStatusReason ?? '', /不读取凭证文件/);
  });

  it('keeps bounded version output when a CLI is noisy', async () => {
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        return command === 'opencli' ? '/opt/bin/opencli' : null;
      },
      async runCommand() {
        return { stdout: `${'x'.repeat(300)}\nsecret-looking-but-truncated`, stderr: '' };
      },
    });

    const opencli = results.find((item) => item.id === 'opencli');
    assert.equal(opencli?.version?.length, 160);
  });

  it('redacts credential-shaped strings from CLI output', async () => {
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        return command === 'codex' ? '/opt/bin/codex' : null;
      },
      async runCommand() {
        return { stdout: 'codex sk_agent_secret1234567890', stderr: '' };
      },
    });

    assert.equal(results.find((item) => item.id === 'codex')?.version, 'codex sk_agent_<redacted>');
  });

  it('uses L1 command models when the CLI returns a non-empty catalog', async () => {
    const results = await probeWithIsolatedHome({
      resolveCommand(command) {
        return command === 'opencode' ? '/opt/bin/opencode' : null;
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'opencode 1.15.13', stderr: '' };
        assert.deepEqual(args, ['models', '--pure']);
        return { stdout: 'deepseek/deepseek-v4-flash\nopenrouter/openai/gpt-5.4\n', stderr: '' };
      },
      async readFile() {
        throw new Error('L2 must not run after L1 succeeds');
      },
    });

    const opencode = results.find((item) => item.id === 'opencode');
    assert.equal(opencode?.modelsStatus, 'ok');
    assert.deepEqual(opencode?.models, [
      { id: 'deepseek/deepseek-v4-flash', source: 'cli' },
      { id: 'openrouter/openai/gpt-5.4', source: 'cli' },
    ]);
  });

  it('falls back from L1 to an explicit L2 config file', async () => {
    const reads = [];
    const results = await probeWithIsolatedHome({
      homeDir: '/tmp/home',
      resolveCommand(command) {
        return command === 'codex' ? '/opt/bin/codex' : null;
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'codex 0.144.0', stderr: '' };
        throw new Error('16KB model catalog limit');
      },
      async readFile(path) {
        reads.push(path);
        return JSON.stringify({
          models: [
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'gpt-5.6-terra', visibility: 'list' },
            { slug: 'codex-auto-review', visibility: 'hide' },
          ],
        });
      },
    });

    const codex = results.find((item) => item.id === 'codex');
    assert.deepEqual(reads, ['/tmp/home/.codex/models_cache.json']);
    assert.equal(codex?.modelsStatus, 'config_only');
    assert.deepEqual(codex?.models, [
      { id: 'gpt-5.6-sol', source: 'config', isDefault: true },
      { id: 'gpt-5.6-terra', source: 'config' },
    ]);
  });

  it('falls back from an empty L2 config to L3 static models', async () => {
    const results = await probeWithIsolatedHome({
      homeDir: '/tmp/home',
      resolveCommand(command) {
        return command === 'gemini' ? '/opt/bin/gemini' : null;
      },
      async runCommand() {
        return { stdout: '0.28.2', stderr: '' };
      },
      async readFile() {
        return JSON.stringify({ theme: 'system' });
      },
    });

    const gemini = results.find((item) => item.id === 'gemini');
    assert.equal(gemini?.modelsStatus, 'static_only');
    assert.equal(gemini?.models[0]?.source, 'static');
    assert.equal(gemini?.models[0]?.id, 'gemini-3.1-pro-preview');
  });

  it('returns failed when every configured model layer is empty', async () => {
    const results = await probeWithIsolatedHome({
      definitions: [
        {
          id: 'opencli',
          label: 'OpenCLI',
          command: 'opencli',
          installHint: 'install opencli',
          versionArgs: ['--version'],
          modelsProbe: {
            command: { args: ['models'], parse: () => [] },
            configFile: { path: '~/.opencli/models.json', extract: () => [] },
            static: [],
          },
        },
      ],
      homeDir: '/tmp/home',
      resolveCommand() {
        return '/opt/bin/opencli';
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'opencli 1.8.4', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      async readFile() {
        return '{}';
      },
    });

    assert.equal(results[0]?.modelsStatus, 'failed');
    assert.deepEqual(results[0]?.models, []);
  });

  it('refuses credential-shaped config filenames before readFile', async () => {
    let readCalled = false;
    const results = await probeWithIsolatedHome({
      definitions: [
        {
          id: 'opencli',
          label: 'OpenCLI',
          command: 'opencli',
          installHint: 'install opencli',
          versionArgs: ['--version'],
          modelsProbe: {
            configFile: { path: '~/.opencli/model-token.json', extract: () => ['secret-model'] },
          },
        },
      ],
      homeDir: '/tmp/home',
      resolveCommand() {
        return '/opt/bin/opencli';
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'opencli 1.8.4', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      async readFile() {
        readCalled = true;
        return '{}';
      },
    });

    assert.equal(readCalled, false);
    assert.equal(results[0]?.modelsStatus, 'failed');
  });

  it('redacts model command output before passing it to the parser', async () => {
    let parserInput = '';
    const results = await probeWithIsolatedHome({
      definitions: [
        {
          id: 'opencli',
          label: 'OpenCLI',
          command: 'opencli',
          installHint: 'install opencli',
          versionArgs: ['--version'],
          modelsProbe: {
            command: {
              args: ['models'],
              parse(stdout) {
                parserInput = stdout;
                return stdout.split(/\r?\n/).filter(Boolean);
              },
            },
          },
        },
      ],
      resolveCommand() {
        return '/opt/bin/opencli';
      },
      async runCommand(_file, args) {
        if (args[0] === '--version') return { stdout: 'opencli 1.8.4', stderr: '' };
        return { stdout: 'safe-model\nsk_agent_secret1234567890', stderr: '' };
      },
    });

    assert.doesNotMatch(parserInput, /secret123/);
    assert.equal(results[0]?.models[1]?.id, 'sk_agent_<redacted>');
  });
});
