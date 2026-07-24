/**
 * ADR-024 W1-A: Context byte-stability measurement harness.
 *
 * Standalone, read-only harness — does NOT change any context-assembly logic.
 * It exercises the same assembly entry points production code uses
 * (SystemPromptBuilder.buildSystemPrompt / buildStaticIdentity /
 * buildReviewerSection / buildInvocationContext, and
 * route-helpers.assembleIncrementalContext) against in-memory stores (no
 * Redis, no network), for the SAME cat+thread across two adjacent turns, and
 * reports which byte ranges changed.
 *
 * This is the empirical counterpart to ADR-024 §Context (docs/decisions/024-
 * kv-cache-friendly-context-layout.md) and its verification plan item 1:
 * "同一 cat 相邻两次组装, [STATIC SYSTEM] 与工具定义字节一致; diff 仅出现在 meta 块与当前消息。"
 * Today (v1 layout, pre-ADR), this harness is EXPECTED to show diffs leaking
 * outside a hypothetical meta block — that is the baseline this script exists
 * to document, not a bug in the harness.
 *
 * Usage:
 *   node scripts/context-byte-stability.mjs                 # runs default cat profiles
 *   node scripts/context-byte-stability.mjs --cats=opus,codex
 *
 * Requires a built dist/ (this repo's tests already assume `pnpm run build`
 * has been run — see packages/api/package.json `test` script and
 * test/system-prompt-builder.test.js / test/f148-assemble-incremental.test.js
 * for the same dist-import convention this script follows).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const CAT_TEMPLATE_PATH = path.join(repoRoot, 'cat-template.json');

// ─── Dist imports (mirrors test/system-prompt-builder.test.js and
//     test/f148-assemble-incremental.test.js — same "import from dist" convention
//     every packages/api test uses; see packages/api/package.json `test` script) ──

const { loadCatConfig, toAllCatConfigs } = await import(path.join(apiRoot, 'dist/config/cat-config-loader.js'));
const { buildSystemPrompt, buildStaticIdentity, buildReviewerSection, buildInvocationContext } = await import(
  path.join(apiRoot, 'dist/domains/cats/services/context/SystemPromptBuilder.js')
);
const { assembleIncrementalContext } = await import(
  path.join(apiRoot, 'dist/domains/cats/services/agents/routing/route-helpers.js')
);
const { MessageStore } = await import(path.join(apiRoot, 'dist/domains/cats/services/stores/ports/MessageStore.js'));
const { DeliveryCursorStore } = await import(
  path.join(apiRoot, 'dist/domains/cats/services/stores/ports/DeliveryCursorStore.js')
);

// ─── Cat registry bootstrap (no Redis, no catalog overlay — same pattern as
//     test/helpers/setup-cat-registry.js) ─────────────────────────────────────

function registerAllCats() {
  const allConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) catRegistry.register(id, config);
  }
}
registerAllCats();

// ─── Minimal in-memory ThreadStore mock (same shape as
//     test/f148-assemble-incremental.test.js mockThreadStore — only the
//     methods assembleIncrementalContext actually calls: get/getThreadMemory/
//     getContextResetBoundary/getParticipantsWithActivity) ───────────────────

function mockThreadStore(title) {
  return {
    get: async () => ({ id: 'bench-thread', title, userId: 'bench-user', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getContextResetBoundary: async () => null,
    getThreadMemory: async () => null,
    updateThreadMemory: async () => {},
  };
}

function mockMsg(overrides) {
  return {
    threadId: overrides.threadId,
    userId: overrides.userId ?? 'bench-user',
    catId: overrides.catId ?? null,
    content: overrides.content,
    mentions: overrides.mentions ?? [],
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

// ─── Line-based diff (LCS) — no external dependency ───────────────────────────
//
// Byte-stability measurement doesn't need Myers-diff quality; a classic O(n·m)
// LCS table over lines is plenty for prompt-sized text (hundreds of lines) and
// keeps this script dependency-free.

function diffLines(aText, bText) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

/** A line that looks like a section marker (heading, bracket label, or a known
 *  fixed-prefix line this codebase uses for prompt sections). Used only to
 *  give changed segments a human-readable label — not a formal parser. */
const MARKER_RE = /^(#{1,6}\s|\[.+\]|Identity:|==+|【.+】|当前模式|你的队友|活跃毛线球|\[导航\])/;

/** Group diff ops into contiguous changed segments, each labeled with the
 *  nearest preceding equal-line marker (falls back to a preview of the first
 *  changed line). Returns byte counts for old/new content per segment. */
function summarizeDiff(ops) {
  const segments = [];
  let currentLabel = '(preamble)';
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'equal') {
      if (MARKER_RE.test(op.line.trim())) currentLabel = op.line.trim().slice(0, 60);
      i++;
      continue;
    }
    // Start of a changed run
    const startLabel = currentLabel;
    let removedBytes = 0;
    let addedBytes = 0;
    let removedLines = 0;
    let addedLines = 0;
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'del') {
        removedBytes += Buffer.byteLength(ops[i].line, 'utf8') + 1;
        removedLines++;
      } else {
        addedBytes += Buffer.byteLength(ops[i].line, 'utf8') + 1;
        addedLines++;
      }
      i++;
    }
    segments.push({ label: startLabel, removedBytes, addedBytes, removedLines, addedLines });
  }
  return segments;
}

function byteLen(text) {
  return Buffer.byteLength(text, 'utf8');
}

function printSegmentReport(name, aText, bText) {
  const identical = aText === bText;
  console.log(`  ${name}: ${byteLen(aText)}B → ${byteLen(bText)}B ${identical ? '(byte-identical ✅)' : '(DIFFERS ❌)'}`);
  if (identical) return;
  const ops = diffLines(aText, bText);
  const segments = summarizeDiff(ops);
  for (const seg of segments) {
    const kind = seg.removedLines === 0 ? 'inserted after' : seg.addedLines === 0 ? 'removed after' : 'changed near';
    console.log(
      `    Δ ${kind} "${seg.label}": -${seg.removedLines}/+${seg.addedLines} lines, ` +
        `-${seg.removedBytes}B/+${seg.addedBytes}B`,
    );
  }
}

// ─── Cat profile fixtures ──────────────────────────────────────────────────────

const CAT_PROFILES = {
  opus: { mcpAvailable: true, toolPolicy: 'full', teammates: ['codex'], mode: 'independent' },
  codex: { mcpAvailable: false, toolPolicy: 'minimal', teammates: ['opus'], mode: 'serial', chainIndex: 2, chainTotal: 2 },
  gemini: { mcpAvailable: true, toolPolicy: 'standard', teammates: ['opus', 'codex'], mode: 'parallel' },
};

async function runProfile(catId) {
  const profile = CAT_PROFILES[catId];
  if (!profile) throw new Error(`Unknown cat profile: ${catId}`);

  const threadId = `bench-thread-${catId}`;
  const userId = 'bench-user';
  const messageStore = new MessageStore();
  const deliveryCursorStore = new DeliveryCursorStore(); // no sessionStore → pure in-memory, no Redis
  const threadStore = mockThreadStore(`ADR-024 harness thread (${catId})`);
  const deps = {
    services: {},
    invocationDeps: { threadStore },
    messageStore,
    deliveryCursorStore,
  };

  // Seed 8 turns of realistic prior history before "turn N".
  const baseTs = Date.now() - 20 * 60_000;
  const seeded = [];
  for (let k = 0; k < 8; k++) {
    seeded.push(
      messageStore.append(
        mockMsg({
          threadId,
          catId: k % 2 === 0 ? null : (profile.teammates[0] ?? null),
          content: `[history ${k}] discussing ADR-024 cache-friendly layout rollout for ${catId}`,
          timestamp: baseTs + k * 60_000,
        }),
      ),
    );
  }

  // ── Turn N ──
  const turnNMsg = seeded.at(-1);
  const resultN = await assembleIncrementalContext(deps, userId, threadId, catId, turnNMsg.id);
  // Simulate real production behavior: cursor is acked after the turn completes
  // (invocations.ts collects cursorBoundaries then calls ackCollectedCursors on success).
  await deliveryCursorStore.ackCursor(userId, catId, threadId, resultN.boundaryId ?? turnNMsg.id);

  const contextN = {
    catId,
    mode: profile.mode,
    ...(profile.chainIndex ? { chainIndex: profile.chainIndex, chainTotal: profile.chainTotal } : {}),
    teammates: profile.teammates,
    mcpAvailable: profile.mcpAvailable,
    toolPolicy: profile.toolPolicy,
    threadId,
    currentUserMessageId: turnNMsg.id,
    contextUsageWarning: {
      ratio: 0.42,
      estimatedTokens: 42_000,
      maxPromptTokens: 100_000,
      level: 'caution',
      action: 'memory-writeback',
    },
    activeParticipants: [
      { catId: profile.teammates[0], lastMessageAt: baseTs + 7 * 60_000, messageCount: 4 },
    ],
  };

  const staticN = buildStaticIdentity(catId, {
    mcpAvailable: profile.mcpAvailable,
    toolPolicy: profile.toolPolicy,
  });
  const reviewerN = buildReviewerSection(catId) ?? '';
  const dynamicN = buildInvocationContext(contextN);
  const systemN = buildSystemPrompt(contextN);

  // ── Turn N+1: one more real exchange happens, cursor already acked ──
  const newUserMsg = messageStore.append(
    mockMsg({ threadId, content: `[turn N+1] follow-up question about ADR-024 rollout for ${catId}`, timestamp: Date.now() }),
  );
  const newReplyMsg = messageStore.append(
    mockMsg({
      threadId,
      catId: profile.teammates[0] ?? null,
      content: `[turn N+1 reply] teammate response before ${catId} is invoked again`,
      timestamp: Date.now() + 1000,
    }),
  );

  const resultN1 = await assembleIncrementalContext(deps, userId, threadId, catId, newReplyMsg.id);

  const contextN1 = {
    catId,
    mode: profile.mode,
    ...(profile.chainIndex ? { chainIndex: profile.chainIndex, chainTotal: profile.chainTotal } : {}),
    teammates: profile.teammates,
    mcpAvailable: profile.mcpAvailable,
    toolPolicy: profile.toolPolicy,
    threadId,
    currentUserMessageId: newReplyMsg.id,
    // Per-turn state naturally evolves: ratio grew (more history), and a
    // ping-pong streak was just detected — this is exactly the "session 内会写"
    // content ADR-024 D1 says must never live ahead of history in the prefix.
    contextUsageWarning: {
      ratio: 0.47,
      estimatedTokens: 47_000,
      maxPromptTokens: 100_000,
      level: 'caution',
      action: 'memory-writeback',
    },
    pingPongWarning: profile.teammates[0] ? { pairedWith: profile.teammates[0], count: 2 } : undefined,
    activeParticipants: [
      { catId: profile.teammates[0], lastMessageAt: newReplyMsg.timestamp, messageCount: 5 },
    ],
  };

  const staticN1 = buildStaticIdentity(catId, {
    mcpAvailable: profile.mcpAvailable,
    toolPolicy: profile.toolPolicy,
  });
  const reviewerN1 = buildReviewerSection(catId) ?? '';
  const dynamicN1 = buildInvocationContext(contextN1);
  const systemN1 = buildSystemPrompt(contextN1);

  console.log(`\n=== Cat profile: ${catId} (mode=${profile.mode}, toolPolicy=${profile.toolPolicy}, mcp=${profile.mcpAvailable}) ===`);
  console.log(`Turn N   msgId=${turnNMsg.id}  Turn N+1 msgId=${newReplyMsg.id}`);
  console.log('--- Layer A: system prompt (SystemPromptBuilder) ---');
  printSegmentReport('buildStaticIdentity  [cacheClass=static]', staticN, staticN1);
  printSegmentReport('buildReviewerSection [cacheClass=static]', reviewerN, reviewerN1);
  printSegmentReport('buildInvocationContext [cacheClass=volatile, currently INLINE in system prompt]', dynamicN, dynamicN1);
  printSegmentReport('buildSystemPrompt (A, full concatenation)', systemN, systemN1);
  console.log('--- Layer B: transport context (route-helpers.assembleIncrementalContext) ---');
  printSegmentReport('assembleIncrementalContext.contextText', resultN.contextText, resultN1.contextText);

  return {
    catId,
    staticIdentical: staticN === staticN1,
    reviewerIdentical: reviewerN === reviewerN1,
    systemBytesN: byteLen(systemN),
    systemBytesN1: byteLen(systemN1),
    dynamicBytesN: byteLen(dynamicN),
    contextTextBytesN: byteLen(resultN.contextText),
    contextTextBytesN1: byteLen(resultN1.contextText),
  };
}

// ─── Entrypoint ────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--cats='));
  const cats = arg ? arg.slice('--cats='.length).split(',') : ['opus', 'codex'];

  console.log('ADR-024 W1-A context byte-stability harness');
  console.log('Measures: same cat+thread, turn N vs turn N+1, which sections changed and by how many bytes.');
  console.log(`Cat profiles: ${cats.join(', ')}`);

  const results = [];
  for (const catId of cats) {
    results.push(await runProfile(catId));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    const cachePrefixNote = r.staticIdentical && r.reviewerIdentical ? 'static+reviewer stable ✅' : 'static/reviewer DRIFTED ❌';
    console.log(
      `${r.catId}: system ${r.systemBytesN}B→${r.systemBytesN1}B (dynamic block alone: ${r.dynamicBytesN}B), ` +
        `transport ${r.contextTextBytesN}B→${r.contextTextBytesN1}B — ${cachePrefixNote}`,
    );
  }
  console.log(
    '\nInterpretation: buildStaticIdentity/buildReviewerSection are byte-identical across turns (as expected — ' +
      'they are cacheClass=static). buildInvocationContext is NOT — and per ADR-024 D1/D2, it currently sits ' +
      "INSIDE the system prompt (ahead of history), so its per-turn churn breaks the KV-cache prefix at that " +
      'point for every downstream byte, even though only a few lines inside it actually changed content.',
  );
}

await main();
