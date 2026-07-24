/**
 * ADR-024 D5 W2-D: cacheClass CI enforcement gate.
 *
 * docs/decisions/024-kv-cache-friendly-context-layout.md D5:
 *   "每个 prompt section 声明缓存级别，新加 section 必须归类，CI 强制"
 *   | cacheClass      | 位置规则                          |
 *   |-----------------|-----------------------------------|
 *   | static          | system prompt                     |
 *   | volatile        | 禁止进 system，只进队尾 meta       |
 *   | deterministic   | 可留在 history 段（append-only）   |
 *
 * prompt-cache-class.ts (W1-B) already ships the registry + the checker
 * function (`findCacheClassViolations`). This file is the CI-enforcement
 * layer W2-D owns:
 *   ① the real PROMPT_SECTION_REGISTRY is clean today (every section
 *      classified, every class→slot pairing legal) — red if a future PR adds
 *      an unclassified/mis-slotted section.
 *   ② `findCacheClassViolations` actually HAS detection teeth — proven via a
 *      full class×slot truth table on deliberately-violating fixtures, not
 *      just "the current registry happens to pass."
 *   ③ a structural assertion that volatile content never lands in the
 *      `system` slot, verified against the REAL v2 assembly path
 *      (`buildV2TransportDispatch`), not just registry metadata.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

const { PROMPT_SECTION_REGISTRY, findCacheClassViolations, isSlotAllowedForCacheClass, CACHE_CLASS_ALLOWED_SLOTS } =
  await import('../dist/domains/cats/services/context/prompt-cache-class.js');

const ALL_CACHE_CLASSES = ['static', 'volatile', 'deterministic'];
const ALL_SLOTS = ['system', 'history', 'meta', 'userMsg'];

// ---------------------------------------------------------------------------
// ① the live registry must be clean — CI's actual gate
// ---------------------------------------------------------------------------
describe('ADR-024 D5 CI gate: PROMPT_SECTION_REGISTRY is fully classified and legal', () => {
  test('findCacheClassViolations(PROMPT_SECTION_REGISTRY) is empty', () => {
    assert.deepEqual(findCacheClassViolations(), [], 'no section may violate its class→slot rule');
  });

  test('every section declares a cacheClass from the closed set {static, volatile, deterministic}', () => {
    for (const section of PROMPT_SECTION_REGISTRY) {
      assert.ok(
        ALL_CACHE_CLASSES.includes(section.cacheClass),
        `section "${section.id}" has an unrecognized/missing cacheClass: ${section.cacheClass}`,
      );
      assert.ok(
        ALL_SLOTS.includes(section.slot),
        `section "${section.id}" has an unrecognized/missing slot: ${section.slot}`,
      );
    }
  });

  test('every section id is unique (no silent shadowing in the registry)', () => {
    const ids = PROMPT_SECTION_REGISTRY.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate section ids would hide a mis-classification');
  });

  test('registry is non-empty (an empty registry would trivially "pass" the gate)', () => {
    assert.ok(PROMPT_SECTION_REGISTRY.length > 0);
  });
});

// ---------------------------------------------------------------------------
// ② detection efficacy — prove the gate actually catches bad data, on the
// full class × slot truth table (not just the one combo the shipped registry
// happens to exercise today).
// ---------------------------------------------------------------------------
describe('ADR-024 D5 CI gate: findCacheClassViolations has real detection teeth', () => {
  test('CACHE_CLASS_ALLOWED_SLOTS matches the D5 table exactly (pin against silent widening)', () => {
    assert.deepEqual([...CACHE_CLASS_ALLOWED_SLOTS.static], ['system']);
    assert.deepEqual([...CACHE_CLASS_ALLOWED_SLOTS.deterministic], ['history']);
    assert.deepEqual([...CACHE_CLASS_ALLOWED_SLOTS.volatile], ['meta', 'userMsg']);
  });

  for (const cacheClass of ALL_CACHE_CLASSES) {
    for (const slot of ALL_SLOTS) {
      const legal = isSlotAllowedForCacheClass(cacheClass, slot);
      test(`${cacheClass} → ${slot} is ${legal ? 'LEGAL (no violation)' : 'ILLEGAL (must be flagged)'}`, () => {
        const fixture = [{ id: 'fixture-section', cacheClass, slot, description: 'synthetic fixture' }];
        const violations = findCacheClassViolations(fixture);
        if (legal) {
          assert.deepEqual(violations, [], `${cacheClass}/${slot} is a legal pairing per D5 — must not be flagged`);
        } else {
          assert.deepEqual(
            violations,
            [{ id: 'fixture-section', cacheClass, slot }],
            `${cacheClass}/${slot} is illegal per D5 — must be flagged red`,
          );
        }
      });
    }
  }

  test('volatile-in-system is specifically caught (the D5 hard rule)', () => {
    const fixture = [
      ...PROMPT_SECTION_REGISTRY,
      { id: 'regression-fixture-volatile-in-system', cacheClass: 'volatile', slot: 'system', description: 'must be caught' },
    ];
    const violations = findCacheClassViolations(fixture);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, 'regression-fixture-volatile-in-system');
  });

  test('multiple simultaneous violations are all reported, not just the first', () => {
    const fixture = [
      { id: 'bad-1', cacheClass: 'volatile', slot: 'system', description: 'x' },
      { id: 'ok-1', cacheClass: 'static', slot: 'system', description: 'x' },
      { id: 'bad-2', cacheClass: 'deterministic', slot: 'meta', description: 'x' },
    ];
    const violations = findCacheClassViolations(fixture);
    assert.deepEqual(
      violations.map((v) => v.id).sort(),
      ['bad-1', 'bad-2'],
    );
  });
});

// ---------------------------------------------------------------------------
// ③ structural assertion using the REAL v2 assembly path — not just registry
// metadata. Volatile content must never reach the `system` slot in practice.
// ---------------------------------------------------------------------------
describe('ADR-024 D5 structural assertion: volatile content never reaches system (real v2 path)', () => {
  test('buildV2TransportDispatch: system slot carries none of the registry-declared volatile markers', async () => {
    const { buildV2TransportDispatch } = await import(
      '../dist/domains/cats/services/agents/transport/build-v2-transport-dispatch.js'
    );

    // A context that fires every volatile section this registry knows about
    // (Task Gate, contextUsageWarning, Skill Router hit, voiceMode, A2A
    // source, ping-pong warning, plus the relocated memory/lessons/project
    // blocks).
    const context = {
      catId: 'opus',
      mode: 'serial',
      teammates: ['codex'],
      mcpAvailable: true,
      toolPolicy: 'standard',
      a2aEnabled: true,
      directMessageFrom: 'codex',
      a2aTriggerMessageId: 'msg-a2a-1',
      a2aTriggerContent: 'trigger content',
      pingPongWarning: { pairedWith: 'codex', count: 2 },
      currentUserMessageId: 'msg-user-1',
      threadId: 'thread-d5',
      skillRouterBlock: '## Skill Router（可用 Skill 菜单）\n- debugging: 排查 bug',
      voiceMode: true,
      contextUsageWarning: {
        ratio: 0.82,
        estimatedTokens: 82000,
        maxPromptTokens: 100000,
        level: 'high',
        action: 'memory-writeback',
      },
    };

    const d = buildV2TransportDispatch({
      catId: 'opus',
      context,
      staticIdentityOptions: { mcpAvailable: true, toolPolicy: 'standard' },
      historyText: 'HISTORY_MARKER',
      userMsg: 'USERMSG_MARKER',
      agentMemoryContext: '# memory\nsome persisted memory content',
      lessonsContext: '# lessons\nsome lessons content',
      projectContext: '## project brief\nsome project content',
      maxPromptTokens: 100000,
    });

    const { system, meta } = d.transportPayload;

    // Every section this registry classifies `volatile` maps to a
    // recognizable literal marker in the rendered text — assert each is
    // present in meta and absent from system, driven by the registry, not a
    // hardcoded copy of the ADR's prose list.
    const volatileMarkersById = {
      'turn-meta': '## Clowder Task Gate',
      'cross-session-memory': 'some persisted memory content',
      'lessons-context': 'some lessons content',
      'project-context': 'some project content',
    };

    for (const section of PROMPT_SECTION_REGISTRY.filter((s) => s.cacheClass === 'volatile')) {
      const marker = volatileMarkersById[section.id];
      if (!marker) continue; // sections without a fixture-visible literal marker are skipped
      assert.ok(meta.includes(marker), `expected volatile section "${section.id}"'s marker in meta`);
      assert.ok(!system.includes(marker), `volatile section "${section.id}" leaked into system (D5 hard rule violated)`);
    }

    // Belt-and-suspenders: the registry's own class→slot mapping for every
    // volatile entry forbids `system`, cross-checked against the live function.
    for (const section of PROMPT_SECTION_REGISTRY.filter((s) => s.cacheClass === 'volatile')) {
      assert.equal(isSlotAllowedForCacheClass(section.cacheClass, 'system'), false);
    }
  });
});
