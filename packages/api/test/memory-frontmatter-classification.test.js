/**
 * 批次 2-D 任务三: memory/candidates 与 notes 文件的四分类 frontmatter 约定
 * (type: user|feedback|project|reference, feedback 必带 why) + 写入三原则的
 * lint 式校验（先 warn 不拦）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const GATE_MODULE = '../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';

describe('memory frontmatter four-category classification', () => {
  describe('parseMemoryFrontmatter', () => {
    it('parses a well-formed frontmatter block', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      const raw = ['---', 'type: feedback', 'why: 用户明确纠正过一次', '---', '主消息要简短。'].join('\n');
      const { frontmatter, body } = parseMemoryFrontmatter(raw);
      assert.equal(frontmatter.type, 'feedback');
      assert.equal(frontmatter.why, '用户明确纠正过一次');
      assert.equal(body.trim(), '主消息要简短。');
    });

    it('returns frontmatter:null for content with no frontmatter block (backward compatible)', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      const raw = '# Opus 记忆\n\n## 当前状态\n无分类的既有记忆内容';
      const { frontmatter, body } = parseMemoryFrontmatter(raw);
      assert.equal(frontmatter, null);
      assert.equal(body, raw);
    });

    it('returns frontmatter:null for an unterminated frontmatter block (no throw)', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      const raw = '---\ntype: feedback\nno closing marker here';
      const { frontmatter, body } = parseMemoryFrontmatter(raw);
      assert.equal(frontmatter, null);
      assert.equal(body, raw);
    });

    it('drops unrecognized type values (only the closed set is valid)', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      const raw = '---\ntype: banana\n---\nbody text';
      const { frontmatter } = parseMemoryFrontmatter(raw);
      assert.equal(frontmatter.type, undefined);
    });

    it('never throws on malformed YAML', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      const raw = '---\ntype: [unclosed\n---\nbody';
      assert.doesNotThrow(() => parseMemoryFrontmatter(raw));
    });

    it('accepts all four category values', async () => {
      const { parseMemoryFrontmatter } = await import(GATE_MODULE);
      for (const type of ['user', 'feedback', 'project', 'reference']) {
        const raw = `---\ntype: ${type}\n---\nbody`;
        assert.equal(parseMemoryFrontmatter(raw).frontmatter.type, type);
      }
    });
  });

  describe('lintMemoryWriteCandidate (warn-only, three principles)', () => {
    it('warns when unclassified (no frontmatter type) — but this is not blocking', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const warnings = lintMemoryWriteCandidate({ candidateText: '一条普通记忆内容' });
      assert.ok(warnings.some((w) => w.startsWith('unclassified')));
    });

    it('warns when type=feedback but why is missing (structuring principle)', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const warnings = lintMemoryWriteCandidate({
        candidateText: '以后主消息要简短。',
        frontmatter: { type: 'feedback' },
      });
      assert.ok(warnings.some((w) => w.startsWith('feedback-missing-why')));
    });

    it('no why-warning when type=feedback and why is present', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const warnings = lintMemoryWriteCandidate({
        candidateText: '以后主消息要简短。',
        frontmatter: { type: 'feedback', why: '用户纠正过一次' },
      });
      assert.ok(!warnings.some((w) => w.startsWith('feedback-missing-why')));
      assert.ok(!warnings.some((w) => w.startsWith('unclassified')));
    });

    it('warns on session-temp content (selectivity red-line)', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const warnings = lintMemoryWriteCandidate({
        candidateText: '本次会话临时变量 foo=bar，仅暂存用于本轮计算。',
        frontmatter: { type: 'reference' },
      });
      assert.ok(warnings.some((w) => w.startsWith('selectivity')));
    });

    it('warns on long raw-dump-looking content (abstraction principle)', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const dump = `${'原始对话记录一行。\n'.repeat(60)}\`\`\`code fence looks like a transcript paste\`\`\``;
      const warnings = lintMemoryWriteCandidate({ candidateText: dump, frontmatter: { type: 'reference' } });
      assert.ok(warnings.some((w) => w.startsWith('abstraction')));
    });

    it('clean, classified, short, non-session-temp content produces zero warnings', async () => {
      const { lintMemoryWriteCandidate } = await import(GATE_MODULE);
      const warnings = lintMemoryWriteCandidate({
        candidateText: '端口改为 5173，已验证可连接。',
        frontmatter: { type: 'project' },
      });
      assert.deepEqual(warnings, []);
    });
  });

  describe('evaluateMemoryPromotion carries lintWarnings without changing the decision', () => {
    it('is backward compatible: no frontmatter → still evaluates normally + attaches lintWarnings', async () => {
      const { evaluateMemoryPromotion } = await import(GATE_MODULE);
      const evaluation = evaluateMemoryPromotion({
        candidateText: '完成了发票模块 Phase 3，测试全部通过。',
        existingMemory: '',
        userMessageText: '帮我完成发票模块 Phase 3',
      });
      assert.equal(evaluation.action, 'candidate');
      assert.ok(Array.isArray(evaluation.lintWarnings));
      assert.ok(evaluation.lintWarnings.some((w) => w.startsWith('unclassified')));
    });

    it('same candidate + same conflict decision regardless of frontmatter (lint never overrides action)', async () => {
      const { evaluateMemoryPromotion } = await import(GATE_MODULE);
      const existingMemory = '# Opus 记忆\n\n## 行为偏好（用户纠正过的）\n\n- 主消息要简短。\n';
      const withoutFrontmatter = evaluateMemoryPromotion({
        candidateText: '用户要求长报告，以后都输出长报告。',
        existingMemory,
      });
      const withFrontmatter = evaluateMemoryPromotion({
        candidateText: '用户要求长报告，以后都输出长报告。',
        existingMemory,
        frontmatter: { type: 'feedback', why: '用户明确要求' },
      });
      assert.equal(withoutFrontmatter.action, 'hold');
      assert.equal(withFrontmatter.action, 'hold');
      assert.equal(withoutFrontmatter.conflict.kind, withFrontmatter.conflict.kind);
      // Classified + why present → no missing-why / unclassified warnings.
      assert.ok(!withFrontmatter.lintWarnings.some((w) => w.startsWith('unclassified')));
      assert.ok(!withFrontmatter.lintWarnings.some((w) => w.startsWith('feedback-missing-why')));
      assert.ok(withoutFrontmatter.lintWarnings.some((w) => w.startsWith('unclassified')));
    });
  });
});
