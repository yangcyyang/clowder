import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { PiAgentService } from '../dist/domains/cats/services/agents/providers/PiAgentService.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('pi');

function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 67890,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

function emitPiEvents(proc, events) {
  for (const event of events) proc.stdout.write(`${JSON.stringify(event)}\n`);
  proc.stdout.once('finish', () => emitProcessExit(proc, 0, null));
  proc.stdout.end();
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

describe('PiAgentService', () => {
  test('streams only assistant text deltas from pi json events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new PiAgentService({ catId: 'pi', spawnFn, model: 'mimo-v2.5-pro' });
    const promise = collect(service.invoke('只回复 OK', { systemPrompt: '你是 Pi Agent' }));

    emitPiEvents(proc, [
      { type: 'session', id: 'pi-session-1' },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden thinking' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'OK',
          partial: {
            role: 'assistant',
            provider: 'mimo',
            model: 'mimo-v2.5-pro',
            usage: { input: 3, output: 1, totalTokens: 4 },
          },
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'mimo',
          model: 'mimo-v2.5-pro',
          content: [
            { type: 'thinking', thinking: 'hidden thinking' },
            { type: 'text', text: 'OK' },
          ],
        },
      },
    ]);

    const messages = await promise;
    assert.deepEqual(
      messages.map((message) => message.type),
      ['session_init', 'text', 'done'],
    );
    assert.equal(messages.find((message) => message.type === 'text')?.content, 'OK');
    assert.equal(messages.find((message) => message.type === 'text')?.metadata?.provider, 'mimo');
    assert.equal(messages.find((message) => message.type === 'text')?.metadata?.usage?.totalTokens, 4);

    const spawnArgs = spawnFn.mock.calls[0].arguments[1];
    assert.ok(spawnArgs.includes('--print'));
    assert.ok(spawnArgs.includes('--mode'));
    assert.ok(spawnArgs.includes('json'));
    assert.ok(spawnArgs.includes('--no-context-files'));
    assert.ok(spawnArgs.includes('--append-system-prompt'));
    assert.equal(spawnArgs.at(-1), '只回复 OK');
  });

  test('falls back to final message text when no text deltas are emitted', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new PiAgentService({ catId: 'pi', spawnFn, model: 'mimo-v2.5-pro' });
    const promise = collect(service.invoke('hello'));

    emitPiEvents(proc, [
      { type: 'session', id: 'pi-session-2' },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'mimo',
          model: 'mimo-v2.5-pro',
          content: [{ type: 'text', text: 'fallback text' }],
        },
      },
    ]);

    const messages = await promise;
    assert.equal(messages.find((message) => message.type === 'text')?.content, 'fallback text');
    assert.equal(messages.at(-1)?.type, 'done');
  });
});
