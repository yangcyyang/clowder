/**
 * 批次 1 F-A 评测尺: USER.md 晋级分类准确率 Gold Set runner.
 *
 * docs/research/memory-absorption.md §4 批次 1: "USER.md 候选队列准确率"。
 * UserProfilePromotionGate.ts is intentionally thin — it reuses
 * AgentMemoryPromotionGate.ts's `evaluateMemoryPromotion` wholesale (catId key
 * 'USER'), which is a deterministic rule table (see that file's "Decision
 * order" doc comment). That determinism is exactly what makes it a clean gold
 * test: same input always produces the same action, no LLM/network/fixture
 * needed.
 *
 * 铁律 (不改任何生产行为, 只加度量): this test ONLY imports
 * `evaluateMemoryPromotion` from the built production module and asserts
 * against it — UserProfilePromotionGate.ts / AgentMemoryPromotionGate.ts are
 * not touched by this feature (批次 2/3 own extending the hold branch into
 * hold-mergeable/hold-supersede).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const GATE_MODULE = '../../dist/domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
const CORPUS_PATH = join(import.meta.dirname, 'user_profile_classification_gold.yaml');

function loadCorpus() {
  const raw = readFileSync(CORPUS_PATH, 'utf-8');
  return parseYaml(raw);
}

/** Compare the actual evaluation against the gold `expected` block. Returns a list of mismatch strings (empty = match). */
function diffAgainstExpected(actual, expected) {
  const problems = [];
  if (expected.action !== undefined && actual.action !== expected.action) {
    problems.push(`action: expected ${expected.action}, got ${actual.action}`);
  }
  if (expected.skipReason !== undefined && actual.skipReason !== expected.skipReason) {
    problems.push(`skipReason: expected ${expected.skipReason}, got ${actual.skipReason}`);
  }
  if (expected.reviewer !== undefined && actual.reviewer !== expected.reviewer) {
    problems.push(`reviewer: expected ${expected.reviewer}, got ${actual.reviewer}`);
  }
  if (expected.conflictKind !== undefined && actual.conflict?.kind !== expected.conflictKind) {
    problems.push(`conflict.kind: expected ${expected.conflictKind}, got ${actual.conflict?.kind}`);
  }
  if (expected.conflictKey !== undefined && actual.conflict?.key !== expected.conflictKey) {
    problems.push(`conflict.key: expected ${expected.conflictKey}, got ${actual.conflict?.key}`);
  }
  if (expected.conflictFlagged !== undefined && actual.conflict?.flagged !== expected.conflictFlagged) {
    problems.push(`conflict.flagged: expected ${expected.conflictFlagged}, got ${actual.conflict?.flagged}`);
  }
  return problems;
}

describe('user_profile_classification_gold.yaml: structural sanity', () => {
  const corpus = loadCorpus();

  it('has >= 10 cases (batch-1 F-A acceptance floor)', () => {
    assert.ok(Array.isArray(corpus.cases), 'corpus should have cases[]');
    assert.ok(corpus.cases.length >= 10, `expected >= 10 cases, got ${corpus.cases.length}`);
  });

  it('every case declares which evaluateMemoryPromotion rule it exercises', () => {
    for (const c of corpus.cases) {
      assert.ok(c.rule && c.rule.length > 0, `case ${c.id} must declare a rule label`);
    }
  });

  it('covers all four promotion actions (promote/candidate/hold/skip)', () => {
    const actions = new Set(corpus.cases.map((c) => c.expected.action));
    for (const action of ['promote', 'candidate', 'hold', 'skip']) {
      assert.ok(actions.has(action), `gold set should cover action=${action}`);
    }
  });
});

describe('USER.md promotion classification accuracy (评测尺, 直接跑生产 evaluateMemoryPromotion)', () => {
  let evaluateMemoryPromotion;
  const corpus = loadCorpus();

  before(async () => {
    const gate = await import(GATE_MODULE);
    evaluateMemoryPromotion = gate.evaluateMemoryPromotion;
  });

  it('classification accuracy == 100% against the gold set', () => {
    let correct = 0;
    const failures = [];

    for (const c of corpus.cases) {
      const actual = evaluateMemoryPromotion({
        candidateText: c.input.candidateText,
        existingMemory: c.input.existingMemory ?? '',
        userMessageText: c.input.userMessageText,
        queuedContents: c.input.queuedContents,
      });
      const problems = diffAgainstExpected(actual, c.expected);
      if (problems.length === 0) {
        correct += 1;
      } else {
        failures.push({ id: c.id, rule: c.rule, problems });
      }
    }

    const accuracy = correct / corpus.cases.length;
    console.log(`\n=== USER.md promotion classification accuracy ===`);
    console.log(`Cases:     ${corpus.cases.length}`);
    console.log(`Correct:   ${correct}`);
    console.log(`Accuracy:  ${(accuracy * 100).toFixed(1)}%`);
    if (failures.length > 0) {
      console.log('Failures:', JSON.stringify(failures, null, 2));
    }

    // evaluateMemoryPromotion is a deterministic rule table (not a model) —
    // batch-1 baseline is 100% by construction (each gold case is authored
    // against a specific numbered rule branch). Any regression here means the
    // rule table itself changed, which is exactly the signal batch-2's
    // hold-mergeable/hold-supersede work needs to watch for.
    assert.equal(failures.length, 0, `classification mismatches: ${JSON.stringify(failures, null, 2)}`);
    assert.equal(accuracy, 1, `expected 100% accuracy on deterministic rule table, got ${(accuracy * 100).toFixed(1)}%`);
  });

  it('individual per-rule assertions (readable failure messages per case)', () => {
    for (const c of corpus.cases) {
      const actual = evaluateMemoryPromotion({
        candidateText: c.input.candidateText,
        existingMemory: c.input.existingMemory ?? '',
        userMessageText: c.input.userMessageText,
        queuedContents: c.input.queuedContents,
      });
      const problems = diffAgainstExpected(actual, c.expected);
      assert.equal(problems.length, 0, `${c.id} (${c.rule}): ${problems.join('; ')}`);
    }
  });
});
