/**
 * whisper-hygiene, F194-level activity sentinel: proves the actual leak chain reported to
 * 专家-Claude is closed end-to-end — not just that `hydrateReplyPreview()` filters in
 * isolation, but that composing it with `buildInvocationContext()` the same way
 * route-serial.ts does (streamReplyPreview?.content ? {a2aTriggerContent: ...} : {})
 * never lets a whisper's raw content reach a non-recipient cat's invocation-context prompt
 * text. See whisper-hygiene-audit memory for the full trace (route-serial.ts:562-681 →
 * SystemPromptBuilder.ts:918-923).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadModules() {
  const { MessageStore, hydrateReplyPreview } = await import(
    '../dist/domains/cats/services/stores/ports/MessageStore.js'
  );
  const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
  return { MessageStore, hydrateReplyPreview, buildInvocationContext };
}

// Mirrors route-serial.ts's exact assignment logic: a2aTriggerContent is only included
// when the hydrated preview actually has content.
function buildA2AInvocationContextInput(catId, preview) {
  return {
    catId,
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
    directMessageFrom: 'opus',
    a2aTriggerMessageId: 'trigger-msg-1',
    ...(preview?.content ? { a2aTriggerContent: preview.content } : {}),
  };
}

describe('whisper A2A trigger-content leak (F194-level sentinel)', () => {
  test('a whisper not addressed to the receiving cat never appears in that cat invocation context', async () => {
    const { MessageStore, hydrateReplyPreview, buildInvocationContext } = await loadModules();
    const store = new MessageStore();

    const whisperTrigger = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本，别声张',
      mentions: ['codex'],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    // gemini is NOT in whisperTo — this is the receiving cat in an A2A direct-message chain.
    const preview = await hydrateReplyPreview(store, whisperTrigger.id, { type: 'cat', catId: 'gemini' });
    const ctx = buildInvocationContext(buildA2AInvocationContextInput('gemini', preview));

    assert.ok(!ctx.includes('悄悄改一下密钥轮换脚本'), 'whisper content must never reach a non-recipient cat prompt');
    // Still identifies the A2A source and trigger id — just no leaked content.
    assert.ok(ctx.includes('本轮任务来源'), 'A2A framing should still be present');
  });

  test('the actual whisper recipient cat DOES see the trigger content when it triggers A2A to itself/onward', async () => {
    const { MessageStore, hydrateReplyPreview, buildInvocationContext } = await loadModules();
    const store = new MessageStore();

    const whisperTrigger = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '悄悄改一下密钥轮换脚本，别声张',
      mentions: ['codex'],
      timestamp: 1000,
      threadId: 'thread-1',
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    const preview = await hydrateReplyPreview(store, whisperTrigger.id, { type: 'cat', catId: 'codex' });
    const ctx = buildInvocationContext(buildA2AInvocationContextInput('codex', preview));

    assert.ok(ctx.includes('悄悄改一下密钥轮换脚本'), 'the authorized recipient cat should still see the real content');
  });

  test('a public trigger message reaches any cat normally (this sentinel is whisper-specific, not a general lockdown)', async () => {
    const { MessageStore, hydrateReplyPreview, buildInvocationContext } = await loadModules();
    const store = new MessageStore();

    const publicTrigger = store.append({
      userId: 'alice',
      catId: 'opus',
      content: '公开的派工内容',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const preview = await hydrateReplyPreview(store, publicTrigger.id, { type: 'cat', catId: 'codex' });
    const ctx = buildInvocationContext(buildA2AInvocationContextInput('codex', preview));

    assert.ok(ctx.includes('公开的派工内容'));
  });
});
