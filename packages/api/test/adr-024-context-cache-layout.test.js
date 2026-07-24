/**
 * ADR-024 W1-B tests: KV-cache friendly context layout.
 *
 * Coverage:
 *  ① v1 byte-equivalence (golden snapshot captured from pre-refactor dist)
 *  ② v2 four-slot ordering [STATIC SYSTEM] → [HISTORY] → [META] → [CURRENT MSG]
 *  ③ META block carries the ADR volatile list; system carries none of it
 *  ④ F042 Identity line pinned in system, absent from META (D1 exception)
 *  ⑤ (existing route/prompt suites run separately for regression)
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const GOLDEN = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/adr-024-v1-golden.json'), 'utf8'),
);

// Same inputs used by scratchpad/capture-golden.mjs against the pre-refactor dist.
const STATIC_FULL_OPTS = {
  mcpAvailable: true,
  toolPolicy: 'standard',
  agentMemoryContext:
    '# Opus 记忆\n\n## 当前状态\n正在做 ADR-024 W1-B\n\n## 已关闭决策（别再提了）\n- 不再恢复 4 行硬限制\n\n## 行为偏好\n- 中文白话\n\n## 环境 gotcha\n- dist 需先 build',
  lessonsContext: '# Clowder 公共踩坑记录\n\n- textFold 不要匹配 heading\n- CSS 注释 xx-*/ 会炸 cssnano',
  projectContext:
    '## 项目简介（brief.md）\n# session-handoff\n\n## 验收标准\n- [ ] 可恢复\n\n## 项目进度（progress.md）\n# session-handoff 进度\n\n## 当前阶段\nPhase 8 项目公告板',
  maxPromptTokens: 100000,
  packBlocks: null,
};

const INVOCATION_FULL = {
  catId: 'opus',
  mode: 'serial',
  chainIndex: 2,
  chainTotal: 3,
  teammates: ['codex', 'gemini'],
  mcpAvailable: true,
  toolPolicy: 'standard',
  a2aEnabled: true,
  directMessageFrom: 'codex',
  a2aTriggerMessageId: 'msg-a2a-1',
  a2aTriggerContent: '砚砚请你接着做 transport seam',
  pingPongWarning: { pairedWith: 'codex', count: 2 },
  currentUserMessageId: 'msg-user-1',
  threadId: 'thread-1',
  currentTask: {
    id: 'task-1',
    parentThreadId: 'thread-parent',
    taskThreadId: 'thread-task',
    sourceMessageId: 'msg-root',
    ownerCatId: 'opus',
    status: 'doing',
  },
  promptTags: ['critique', 'skill:debugging'],
  skillRouterBlock: '## Skill Router（可用 Skill 菜单）\n- debugging: 排查 bug',
  skillRouterMatchedSkills: ['debugging'],
  voiceMode: true,
  contextUsageWarning: {
    ratio: 0.82,
    estimatedTokens: 82000,
    maxPromptTokens: 100000,
    level: 'high',
    action: 'memory-writeback',
  },
  sopStageHint: { stage: 'implementation', suggestedSkill: 'tdd', featureId: 'F999' },
};

const INVOCATION_PARALLEL = { catId: 'opus', mode: 'parallel', teammates: ['codex'], mcpAvailable: false };

async function builder() {
  return import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
}

describe('ADR-024 context-cache-layout flag', () => {
  test('getContextCacheLayout defaults to v1 and only "v2" opts in', async () => {
    const { getContextCacheLayout } = await import('../dist/config/context-cache-layout.js');
    assert.equal(getContextCacheLayout({}), 'v1');
    assert.equal(getContextCacheLayout({ CONTEXT_CACHE_LAYOUT: 'v1' }), 'v1');
    assert.equal(getContextCacheLayout({ CONTEXT_CACHE_LAYOUT: 'v2' }), 'v2');
    assert.equal(getContextCacheLayout({ CONTEXT_CACHE_LAYOUT: 'garbage' }), 'v1');
    assert.equal(getContextCacheLayout({ CONTEXT_CACHE_LAYOUT: 'V2' }), 'v1'); // exact match only
  });

  test('CONTEXT_CACHE_LAYOUT is registered in env-registry', async () => {
    const { ENV_VARS } = await import('../dist/config/env-registry.js');
    const entry = ENV_VARS.find((e) => e.name === 'CONTEXT_CACHE_LAYOUT');
    assert.ok(entry, 'CONTEXT_CACHE_LAYOUT must be registered');
    assert.equal(entry.category, 'governance');
    assert.equal(entry.defaultValue, 'v1');
  });
});

// ---------------------------------------------------------------------------
// ① v1 byte-equivalence — the zero-risk-merge guarantee
// ---------------------------------------------------------------------------
describe('ADR-024 v1 byte-equivalence (golden)', () => {
  test('buildStaticIdentity (full: memory+lessons+project) is byte-identical to pre-refactor', async () => {
    const { buildStaticIdentity } = await builder();
    assert.equal(buildStaticIdentity('opus', STATIC_FULL_OPTS), GOLDEN.staticFull);
  });

  test('buildStaticIdentity (minimal opus) is byte-identical', async () => {
    const { buildStaticIdentity } = await builder();
    assert.equal(buildStaticIdentity('opus'), GOLDEN.staticMinimal);
  });

  test('buildStaticIdentity (codex minimal toolPolicy) is byte-identical', async () => {
    const { buildStaticIdentity } = await builder();
    assert.equal(buildStaticIdentity('codex', { toolPolicy: 'minimal' }), GOLDEN.staticMinimalCodex);
  });

  test('buildInvocationContext (full rich context) is byte-identical', async () => {
    const { buildInvocationContext } = await builder();
    assert.equal(buildInvocationContext(INVOCATION_FULL), GOLDEN.invocationFull);
  });

  test('buildInvocationContext (parallel) is byte-identical', async () => {
    const { buildInvocationContext } = await builder();
    assert.equal(buildInvocationContext(INVOCATION_PARALLEL), GOLDEN.invocationParallel);
  });

  test('buildSystemPrompt (full) is byte-identical', async () => {
    const { buildSystemPrompt } = await builder();
    const out = buildSystemPrompt({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
    });
    assert.equal(out, GOLDEN.systemPromptFull);
  });

  test('buildInvocationContext === identity line + turn meta lines (refactor is a pure split)', async () => {
    const { buildInvocationContext, buildInvocationIdentityLine } = await builder();
    const combined = buildInvocationContext(INVOCATION_FULL);
    // identity line is the first line; the rest is the volatile turn body.
    const firstLine = combined.split('\n')[0];
    assert.equal(firstLine, buildInvocationIdentityLine(INVOCATION_FULL));
    assert.ok(firstLine.startsWith('Identity: '));
  });
});

// ---------------------------------------------------------------------------
// buildStaticIdentity v2 drops the session-writable blocks
// ---------------------------------------------------------------------------
describe('ADR-024 buildStaticIdentity cacheLayout=v2', () => {
  test('omits memory/lessons/project that v1 keeps inline', async () => {
    const { buildStaticIdentity } = await builder();
    const v1 = buildStaticIdentity('opus', STATIC_FULL_OPTS);
    const v2 = buildStaticIdentity('opus', { ...STATIC_FULL_OPTS, cacheLayout: 'v2' });

    // v1 has them
    assert.ok(v1.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(v1.includes('## 公共踩坑记录（LESSONS.md，低优先级）'));
    assert.ok(v1.includes('## 项目事实源四件套（只读参考）'));
    // v2 drops them
    assert.ok(!v2.includes('## 跨 Session 记忆（持久化）'));
    assert.ok(!v2.includes('## 公共踩坑记录（LESSONS.md，低优先级）'));
    assert.ok(!v2.includes('## 项目事实源四件套（只读参考）'));
    // but keeps the frozen static content
    assert.ok(v2.includes('## 队友名册'));
    assert.ok(v2.includes('会话理智线'));
  });
});

// ---------------------------------------------------------------------------
// ② + ③ + ④ v2 four-slot dispatch
// ---------------------------------------------------------------------------
describe('ADR-024 v2 four-slot transport dispatch', () => {
  async function dispatch() {
    const { buildV2TransportDispatch } = await import(
      '../dist/domains/cats/services/agents/transport/build-v2-transport-dispatch.js'
    );
    return buildV2TransportDispatch({
      catId: 'opus',
      context: INVOCATION_FULL,
      staticIdentityOptions: { mcpAvailable: true, packBlocks: null, toolPolicy: 'standard' },
      catModePrompt: 'MODE_PROMPT_MARKER',
      sessionBootstrap: 'BOOTSTRAP_MARKER',
      mcpInstructions: 'MCP_MARKER',
      historyText: 'HISTORY_MARKER',
      userMsg: 'USERMSG_MARKER',
      agentMemoryContext: STATIC_FULL_OPTS.agentMemoryContext,
      lessonsContext: STATIC_FULL_OPTS.lessonsContext,
      projectContext: STATIC_FULL_OPTS.projectContext,
      maxPromptTokens: 100000,
    });
  }

  test('② -p body strictly ordered history → meta → userMsg', async () => {
    const { META_BLOCK_HEADER } = await builder();
    const d = await dispatch();
    const iHistory = d.promptBody.indexOf('HISTORY_MARKER');
    const iMeta = d.promptBody.indexOf(META_BLOCK_HEADER);
    const iUser = d.promptBody.indexOf('USERMSG_MARKER');
    assert.ok(iHistory >= 0 && iMeta >= 0 && iUser >= 0);
    assert.ok(iHistory < iMeta, 'history must precede meta');
    assert.ok(iMeta < iUser, 'meta must precede userMsg (meta 不得在 userMsg 之后)');
  });

  test('② history slot keeps mode/bootstrap/mcp ahead of conversation history', async () => {
    const d = await dispatch();
    const h = d.transportPayload.history;
    assert.ok(
      h.indexOf('MODE_PROMPT_MARKER') < h.indexOf('BOOTSTRAP_MARKER'),
      'mode prompt before bootstrap',
    );
    assert.ok(h.indexOf('BOOTSTRAP_MARKER') < h.indexOf('MCP_MARKER'), 'bootstrap before mcp');
    assert.ok(h.indexOf('MCP_MARKER') < h.indexOf('HISTORY_MARKER'), 'mcp before history');
  });

  test('④ F042 Identity line pinned in system, ABSENT from META/history/userMsg', async () => {
    const d = await dispatch();
    assert.match(d.transportPayload.system, /Identity: 布偶猫[^\n]*\(@opus, model=/);
    assert.ok(!d.transportPayload.meta.includes('Identity: 布偶猫'), 'Identity must not appear in META');
    assert.ok(!d.transportPayload.history.includes('Identity: 布偶猫'));
    assert.ok(!d.transportPayload.userMsg.includes('Identity: 布偶猫'));
  });

  test('③ META carries the ADR volatile list; system carries none of it', async () => {
    const { META_BLOCK_HEADER } = await builder();
    const d = await dispatch();
    const { system, meta } = d.transportPayload;

    // META starts with the marker header and contains per-turn volatile content
    assert.ok(meta.startsWith(META_BLOCK_HEADER));
    for (const needle of [
      '## Clowder Task Gate（本轮动态）', // Task Gate
      'Context 理智线预警', // contextUsageWarning
      '## Skill Router', // Skill Router hit
      'Voice Mode ON', // voiceMode
      'A2A trigger message', // A2A source
      '乒乓球警告', // ping-pong warning
      '## 跨 Session 记忆（持久化）', // relocated memory (D1)
      '## 公共踩坑记录（LESSONS.md，低优先级）', // relocated lessons (D1)
      '## 项目事实源四件套（只读参考）', // relocated project (D1)
    ]) {
      assert.ok(meta.includes(needle), `META should include: ${needle}`);
    }

    // system must be free of every volatile marker above
    for (const banned of [
      '## Clowder Task Gate（本轮动态）',
      'Context 理智线预警',
      '## Skill Router',
      'Voice Mode ON',
      'A2A trigger message',
      '乒乓球警告',
      '## 跨 Session 记忆（持久化）',
      '## 公共踩坑记录（LESSONS.md，低优先级）',
      '## 项目事实源四件套（只读参考）',
    ]) {
      assert.ok(!system.includes(banned), `system must NOT include volatile: ${banned}`);
    }

    // system still carries the frozen static prefix
    assert.ok(system.includes('## 队友名册'));
    assert.ok(system.includes('会话理智线'));
  });

  test('buildTurnMetaBlock excludes the F042 Identity line (D1 exception)', async () => {
    const { buildTurnMetaBlock, META_BLOCK_HEADER } = await builder();
    const meta = buildTurnMetaBlock(INVOCATION_FULL, {
      agentMemoryContext: STATIC_FULL_OPTS.agentMemoryContext,
      lessonsContext: STATIC_FULL_OPTS.lessonsContext,
      projectContext: STATIC_FULL_OPTS.projectContext,
      maxPromptTokens: 100000,
    });
    assert.ok(meta.startsWith(META_BLOCK_HEADER));
    assert.ok(!meta.includes('Identity: 布偶猫'), 'F042 Identity line stays in system, not META');
    assert.ok(meta.includes('## Clowder Task Gate（本轮动态）'));
  });
});

// ---------------------------------------------------------------------------
// Transport seam structural invariants (ADR 落地设计项 2)
// ---------------------------------------------------------------------------
describe('ADR-024 transport seam', () => {
  test('assembleTransportPayload keeps four independent fields (no pre-join)', async () => {
    const { assembleTransportPayload } = await import(
      '../dist/domains/cats/services/agents/transport/assemble-transport-payload.js'
    );
    const p = assembleTransportPayload({ system: 'S', history: 'H', meta: 'M', userMsg: 'U' });
    assert.deepEqual(p, { system: 'S', history: 'H', meta: 'M', userMsg: 'U' });
  });

  test('renderTransportPromptBody = history → meta → userMsg, drops empty slots, excludes system', async () => {
    const { assembleTransportPayload, renderTransportPromptBody, SLOT_SEPARATOR } = await import(
      '../dist/domains/cats/services/agents/transport/assemble-transport-payload.js'
    );
    const full = renderTransportPromptBody(
      assembleTransportPayload({ system: 'S', history: 'H', meta: 'M', userMsg: 'U' }),
    );
    assert.equal(full, ['H', 'M', 'U'].join(SLOT_SEPARATOR));
    assert.ok(!full.includes('S'), 'system slot excluded from -p body');

    const noMeta = renderTransportPromptBody(
      assembleTransportPayload({ system: '', history: 'H', meta: '', userMsg: 'U' }),
    );
    assert.equal(noMeta, ['H', 'U'].join(SLOT_SEPARATOR));
  });
});

// ---------------------------------------------------------------------------
// D5 cacheClass scaffolding
// ---------------------------------------------------------------------------
describe('ADR-024 D5 cacheClass registry', () => {
  test('every registered section obeys its class → slot rule', async () => {
    const { findCacheClassViolations } = await import(
      '../dist/domains/cats/services/context/prompt-cache-class.js'
    );
    assert.deepEqual(findCacheClassViolations(), []);
  });

  test('volatile sections never sit in system; F042 identity is static in system', async () => {
    const { PROMPT_SECTION_REGISTRY } = await import(
      '../dist/domains/cats/services/context/prompt-cache-class.js'
    );
    for (const s of PROMPT_SECTION_REGISTRY) {
      if (s.cacheClass === 'volatile') assert.notEqual(s.slot, 'system', `${s.id} volatile must not be system`);
    }
    const identity = PROMPT_SECTION_REGISTRY.find((s) => s.id === 'f042-identity-line');
    assert.ok(identity);
    assert.equal(identity.cacheClass, 'static');
    assert.equal(identity.slot, 'system');
  });
});
