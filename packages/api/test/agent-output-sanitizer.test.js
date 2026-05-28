import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('agent output sanitizer', () => {
  async function getSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentVisibleOutput;
  }

  test('removes internal task protocol and citation markers', async () => {
    const sanitize = await getSanitizer();
    const output = sanitize('Task claim 00017799 已更新到 in_review，cite:turn0view0');

    assert.equal(output, '');
    assert.ok(!output.includes('Task claim'));
    assert.ok(!output.includes('in_review'));
    assert.ok(!output.includes('cite:turn0view0'));
  });

  test('keeps final conclusion while stripping citations and temp paths', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。citeturn0view0',
      '',
      '本地 clone 在 /tmp/pilotdeck-research，仅用于只读调研。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。'));
    assert.ok(!output.includes('cite'));
    assert.ok(!output.includes('/tmp/pilotdeck-research'));
  });

  test('drops only protocol blocks, not adjacent useful blocks', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '我接球做 OpenBMB/PilotDeck 调研。当前 $CLI 未注入，inbox 标记 requiresTask: no。',
      '',
      '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。');
  });
});
