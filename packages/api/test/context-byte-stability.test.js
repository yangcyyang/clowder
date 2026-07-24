/**
 * ADR-024 W1-A → W2-D: Byte-stability CI gate.
 *
 * This encodes the POST-v2 invariant from
 * docs/decisions/024-kv-cache-friendly-context-layout.md 「验证计划 1」:
 *
 *   "同一 cat 相邻两次组装, [STATIC SYSTEM] 与工具定义字节一致;
 *    diff 仅出现在 meta 块与当前消息。"
 *
 * W2-D STATUS (2026-07-24): both tests below were un-skipped and run with
 * CONTEXT_CACHE_LAYOUT=v2 explicitly forced, per instruction — no assertion
 * was loosened to force green. Real, empirically-confirmed result:
 *
 *   - Test 2 (`buildSystemPrompt() carries zero per-turn content...`) is RED.
 *     Root cause (confirmed by reading SystemPromptBuilder.ts buildSystemPrompt,
 *     which W2-D must not modify — it's W2-C's active file): `buildSystemPrompt()`
 *     unconditionally does `parts = [staticPart, reviewerSection, dynamicPart
 *     (=buildInvocationContext)].join('\n\n')` — it has NO branch on
 *     CONTEXT_CACHE_LAYOUT or any `cacheLayout` field at all. W1-B shipped the
 *     v2 four-slot assembly as a wholly SEPARATE function,
 *     `buildV2TransportDispatch()` (src/domains/cats/services/agents/transport/
 *     build-v2-transport-dispatch.ts), which routes/route-parallel are expected
 *     to call INSTEAD of buildSystemPrompt() once the flag is on — that
 *     route-level dispatch switch is W2-C's in-flight work, not yet landed.
 *     So today, forcing the env flag changes nothing about buildSystemPrompt's
 *     output; the original skip-test's premise ("once CONTEXT_CACHE_LAYOUT=v2
 *     lands, buildSystemPrompt() carries zero per-turn content") does not match
 *     the shipped architecture — buildSystemPrompt is deliberately frozen as
 *     the byte-stable v1 legacy path (see the "v1 byte-equivalence (golden)"
 *     suite above, which pins buildInvocationContext/buildSystemPrompt to their
 *     pre-refactor bytes for exactly this reason: zero-risk merge for whichever
 *     caller is still on v1). Left UNSKIPPED and RED intentionally — this is a
 *     real, accurate signal that route-level v1/v2 dispatch is not wired yet,
 *     not a code bug for W2-D to patch (fixing it would mean editing
 *     SystemPromptBuilder.ts, which is out of W2-D's scope while W2-C owns it).
 *   - Test 3 (`diff between adjacent-turn prompts is confined to...`) was
 *     rewritten (per its own prior comment: "un-skip and rewrite against
 *     assembleTransportPayload once W1-B ships" — it has) to exercise the REAL
 *     v2 entry point, `buildV2TransportDispatch()`, instead of the frozen
 *     `buildSystemPrompt()`. It is GREEN: system + history slots are
 *     byte-identical across adjacent turns; only meta + userMsg differ. This
 *     is the actual, empirically-verified D3 invariant #2, just proven through
 *     the correct (shipped) API rather than the one the original placeholder
 *     assumed would be modified in place.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildSystemPrompt, buildStaticIdentity, buildReviewerSection, META_BLOCK_HEADER } = await import(
  '../dist/domains/cats/services/context/SystemPromptBuilder.js'
);

/** Same fixture shape as scripts/context-byte-stability.mjs — two adjacent
 *  turns of the same cat+thread, differing only in per-turn state ADR-024
 *  D1 classifies as "volatile" (session-writable, must never sit in system). */
function buildTurnContexts(catId) {
  const base = {
    catId,
    mode: 'independent',
    teammates: ['codex'],
    mcpAvailable: true,
    toolPolicy: 'full',
    threadId: `byte-stability-ci-${catId}`,
  };
  const turnN = {
    ...base,
    currentUserMessageId: 'msg-turn-n',
    contextUsageWarning: {
      ratio: 0.42,
      estimatedTokens: 42_000,
      maxPromptTokens: 100_000,
      level: 'caution',
      action: 'memory-writeback',
    },
  };
  const turnN1 = {
    ...base,
    currentUserMessageId: 'msg-turn-n-plus-1',
    contextUsageWarning: {
      ratio: 0.47,
      estimatedTokens: 47_000,
      maxPromptTokens: 100_000,
      level: 'caution',
      action: 'memory-writeback',
    },
  };
  return { turnN, turnN1 };
}

describe('ADR-024 byte-stability CI gate (v2 target)', () => {
  test(
    '[STATIC SYSTEM] (buildStaticIdentity + buildReviewerSection) is byte-identical across adjacent turns',
    async () => {
      const { turnN, turnN1 } = buildTurnContexts('opus');
      const staticN = buildStaticIdentity(turnN.catId, { mcpAvailable: turnN.mcpAvailable, toolPolicy: turnN.toolPolicy });
      const staticN1 = buildStaticIdentity(turnN1.catId, { mcpAvailable: turnN1.mcpAvailable, toolPolicy: turnN1.toolPolicy });
      assert.equal(staticN, staticN1, 'buildStaticIdentity must be byte-identical for the same cat+config (cacheClass=static)');

      const reviewerN = buildReviewerSection(turnN.catId);
      const reviewerN1 = buildReviewerSection(turnN1.catId);
      assert.equal(reviewerN, reviewerN1, 'buildReviewerSection must be byte-identical for the same cat (cacheClass=static)');
    },
  );

  test(
    '[W2-D EXPERIMENT] buildSystemPrompt() carries zero per-turn content once volatile fields move to the meta block (ADR-024 D1/D2)',
    {
      // 协调裁决（Fable, 2026-07-24, Wave-2 收尾）：re-skip。W1-B 落地的架构把 v1/v2
      // 选择放在路由层——v2 路径走 buildV2TransportDispatch()，从不调用 buildSystemPrompt()；
      // buildSystemPrompt 是 v1 专属通道（字节冻结由 golden 测试守护）。本断言的前提
      // （"v2 下 buildSystemPrompt 应稳定"）对准了错误的 API，正确的 v2 不变量已由下一个
      // 测试在 buildV2TransportDispatch 上断言（system/history 槽跨轮字节一致）。保留原
      // 断言文本与 W2-D 的实验记录以备考古；若未来 buildSystemPrompt 获得 layout 分支，
      // 翻开此测试即可。
      skip: 'v2 never routes through buildSystemPrompt (W1-B route-level dispatch); v2 invariant covered by the buildV2TransportDispatch test below',
    },
    async () => {
      // W2-D un-skip per task: explicitly force CONTEXT_CACHE_LAYOUT=v2 and run
      // the ORIGINAL assertion unchanged (no loosening) to see what actually
      // happens against the shipped W1-B architecture.
      const prevFlag = process.env.CONTEXT_CACHE_LAYOUT;
      process.env.CONTEXT_CACHE_LAYOUT = 'v2';
      try {
        const { getContextCacheLayout } = await import('../dist/config/context-cache-layout.js');
        assert.equal(getContextCacheLayout(process.env), 'v2', 'sanity: env flag is actually read as v2');

        const { turnN, turnN1 } = buildTurnContexts('opus');

        // Post-v2: buildInvocationContext's volatile lines (Task Gate msg id,
        // contextUsageWarning ratio, ping-pong streak, ...) no longer live inside
        // buildSystemPrompt at all — they're produced by buildTurnMetaBlock()
        // (ADR-024 影响面 table) and assembled into the meta slot by
        // assembleTransportPayload, positioned AFTER history and BEFORE the
        // current user message. buildSystemPrompt should therefore be a pure
        // function of (catId, mcpAvailable, toolPolicy) — identical across turns.
        const systemN = buildSystemPrompt(turnN);
        const systemN1 = buildSystemPrompt(turnN1);

        assert.equal(
          systemN,
          systemN1,
          '[STATIC SYSTEM] must be the ENTIRE system prompt post-v2 — any diff here means volatile ' +
            'content (buildInvocationContext) is still inlined ahead of history instead of living in ' +
            'the queue-tail meta block. Today this fails because Task Gate / contextUsageWarning / ' +
            'ping-pong-warning lines are concatenated into buildSystemPrompt() every turn.',
        );
      } finally {
        if (prevFlag === undefined) delete process.env.CONTEXT_CACHE_LAYOUT;
        else process.env.CONTEXT_CACHE_LAYOUT = prevFlag;
      }
    },
  );

  test(
    'diff between adjacent-turn prompts is confined to the meta block + current message (ADR-024 D3 invariant #2)',
    async () => {
      // W2-D un-skip + rewrite (per this test's own prior comment: "un-skip and
      // rewrite against assembleTransportPayload once W1-B ships" — it has).
      // The real v2 four-slot entry point is buildV2TransportDispatch(), NOT
      // buildSystemPrompt() (see the sibling test above — buildSystemPrompt is
      // deliberately frozen as the byte-stable v1 legacy path; route-level
      // v1/v2 dispatch selection is separate, pending W2-C wiring). This test
      // exercises the actual shipped v2 assembly primitive against two
      // adjacent turns of the SAME cat/thread, differing only in the fields
      // ADR-024 D1 classifies as volatile (contextUsageWarning, currentUserMessageId).
      const { buildV2TransportDispatch } = await import(
        '../dist/domains/cats/services/agents/transport/build-v2-transport-dispatch.js'
      );
      const { turnN, turnN1 } = buildTurnContexts('opus');

      const dispatchOpts = {
        catId: 'opus',
        staticIdentityOptions: { mcpAvailable: turnN.mcpAvailable, toolPolicy: turnN.toolPolicy },
        catModePrompt: 'MODE_PROMPT_MARKER',
        sessionBootstrap: 'BOOTSTRAP_MARKER',
        mcpInstructions: 'MCP_MARKER',
        historyText: 'HISTORY_MARKER (no new delivered messages between the two turns)',
      };

      const dN = buildV2TransportDispatch({ ...dispatchOpts, context: turnN, userMsg: 'turn N user message' });
      const dN1 = buildV2TransportDispatch({
        ...dispatchOpts,
        context: turnN1,
        userMsg: 'turn N+1 user message',
      });

      // system: frozen static prefix — must be byte-identical across turns.
      assert.equal(
        dN.transportPayload.system,
        dN1.transportPayload.system,
        'system slot must be byte-identical across adjacent turns (cacheClass=static)',
      );

      // history: append-only cacheable prefix — same delivered history in both
      // turns (no new messages), so it must be byte-identical too.
      assert.equal(
        dN.transportPayload.history,
        dN1.transportPayload.history,
        'history slot must be byte-identical when no new messages were delivered between turns',
      );

      // meta + userMsg are the ONLY slots allowed to differ turn-over-turn.
      assert.notEqual(
        dN.transportPayload.meta,
        dN1.transportPayload.meta,
        'sanity: meta SHOULD differ here (contextUsageWarning/currentUserMessageId changed) — ' +
          'otherwise this fixture is not exercising the volatile fields it claims to',
      );
      assert.ok(dN.transportPayload.meta.startsWith(META_BLOCK_HEADER));
      assert.ok(dN1.transportPayload.meta.startsWith(META_BLOCK_HEADER));

      // Whole-body confinement check: the -p body's common prefix must extend
      // at least up to the META marker — i.e. nothing before META differs.
      const iMetaN = dN.promptBody.indexOf(META_BLOCK_HEADER);
      const iMetaN1 = dN1.promptBody.indexOf(META_BLOCK_HEADER);
      assert.ok(iMetaN >= 0 && iMetaN1 >= 0);
      assert.equal(
        dN.promptBody.slice(0, iMetaN),
        dN1.promptBody.slice(0, iMetaN1),
        'everything before the META marker in the -p body (i.e. history) must be identical across turns',
      );
    },
  );
});
