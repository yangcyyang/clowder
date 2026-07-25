/**
 * 批次 2 (PRD-memory-upgrade.md F-B + F-C) — hold 出口子建议 + frontmatter
 * 失效字段扩展。
 *
 * F-B: evaluateMemoryPromotion 的 hold 出口（closed-decision / port / brevity
 * 三个既有冲突检测器）附加 mergeable/supersede 子建议——影子模式，只生成建议
 * 文案，不改变 action 的 promote/candidate/hold/skip 归类，不换检测算法（复用
 * findClosedDecisionConflict/findPortConflict/findBrevityConflict/
 * topicSimilarity 的既有产出）。
 *
 * F-C: MemoryFrontmatter 扩展 valid_from/invalid_at/superseded_by（对齐 F163
 * knowledge-layer schema，docs/features/F163-memory-entropy-reduction.md:70-76，
 * 落到 Memory 层）。isMemoryFrontmatterExpired 是冲突触发失效的判定——缺省字
 * 段 = 永远有效（向后兼容），不做任何时间自动衰减之外的事。
 *
 * 铁律核对：user_profile_classification_gold.yaml 12 例的 action/skipReason/
 * reviewer/conflict.kind/key/flagged 判定必须逐字不变（该 gold set 自己的
 * runner，test/memory/user-profile-classification-eval.test.js，已单独覆盖并
 * 通过）；本文件只新增断言 suggestion 字段的存在/缺失，不重复跑 diff。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const GATE_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
const PROMPT_MODULE = '../../dist/domains/cats/services/context/SystemPromptBuilder.js';
const GOLD_CORPUS_PATH = join(import.meta.dirname, 'user_profile_classification_gold.yaml');

let gate;
let prompt;

before(async () => {
  gate = await import(GATE_MODULE);
  prompt = await import(PROMPT_MODULE);
});

function loadGoldCorpus() {
  return parseYaml(readFileSync(GOLD_CORPUS_PATH, 'utf-8'));
}

// ---------------------------------------------------------------------------
// F-C: MemoryFrontmatter valid_from/invalid_at/superseded_by round-trip
// ---------------------------------------------------------------------------
describe('F-C: MemoryFrontmatter valid_from/invalid_at/superseded_by', () => {
  it('parses all three fields when present and well-formed', () => {
    const raw = [
      '---',
      'type: reference',
      'valid_from: 2026-06-01',
      'invalid_at: 2026-07-20',
      'superseded_by: cand-123-0',
      '---',
      '',
      '旧内容正文',
      '',
    ].join('\n');
    const parsed = gate.parseMemoryFrontmatter(raw);
    assert.ok(parsed.frontmatter);
    assert.equal(parsed.frontmatter.valid_from, '2026-06-01');
    assert.equal(parsed.frontmatter.invalid_at, '2026-07-20');
    assert.equal(parsed.frontmatter.superseded_by, 'cand-123-0');
    assert.ok(parsed.body.includes('旧内容正文'));
  });

  it('backward-compatible: absent fields parse to undefined, never throw', () => {
    const raw = ['---', 'type: user', '---', '', '偏好正文', ''].join('\n');
    const parsed = gate.parseMemoryFrontmatter(raw);
    assert.ok(parsed.frontmatter);
    assert.equal(parsed.frontmatter.valid_from, undefined);
    assert.equal(parsed.frontmatter.invalid_at, undefined);
    assert.equal(parsed.frontmatter.superseded_by, undefined);
  });

  it('a document with no frontmatter at all round-trips unchanged (existing notes/index files)', () => {
    const raw = '# grok 记忆\n\n## 当前状态\n\n- 正常内容\n';
    const parsed = gate.parseMemoryFrontmatter(raw);
    assert.equal(parsed.frontmatter, null);
    assert.equal(parsed.body, raw);
  });

  it('drops malformed invalid_at/valid_from (wrong type or non-date string), keeps other fields', () => {
    const raw = [
      '---',
      'type: reference',
      'valid_from: 12345',
      'invalid_at: "not-a-date"',
      'superseded_by: 42',
      '---',
      '',
      '正文',
      '',
    ].join('\n');
    const parsed = gate.parseMemoryFrontmatter(raw);
    assert.ok(parsed.frontmatter);
    assert.equal(parsed.frontmatter.type, 'reference');
    assert.equal(parsed.frontmatter.valid_from, undefined, 'numeric YAML value is not a string, must be dropped');
    assert.equal(parsed.frontmatter.invalid_at, undefined, 'non-ISO-date string must be dropped');
    assert.equal(parsed.frontmatter.superseded_by, undefined, 'numeric YAML value is not a string, must be dropped');
  });

  it('accepts a full ISO datetime (not just YYYY-MM-DD) for invalid_at', () => {
    const raw = ['---', 'invalid_at: 2026-07-20T10:00:00.000Z', '---', '', 'x', ''].join('\n');
    const parsed = gate.parseMemoryFrontmatter(raw);
    assert.equal(parsed.frontmatter.invalid_at, '2026-07-20T10:00:00.000Z');
  });
});

describe('F-C: isMemoryFrontmatterExpired — conflict-triggered, fail-open', () => {
  const REF_MS = Date.parse('2026-07-25T00:00:00.000Z');

  it('no frontmatter at all => never expired', () => {
    assert.equal(gate.isMemoryFrontmatterExpired(null, REF_MS), false);
    assert.equal(gate.isMemoryFrontmatterExpired(undefined, REF_MS), false);
  });

  it('frontmatter present but no invalid_at => never expired (default = always valid)', () => {
    assert.equal(gate.isMemoryFrontmatterExpired({ type: 'reference' }, REF_MS), false);
  });

  it('invalid_at in the future => not yet expired', () => {
    assert.equal(gate.isMemoryFrontmatterExpired({ invalid_at: '2026-08-01' }, REF_MS), false);
  });

  it('invalid_at in the past (or exactly now) => expired', () => {
    assert.equal(gate.isMemoryFrontmatterExpired({ invalid_at: '2026-07-01' }, REF_MS), true);
    assert.equal(gate.isMemoryFrontmatterExpired({ invalid_at: '2026-07-25T00:00:00.000Z' }, REF_MS), true);
  });

  it('malformed invalid_at (unparseable) fails open => not expired, never throws', () => {
    assert.equal(gate.isMemoryFrontmatterExpired({ invalid_at: 'banana' }, REF_MS), false);
  });
});

// ---------------------------------------------------------------------------
// F-B: evaluateMemoryPromotion hold-exit sub-suggestion
// ---------------------------------------------------------------------------
describe('F-B: hold-mergeable / hold-supersede sub-suggestion', () => {
  const NOW = 1_700_000_000_000; // fixed clock for deterministic proposedFrontmatterPatch.invalid_at

  it('closed-decision conflicts are ALWAYS supersede, even with high topicSimilarity', () => {
    const existingMemory =
      '# grok 记忆\n\n## 已关闭决策（别再提了）\n\n- 不手动重跑断更期间的推特采集任务，等自动巡检恢复。\n';
    const candidate = '手动重跑断更期间的推特采集任务';
    const result = gate.evaluateMemoryPromotion({ candidateText: candidate, existingMemory, now: NOW });

    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'closed-decision');
    assert.ok(result.suggestion, 'hold must carry a suggestion');
    assert.equal(result.suggestion.kind, 'supersede');
    assert.equal(result.suggestion.staleLine, '不手动重跑断更期间的推特采集任务，等自动巡检恢复。');
    assert.equal(result.suggestion.proposedFrontmatterPatch.invalid_at, new Date(NOW).toISOString());
    assert.match(result.suggestion.proposedFrontmatterPatch.superseded_by, /人审/);
  });

  it('port conflict with HIGH topicSimilarity (same-entry updated wording) => mergeable', () => {
    const existingMemory = '# grok 记忆\n\n## 硬约束\n\n- 本地开发环境统一使用端口 3003 启动前端服务，禁止改动\n';
    const candidate = '本地开发环境统一使用端口 3009 启动前端服务，禁止改动';
    const result = gate.evaluateMemoryPromotion({ candidateText: candidate, existingMemory, now: NOW });

    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'fact');
    assert.equal(result.conflict.key, 'port');
    assert.equal(result.suggestion.kind, 'mergeable');
    assert.ok(result.suggestion.similarity >= 0.5);
    assert.ok(result.suggestion.mergedText.includes('3003'));
    assert.ok(result.suggestion.mergedText.includes('3009'));
  });

  it('port conflict with LOW topicSimilarity (different specific values/context) => supersede', () => {
    const existingMemory = '# 铲屎官画像\n\n## 硬约束\n\n- [2026-07-01] 服务默认端口 3003\n';
    const candidate = '服务这次端口改成了 3005，注意更新';
    const result = gate.evaluateMemoryPromotion({ candidateText: candidate, existingMemory, now: NOW });

    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'fact');
    assert.equal(result.suggestion.kind, 'supersede');
    assert.ok(result.suggestion.similarity < 0.5);
  });

  it('brevity conflict with HIGH topicSimilarity => mergeable', () => {
    const existingMemory = '# 铲屎官画像\n\n## 偏好\n\n- 汇报周报的时候消息回复要简短\n';
    const candidate = '汇报周报的时候消息回复要详细完整';
    const result = gate.evaluateMemoryPromotion({ candidateText: candidate, existingMemory, now: NOW });

    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'preference');
    assert.equal(result.suggestion.kind, 'mergeable');
  });

  it('brevity conflict with LOW topicSimilarity => supersede', () => {
    const existingMemory = '# 铲屎官画像\n\n## 偏好\n\n- [2026-07-01] 消息回复要简短\n';
    const candidate = '以后请给详细报告，把内容都写全';
    const result = gate.evaluateMemoryPromotion({ candidateText: candidate, existingMemory, now: NOW });

    assert.equal(result.action, 'hold');
    assert.equal(result.conflict.kind, 'preference');
    assert.equal(result.suggestion.kind, 'supersede');
  });

  it('suggestion is undefined for skip/candidate/promote actions (only hold carries a suggestion)', () => {
    const skip = gate.evaluateMemoryPromotion({ candidateText: '仅本次会话有效的临时安排', existingMemory: '' });
    assert.equal(skip.action, 'skip');
    assert.equal(skip.suggestion, undefined);

    const candidateAction = gate.evaluateMemoryPromotion({
      candidateText: '项目 API 服务运行在 3004 端口',
      existingMemory: '',
    });
    assert.equal(candidateAction.action, 'candidate');
    assert.equal(candidateAction.suggestion, undefined);

    const promote = gate.evaluateMemoryPromotion({
      candidateText: '以后周报默认发给我和运营同事两个人',
      userMessageText: '记住：以后周报默认发给我和运营同事两个人',
      existingMemory: '',
    });
    assert.equal(promote.action, 'promote');
    assert.equal(promote.suggestion, undefined);
  });
});

// ---------------------------------------------------------------------------
// 批次 1 基线对齐: gold set 判定零漂移 + suggestion 只出现在 hold
// ---------------------------------------------------------------------------
describe('批次 1 基线对齐: user_profile_classification_gold.yaml 12 例判定不变', () => {
  const corpus = loadGoldCorpus();

  it('every hold case in the gold set now carries a suggestion; every non-hold case does not', () => {
    for (const c of corpus.cases) {
      const actual = gate.evaluateMemoryPromotion({
        candidateText: c.input.candidateText,
        existingMemory: c.input.existingMemory ?? '',
        userMessageText: c.input.userMessageText,
        queuedContents: c.input.queuedContents,
      });
      // Zero-drift guard: the action itself must still match gold — this is the
      // same assertion user-profile-classification-eval.test.js already makes;
      // repeated here narrowly (action only) as a local sanity check for this
      // file's own suggestion-presence assertions.
      assert.equal(actual.action, c.expected.action, `${c.id}: action classification must not drift`);
      if (actual.action === 'hold') {
        assert.ok(actual.suggestion, `${c.id}: hold must carry a suggestion`);
        assert.ok(['mergeable', 'supersede'].includes(actual.suggestion.kind));
      } else {
        assert.equal(actual.suggestion, undefined, `${c.id}: only hold carries a suggestion`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F-C injection side: v2 index-layer render point skips expired whole-file
// frontmatter (notes/ itself has zero injection mechanism today — confirmed
// via AgentMemoryStore.ts's own doc comment "不新增读取机制"; the only real,
// existing render point for memory content is the v2 index-layer full-text
// injection, buildAgentMemoryIndexLines, reached through buildTurnMetaBlock).
// ---------------------------------------------------------------------------
describe('F-C injection: v2 index-layer render point skips expired frontmatter', () => {
  const baseExtras = { lessonsContext: null, projectContext: null, maxPromptTokens: 100000 };
  const baseContext = { catId: 'opus', mode: 'parallel', teammates: ['codex'], mcpAvailable: false };

  it('index content with NO frontmatter (current production shape) renders unchanged', () => {
    const agentMemoryContext = '# Opus 记忆\n\n## 当前状态\n\n- 正常工作中\n';
    const meta = prompt.buildTurnMetaBlock(baseContext, { ...baseExtras, agentMemoryContext });
    assert.ok(meta.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(meta.includes('正常工作中'));
  });

  it('index content with non-expired invalid_at frontmatter still renders (body stripped of frontmatter block)', () => {
    const agentMemoryContext = ['---', 'invalid_at: 2099-01-01', '---', '', '# Opus 记忆', '', '- 未来才失效'].join(
      '\n',
    );
    const meta = prompt.buildTurnMetaBlock(baseContext, { ...baseExtras, agentMemoryContext });
    assert.ok(meta.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(meta.includes('未来才失效'));
  });

  it('index content with an EXPIRED invalid_at frontmatter is skipped entirely at the v2 render point', () => {
    const agentMemoryContext = [
      '---',
      'invalid_at: 2020-01-01',
      '---',
      '',
      '# Opus 记忆',
      '',
      '- 这条不应该被注入',
    ].join('\n');
    const meta = prompt.buildTurnMetaBlock(baseContext, { ...baseExtras, agentMemoryContext });
    assert.ok(!meta.includes('## 跨 Session 记忆（持久化）'), 'expired index content must not be injected at all');
    assert.ok(!meta.includes('这条不应该被注入'));
  });
});
