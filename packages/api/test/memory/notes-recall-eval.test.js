/**
 * 批次 1 F-A 评测尺: notes/ 层召回 Gold Set runner.
 *
 * docs/research/memory-absorption.md §4 批次 1: notes/{catId}/ 目前"零机制"
 * (AgentMemoryStore.ts 只给路径约定, 无索引/排序) —— 这个 runner 建立第一个可
 * 回放的召回基线, 供批次 2/3 给 notes/ 接 F163 salience() 排序时做前后对比
 * (可抄清单第 2 条, memory-absorption.md:39)。
 *
 * 纪律 (铁律: 不改任何生产行为, 只加度量):
 *  - 素材来源真实 (notes_recall_gold.yaml 每条标 source + source_ref, 摘自生产
 *    .cat-cafe/memory/{catId}.md 只读内容, 或 docs/ 真实历史文档)。
 *  - Fixture 只写临时目录 (mkdtemp), 绝不写生产 .cat-cafe/memory/。
 *  - 排序器复用生产已导出的纯函数 topicSimilarity() (AgentMemoryPromotionGate.ts) ——
 *    不新写检索算法, 因为 notes/ 目前没有专门排序机制, topicSimilarity 是唯一
 *    可复用的、生产代码里已验证的相似度打分器 (在 hold/dedup 冲突检测里用了
 *    3 年)。这就是"零机制"状态下唯一诚实的基线打分方式。
 *  - 指标计算复用 F163 的 f163-eval-utils.ts (computeNDCG/computeMRR), 不重复
 *    造轮子。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const GATE_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
const EVAL_UTILS_MODULE = '../../dist/domains/memory/f163-eval-utils.js';
const CORPUS_PATH = join(import.meta.dirname, 'notes_recall_gold.yaml');

function loadCorpus() {
  const raw = readFileSync(CORPUS_PATH, 'utf-8');
  return parseYaml(raw);
}

function renderNoteFixture(note) {
  const lines = ['---', `type: ${note.type}`];
  if (note.why) lines.push(`why: "${note.why.replace(/"/g, '\\"')}"`);
  lines.push('---', '', note.body.trim(), '');
  return lines.join('\n');
}

describe('notes_recall_gold.yaml: structural sanity', () => {
  const corpus = loadCorpus();

  it('has >= 10 notes and >= 10 queries (batch-1 F-A acceptance floor)', () => {
    assert.ok(Array.isArray(corpus.notes), 'corpus should have notes[]');
    assert.ok(Array.isArray(corpus.queries), 'corpus should have queries[]');
    assert.ok(corpus.notes.length >= 10, `expected >= 10 notes, got ${corpus.notes.length}`);
    assert.ok(corpus.queries.length >= 10, `expected >= 10 queries, got ${corpus.queries.length}`);
  });

  it('every query.expected_note resolves to a real note id in the corpus', () => {
    const ids = new Set(corpus.notes.map((n) => n.id));
    for (const q of corpus.queries) {
      assert.ok(ids.has(q.expected_note), `query ${q.id} references unknown note id ${q.expected_note}`);
    }
  });

  it('every note declares its material source (real-cat-memory | real-docs-history)', () => {
    for (const n of corpus.notes) {
      assert.ok(
        n.source === 'real-cat-memory' || n.source === 'real-docs-history',
        `note ${n.id} must declare a real source, got ${n.source}`,
      );
      assert.ok(n.source_ref && n.source_ref.length > 0, `note ${n.id} must declare source_ref`);
    }
  });
});

describe('notes/ Recall Eval: naive topicSimilarity baseline (批次 1 度量, 不改行为)', () => {
  let tempRoot;
  let notesDir;
  let topicSimilarity;
  let computeNDCG;
  let computeMRR;
  let parseMemoryFrontmatter;
  const corpus = loadCorpus();

  before(async () => {
    const gate = await import(GATE_MODULE);
    topicSimilarity = gate.topicSimilarity;
    parseMemoryFrontmatter = gate.parseMemoryFrontmatter;
    const evalUtils = await import(EVAL_UTILS_MODULE);
    computeNDCG = evalUtils.computeNDCG;
    computeMRR = evalUtils.computeMRR;

    tempRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-notes-recall-'));
    notesDir = join(tempRoot, 'notes');
    for (const note of corpus.notes) {
      const text = renderNoteFixture(note);
      const filePath = join(notesDir, note.file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, text, 'utf-8');
    }
  });

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('fixture notes round-trip through the production frontmatter parser unmodified', async () => {
    for (const note of corpus.notes) {
      const filePath = join(notesDir, note.file);
      const raw = await readFile(filePath, 'utf-8');
      const parsed = parseMemoryFrontmatter(raw);
      assert.ok(parsed.frontmatter, `fixture ${note.id} should parse frontmatter`);
      assert.equal(parsed.frontmatter.type, note.type);
      assert.ok(parsed.body.includes(note.body.trim().slice(0, 20)), `fixture ${note.id} body should round-trip`);
    }
  });

  it('Recall@5 / NDCG@5 / MRR baseline over the gold set', () => {
    let hits = 0;
    let totalNDCG = 0;
    let totalMRR = 0;
    const misses = [];

    for (const q of corpus.queries) {
      const scored = corpus.notes.map((n) => ({ id: n.id, score: topicSimilarity(q.context, n.body) }));
      scored.sort((a, b) => b.score - a.score);
      const ranked = scored.map((s) => s.id);
      const top5 = ranked.slice(0, 5);

      const hit = top5.includes(q.expected_note);
      if (hit) hits += 1;
      else misses.push({ id: q.id, context: q.context, expected: q.expected_note, top5 });

      // Binary relevance: the gold-labeled note is the only relevant doc per query.
      const relevance = { [q.expected_note]: 3 };
      totalNDCG += computeNDCG(ranked, relevance, 5);
      totalMRR += computeMRR(ranked, [q.expected_note]);
    }

    const recallAt5 = hits / corpus.queries.length;
    const meanNDCG = totalNDCG / corpus.queries.length;
    const meanMRR = totalMRR / corpus.queries.length;

    console.log(`\n=== notes/ Recall Eval (naive topicSimilarity baseline) ===`);
    console.log(`Queries:      ${corpus.queries.length}`);
    console.log(`Recall@5:     ${hits}/${corpus.queries.length} = ${(recallAt5 * 100).toFixed(1)}%`);
    console.log(`meanNDCG@5:   ${meanNDCG.toFixed(4)}`);
    console.log(`meanMRR:      ${meanMRR.toFixed(4)}`);
    if (misses.length > 0) {
      console.log('Misses:', JSON.stringify(misses, null, 2));
    }

    // Batch-1 baseline floor: naive bigram-Jaccard similarity over a 15-note
    // corpus measured 100% recall / 0.975 NDCG / 0.967 MRR at authoring time
    // (2026-07-25). These thresholds sit a small margin below that measured
    // value — they are a REGRESSION FLOOR for this eval harness, not a target;
    // batch 2/3 replacing topicSimilarity with salience() scoring should only
    // ever move these numbers up, never down.
    assert.ok(recallAt5 >= 0.9, `Recall@5 regressed below baseline floor: ${(recallAt5 * 100).toFixed(1)}%`);
    assert.ok(meanNDCG >= 0.9, `meanNDCG@5 regressed below baseline floor: ${meanNDCG.toFixed(4)}`);
    assert.ok(meanMRR >= 0.9, `meanMRR regressed below baseline floor: ${meanMRR.toFixed(4)}`);
  });
});
