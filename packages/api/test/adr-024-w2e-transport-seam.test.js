/**
 * ADR-024 W2-E tests: remaining provider adapters wired to the four-slot
 * transport seam (system → history → meta → userMsg).
 *
 * Coverage per adapter (Kimi/Codex/Grok/Gemini-cli/Pi/OpenCode/Dare/A2A):
 *  ① transportPayload present → system precedes history precedes meta precedes
 *     userMsg in whatever the adapter sends to its CLI/API (single blob, or a
 *     dedicated system channel + ordered body for Claude-style adapters)
 *  ② transportPayload present → system slot wins over a stale `systemPrompt`
 *     string (proves "every turn includes system", not the resume-gated one)
 *  ③ no transportPayload (v1 / non-seam callers) → behavior unchanged from
 *     pre-W2-E (byte-identical prepend, or — for OpenCode/Dare/A2A, which never
 *     had system-prompt support before this wave — the prompt passes through
 *     untouched)
 *
 * Antigravity and GeminiAcpAdapter get their W2-E cases colocated in their own
 * existing suites (test/antigravity-agent-service.test.js, test/acp/gemini-acp-adapter.test.js)
 * since those already carry the bridge/pool mock machinery this needs.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

for (const cmd of ['kimi', 'grok', 'gemini', 'pi', 'opencode']) ensureFakeCliOnPath(cmd);

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Capture the `CliSpawnOptions` an adapter hands to spawnCli, without spawning anything. */
function captureSpawn() {
  const box = { captured: undefined };
  box.spawnCliOverride = (opts) => {
    box.captured = opts;
    return (async function* () {})();
  };
  return box;
}

// A four-slot payload with easy-to-find markers. history/meta/userMsg mirror what
// route-serial/route-parallel would have already rendered into `prompt` via
// renderTransportPromptBody (history → meta → userMsg, joined by SLOT_SEPARATOR) —
// tests pass that same rendering as `prompt` so the fixture matches real wiring.
const SLOT_SEPARATOR = '\n\n---\n\n';
const SYS = 'SYS_MARKER';
const HIST = 'HIST_MARKER';
const META = 'META_MARKER';
const USER = 'USER_MARKER';
const PROMPT_BODY = [HIST, META, USER].join(SLOT_SEPARATOR);
const TRANSPORT_PAYLOAD = { system: SYS, history: HIST, meta: META, userMsg: USER };
const STALE_SYSTEM_PROMPT = 'STALE_LEGACY_SYSTEM_PROMPT_SHOULD_NOT_APPEAR';

function assertOrdered(haystack, markers) {
  const indices = markers.map((m) => haystack.indexOf(m));
  for (const i of indices) assert.ok(i >= 0, `expected to find "${markers[indices.indexOf(i)]}" in: ${haystack}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `expected ${markers[i - 1]} before ${markers[i]} in: ${haystack}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Kimi — single blob, buildKimiPrompt (kimi-event-parser.ts)
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Kimi transport seam', () => {
  test('transportPayload → system → history → meta → userMsg, system wins over stale systemPrompt', async () => {
    const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
    const service = new KimiAgentService({ model: 'kimi-k2.5' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const promptIdx = box.captured.args.indexOf('--prompt');
    assert.ok(promptIdx >= 0);
    const sentPrompt = box.captured.args[promptIdx + 1];
    assertOrdered(sentPrompt, [SYS, HIST, META, USER]);
    assert.ok(!sentPrompt.includes(STALE_SYSTEM_PROMPT), 'stale systemPrompt must not appear once transportPayload wins');
  });

  test('no transportPayload → byte-identical to pre-W2-E systemPrompt wrap', async () => {
    const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
    const service = new KimiAgentService({ model: 'kimi-k2.5' });
    const box = captureSpawn();
    await collect(
      service.invoke('Hello', { systemPrompt: 'Be a cat.', spawnCliOverride: box.spawnCliOverride }),
    );
    const promptIdx = box.captured.args.indexOf('--prompt');
    const sentPrompt = box.captured.args[promptIdx + 1];
    assert.equal(
      sentPrompt,
      ['<system_instructions>', 'Be a cat.', '</system_instructions>', '', '<user_request>', 'Hello', '</user_request>'].join(
        '\n',
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Codex — single blob, no system flag (positional `--` arg)
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Codex transport seam', () => {
  test('transportPayload → system → history → meta → userMsg, system wins over stale systemPrompt', async () => {
    const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
    const service = new CodexAgentService({ model: 'gpt-5-codex' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const sentPrompt = box.captured.args.at(-1);
    assertOrdered(sentPrompt, [SYS, HIST, META, USER]);
    assert.ok(!sentPrompt.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload → byte-identical to pre-W2-E systemPrompt prepend', async () => {
    const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
    const service = new CodexAgentService({ model: 'gpt-5-codex' });
    const box = captureSpawn();
    await collect(
      service.invoke('Hello', { systemPrompt: 'Be a cat.', spawnCliOverride: box.spawnCliOverride }),
    );
    assert.equal(box.captured.args.at(-1), 'Be a cat.\n\nHello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Grok — single blob via `-p`
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Grok transport seam', () => {
  test('transportPayload → system → history → meta → userMsg, system wins over stale systemPrompt', async () => {
    const { GrokAgentService } = await import('../dist/domains/cats/services/agents/providers/GrokAgentService.js');
    const service = new GrokAgentService({ model: 'grok-4.5' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const pIdx = box.captured.args.indexOf('-p');
    const sentPrompt = box.captured.args[pIdx + 1];
    assertOrdered(sentPrompt, [SYS, HIST, META, USER]);
    assert.ok(!sentPrompt.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload → byte-identical to pre-W2-E systemPrompt prepend', async () => {
    const { GrokAgentService } = await import('../dist/domains/cats/services/agents/providers/GrokAgentService.js');
    const service = new GrokAgentService({ model: 'grok-4.5' });
    const box = captureSpawn();
    await collect(
      service.invoke('Hello', { systemPrompt: 'Be a cat.', spawnCliOverride: box.spawnCliOverride }),
    );
    const pIdx = box.captured.args.indexOf('-p');
    assert.equal(box.captured.args[pIdx + 1], 'Be a cat.\n\nHello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gemini CLI — single blob via `-p`
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Gemini CLI transport seam', () => {
  test('transportPayload → system → history → meta → userMsg, system wins over stale systemPrompt', async () => {
    const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');
    const service = new GeminiAgentService({ model: 'gemini-3-pro' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const pIdx = box.captured.args.indexOf('-p');
    const sentPrompt = box.captured.args[pIdx + 1];
    assertOrdered(sentPrompt, [SYS, HIST, META, USER]);
    assert.ok(!sentPrompt.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload → byte-identical to pre-W2-E systemPrompt prepend', async () => {
    const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');
    const service = new GeminiAgentService({ model: 'gemini-3-pro' });
    const box = captureSpawn();
    await collect(
      service.invoke('Hello', { systemPrompt: 'Be a cat.', spawnCliOverride: box.spawnCliOverride }),
    );
    const pIdx = box.captured.args.indexOf('-p');
    assert.equal(box.captured.args[pIdx + 1], 'Be a cat.\n\nHello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pi — dedicated system channel (--append-system-prompt), body = `prompt` as-is
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Pi transport seam', () => {
  test('transportPayload → system via --append-system-prompt, body untouched (history → meta → userMsg preserved), system wins over stale systemPrompt', async () => {
    const { PiAgentService } = await import('../dist/domains/cats/services/agents/providers/PiAgentService.js');
    const service = new PiAgentService({ model: 'pi-1' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const flagIdx = box.captured.args.indexOf('--append-system-prompt');
    assert.ok(flagIdx >= 0);
    assert.equal(box.captured.args[flagIdx + 1], SYS);
    // Body is the last arg, delivered untouched — system must NOT be mixed into it.
    const body = box.captured.args.at(-1);
    assert.equal(body, PROMPT_BODY);
    assertOrdered(body, [HIST, META, USER]);
    assert.ok(!body.includes(SYS));
    assert.ok(!box.captured.args.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload → byte-identical to pre-W2-E systemPrompt channel', async () => {
    const { PiAgentService } = await import('../dist/domains/cats/services/agents/providers/PiAgentService.js');
    const service = new PiAgentService({ model: 'pi-1' });
    const box = captureSpawn();
    await collect(
      service.invoke('Hello', { systemPrompt: 'Be a cat.', spawnCliOverride: box.spawnCliOverride }),
    );
    const flagIdx = box.captured.args.indexOf('--append-system-prompt');
    assert.equal(box.captured.args[flagIdx + 1], 'Be a cat.');
    assert.equal(box.captured.args.at(-1), 'Hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OpenCode — single blob, no prior system support (new W2-E capability)
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E OpenCode transport seam', () => {
  test('transportPayload → system → history → meta → userMsg, guardrail suffix stays after userMsg', async () => {
    const { OpenCodeAgentService } = await import(
      '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js'
    );
    const service = new OpenCodeAgentService({ model: 'claude-sonnet-4-6' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const sent = box.captured.args.at(-1);
    assertOrdered(sent, [SYS, HIST, META, USER]);
    assert.ok(sent.indexOf(USER) < sent.indexOf('[Clowder 输出要求]'), 'guardrail suffix must stay after userMsg');
    assert.ok(!sent.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload, no systemPrompt → prompt passes through unchanged (pre-W2-E had no system support at all)', async () => {
    const { OpenCodeAgentService } = await import(
      '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js'
    );
    const service = new OpenCodeAgentService({ model: 'claude-sonnet-4-6' });
    const box = captureSpawn();
    await collect(service.invoke('Hello', { spawnCliOverride: box.spawnCliOverride }));
    assert.ok(box.captured.args.at(-1).startsWith('Hello'));
    assert.ok(!box.captured.args.at(-1).includes(STALE_SYSTEM_PROMPT));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Dare — single blob via --task, no prior system support (new W2-E capability)
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E Dare transport seam', () => {
  test('transportPayload → system → history → meta → userMsg', async () => {
    const { DareAgentService } = await import('../dist/domains/cats/services/agents/providers/DareAgentService.js');
    // spawnFn (constructor) bypasses the darePath existence guard; spawnCliOverride
    // (per-call) intercepts the actual spawn so spawnFn itself is never invoked.
    const service = new DareAgentService({ spawnFn: () => {}, model: 'test/model' });
    const box = captureSpawn();
    await collect(
      service.invoke(PROMPT_BODY, {
        systemPrompt: STALE_SYSTEM_PROMPT,
        transportPayload: TRANSPORT_PAYLOAD,
        spawnCliOverride: box.spawnCliOverride,
      }),
    );
    const taskIdx = box.captured.args.indexOf('--task');
    assert.ok(taskIdx >= 0);
    const sent = box.captured.args[taskIdx + 1];
    assertOrdered(sent, [SYS, HIST, META, USER]);
    assert.ok(!sent.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload, no systemPrompt → --task carries only prompt (pre-W2-E had no system support at all)', async () => {
    const { DareAgentService } = await import('../dist/domains/cats/services/agents/providers/DareAgentService.js');
    const service = new DareAgentService({ spawnFn: () => {}, model: 'test/model' });
    const box = captureSpawn();
    await collect(service.invoke('Hello', { spawnCliOverride: box.spawnCliOverride }));
    const taskIdx = box.captured.args.indexOf('--task');
    assert.equal(box.captured.args[taskIdx + 1], 'Hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A2A — single blob into JSON-RPC text part, no prior system support (new W2-E capability)
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E A2A transport seam', () => {
  test('transportPayload → system → history → meta → userMsg in the JSON-RPC text part', async () => {
    const { A2AAgentService } = await import('../dist/domains/cats/services/agents/providers/A2AAgentService.js');
    let capturedBody;
    const service = new A2AAgentService({
      catId: 'a2a-agent',
      config: { url: 'http://mock.local' },
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: '1', result: { id: 't', status: 'completed', artifacts: [] } }) };
      },
    });
    await collect(
      service.invoke(PROMPT_BODY, { systemPrompt: STALE_SYSTEM_PROMPT, transportPayload: TRANSPORT_PAYLOAD }),
    );
    const sent = capturedBody.params.message.parts[0].text;
    assertOrdered(sent, [SYS, HIST, META, USER]);
    assert.ok(!sent.includes(STALE_SYSTEM_PROMPT));
  });

  test('no transportPayload, no systemPrompt → text part carries only prompt (pre-W2-E had no system support at all)', async () => {
    const { A2AAgentService } = await import('../dist/domains/cats/services/agents/providers/A2AAgentService.js');
    let capturedBody;
    const service = new A2AAgentService({
      catId: 'a2a-agent',
      config: { url: 'http://mock.local' },
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: '1', result: { id: 't', status: 'completed', artifacts: [] } }) };
      },
    });
    await collect(service.invoke('Hello'));
    assert.equal(capturedBody.params.message.parts[0].text, 'Hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Route-layer allowlist
// ─────────────────────────────────────────────────────────────────────────
describe('W2-E TRANSPORT_SEAM_CLIENT_IDS allowlist', () => {
  test('covers exactly the W2-E-completed providers, fails closed for unknown clientIds', async () => {
    const { TRANSPORT_SEAM_CLIENT_IDS, supportsTransportSeam } = await import(
      '../dist/domains/cats/services/agents/transport/assemble-transport-payload.js'
    );
    const expected = [
      'anthropic',
      'kimi',
      'openai',
      'grok',
      'google',
      'pi',
      'opencode',
      'dare',
      'a2a',
      'catagent',
      'antigravity',
    ];
    assert.deepEqual([...TRANSPORT_SEAM_CLIENT_IDS].sort(), [...expected].sort());
    for (const id of expected) assert.equal(supportsTransportSeam(id), true, `${id} should be in the allowlist`);
    assert.equal(supportsTransportSeam(undefined), false);
    assert.equal(supportsTransportSeam('made-up-future-client'), false);
  });
});
