import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stubBinDir = mkdtempSync(join(tmpdir(), 'grok-stub-bin-'));
writeFileSync(join(stubBinDir, 'grok'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${stubBinDir}:${process.env.PATH}`;

const { GrokAgentService } = await import('../dist/domains/cats/services/agents/providers/GrokAgentService.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test.after(() => {
  rmSync(stubBinDir, { recursive: true, force: true });
});

test('streams thought, text, session_init and done from grok streaming-json', async () => {
  let spawnOptions;
  async function* spawnCliOverride(options) {
    spawnOptions = options;
    yield { type: 'thought', data: 'checking' };
    yield { type: 'text', data: 'GROK_' };
    yield { type: 'text', data: 'OK' };
    yield { type: 'end', stopReason: 'EndTurn', sessionId: 'grok-session-1', requestId: 'req-1' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(
    service.invoke('Reply briefly', {
      systemPrompt: 'Be precise.',
      callbackEnv: { XAI_API_KEY: 'test-key' },
      accountEnv: { CUSTOM_ENV: 'enabled' },
      spawnCliOverride,
    }),
  );

  assert.deepEqual(
    messages.map((message) => message.type),
    ['system_info', 'text', 'text', 'session_init', 'done'],
  );
  assert.match(messages[0].content, /checking/);
  assert.equal(messages[1].content, 'GROK_');
  assert.equal(messages[2].content, 'OK');
  assert.equal(messages[3].sessionId, 'grok-session-1');
  assert.equal(messages[4].metadata.sessionId, 'grok-session-1');

  assert.equal(spawnOptions.command.endsWith('/grok'), true);
  assert.deepEqual(spawnOptions.args.slice(0, 2), ['-p', 'Be precise.\n\nReply briefly']);
  assert.ok(spawnOptions.args.includes('--output-format'));
  assert.ok(spawnOptions.args.includes('streaming-json'));
  assert.ok(spawnOptions.args.includes('--model'));
  assert.ok(spawnOptions.args.includes('grok-4.5'));
  assert.equal(spawnOptions.env.XAI_API_KEY, 'test-key');
  assert.equal(spawnOptions.env.CUSTOM_ENV, 'enabled');
});

test('resumes the requested session and reports CLI failures', async () => {
  let args = [];
  async function* spawnCliOverride(options) {
    args = options.args;
    yield { __cliError: true, exitCode: 2, message: 'resume failed', command: 'grok', signal: null };
  }

  const service = new GrokAgentService({ model: 'grok-composer-2.5-fast' });
  const messages = await collect(service.invoke('Continue', { sessionId: 'grok-session-old', spawnCliOverride }));

  assert.equal(messages[0].type, 'session_init');
  assert.equal(messages[0].sessionId, 'grok-session-old');
  const resumeIndex = args.indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(args[resumeIndex + 1], 'grok-session-old');
  assert.equal(
    messages.some((message) => message.type === 'error'),
    true,
  );
  assert.equal(messages.at(-1).type, 'done');
});

test('surfaces streaming error events without exposing the Grok API key', async () => {
  const apiKey = 'xai-test-secret-key';
  async function* spawnCliOverride() {
    yield { type: 'error', message: `Authentication failed for ${apiKey}` };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(
    service.invoke('Hello', {
      callbackEnv: { XAI_API_KEY: apiKey },
      spawnCliOverride,
    }),
  );

  assert.deepEqual(
    messages.map((message) => message.type),
    ['error', 'done'],
  );
  assert.match(messages[0].error, /Authentication failed/);
  assert.doesNotMatch(messages[0].error, new RegExp(apiKey));
});

test('subscription mode removes an inherited XAI_API_KEY from the child environment', async () => {
  let spawnOptions;
  async function* spawnCliOverride(options) {
    spawnOptions = options;
    yield { type: 'text', data: 'ok' };
    yield { type: 'end', sessionId: 'grok-subscription-session' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  await collect(
    service.invoke('Hello', {
      callbackEnv: { CAT_CAFE_GROK_PROFILE_MODE: 'subscription' },
      spawnCliOverride,
    }),
  );

  assert.equal(spawnOptions.env.XAI_API_KEY, null);
});
