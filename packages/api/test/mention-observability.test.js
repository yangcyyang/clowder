/**
 * Inline @mention detection observability.
 *
 * Shadow detection was removed from routing. The remaining behavior is explicit:
 * strict inline action mentions get feedback/hints; narrative mentions are ignored.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

describe('inline mention observability counters', () => {
  it('exports strict inline mention counters from instruments.ts', async () => {
    const instruments = await import('../dist/infrastructure/telemetry/instruments.js');

    const expectedCounters = [
      'inlineActionChecked',
      'inlineActionDetected',
      'inlineActionFeedbackWritten',
      'inlineActionFeedbackWriteFailed',
      'inlineActionHintEmitted',
      'inlineActionHintEmitFailed',
      'lineStartDetected',
    ];

    for (const name of expectedCounters) {
      assert.ok(instruments[name], `instruments.ts should export counter: ${name}`);
      assert.equal(typeof instruments[name].add, 'function', `${name} should have .add() method`);
    }

    assert.equal(instruments.inlineActionShadowMiss, undefined, 'shadow miss counter was removed');
    assert.equal(instruments.inlineActionRoutedSetSkip, undefined, 'routedSet skip counter was removed');
  });
});

describe('strict inline action mention detection', () => {
  it('detects action-like inline mentions', async () => {
    await loadRealRoster();
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    const result = detectInlineActionMentions('Ready for @codex review', 'opus', []);

    assert.equal(result.length, 1);
    assert.equal(result[0].catId, 'codex');
  });

  it('ignores narrative inline mentions', async () => {
    await loadRealRoster();
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    const result = detectInlineActionMentions('之前 @codex 提出的方案不错', 'opus', []);

    assert.equal(result.length, 0);
  });

  it('ignores line-start mentions handled by A2A routing', async () => {
    await loadRealRoster();
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    const result = detectInlineActionMentions('@codex 请看一下', 'opus', []);

    assert.equal(result.length, 0);
  });

  it('ignores mentions inside fenced code blocks and blockquotes', async () => {
    await loadRealRoster();
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    assert.equal(detectInlineActionMentions('```\nReady for @codex review\n```', 'opus', []).length, 0);
    assert.equal(detectInlineActionMentions('> Ready for @codex review', 'opus', []).length, 0);
  });

  it('skips mentions already routed by line-start A2A', async () => {
    await loadRealRoster();
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    const result = detectInlineActionMentions('Ready for @codex review', 'opus', ['codex']);

    assert.equal(result.length, 0);
  });
});
