#!/usr/bin/env node
/**
 * 批次 1 F-A 评测尺: CLI 原生 session 体积 + 唤醒耗时基线扫描脚本。
 *
 * 背景: docs/research/memory-absorption.md §3 "Session 撑爆治理专节" 记录了一个
 * "未证实"的生产事故复述 (grok 猫 CLI 原生 session 涨到 25MB, 唤醒即卡死,
 * 推特日报连断多场)。docs/research/memory-absorption.md §4 批次 1 项目 2 要求
 * "给 Session 撑爆治理加一个可观测指标: CLI 原生 session 文件体积分布 + 唤醒
 * 耗时分布, 作为后续 (批次 3 F-G) 轮转阈值调参的基线"。
 *
 * 这个脚本做两件事, 全部只读:
 *  1. 扫描各 CLI provider 的原生 session 存放路径 (先调研确认的真实路径, 见
 *     下方 PROVIDER_ROOTS 注释), 输出体积分布 —— 总量 + top5 最大的 session
 *     单元 (Codex/Claude 是单个 rollout/jsonl 文件, Grok/Kimi 是一个 session
 *     目录)。
 *  2. 从 Clowder 自己的 invocation 结构化日志 (pm2 log, JSON lines, 由
 *     invoke-single-cat.ts 的 "Created invocation" / "Session init: binding
 *     session" 两条 log.info 产出) 抽样 "唤醒耗时" —— 从 invocation 创建到 CLI
 *     子进程成功绑定 session 之间的延迟, 这正是事故描述里"启动就卡死"发生的
 *     那个区间。
 *
 * 铁律 (不改任何生产行为, 只加度量):
 *  - 只读。不删除、不移动、不轮转任何 provider 的原生 session 文件; 不修改
 *    pm2 日志; 不写任何文件 —— 唯一的输出是打印到 stdout 的一份 JSON 报告
 *    (加一份人类可读摘要到 stderr)。
 *  - 找不到某个 provider 的目录、或读不到 pm2 日志, 都必须优雅跳过并在报告里
 *    注明, 不能让脚本因为跑在别的机器/CI 环境而崩溃。
 *
 * Usage:
 *   node scripts/memory-session-baseline.mjs            # 人类可读摘要 + JSON
 *   node scripts/memory-session-baseline.mjs --json-only # 只输出 JSON（供落档脚本消费）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const JSON_ONLY = process.argv.includes('--json-only');
const HOME = homedir();

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Recursively sum the byte size of a directory tree (bounded depth, read-only, tolerant of permission errors). */
function dirSizeBytes(path, maxDepth = 12, depth = 0) {
  if (depth > maxDepth) return 0;
  let total = 0;
  for (const entry of safeReaddir(path)) {
    const abs = join(path, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks (avoid cycles / escaping scan root)
    if (entry.isDirectory()) {
      total += dirSizeBytes(abs, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      const st = safeStat(abs);
      if (st) total += st.size;
    }
  }
  return total;
}

/** Recursively collect every regular file under path with its size + mtime (bounded depth). */
function collectFiles(path, maxDepth = 12, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  for (const entry of safeReaddir(path)) {
    const abs = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectFiles(abs, maxDepth, depth + 1, out);
    } else if (entry.isFile()) {
      const st = safeStat(abs);
      if (st) out.push({ path: abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider session roots (调研确认的真实路径, 只读扫描)
//
//  - Codex:  ${CODEX_HOME:-~/.codex}/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
//            (packages/api/src/.../codex-session-context-snapshot.ts:120 —
//            organized by DATE, not by project; per-project attribution would
//            need content inspection, out of scope for a read-only size scan)
//  - Grok:   ${GROK_HOME:-~/.grok}/sessions/<url-encoded-cwd>/<sessionId>/*
//            (GrokAgentService.ts:186 sourceGrokHome; each session is a
//            DIRECTORY holding updates.jsonl/events.jsonl/chat_history.jsonl/...)
//  - Kimi:   ${KIMI_CODE_HOME:-~/.kimi-code}/sessions/wd_<slug>_<hash>/ses_*/
//            (CLI home migrated ~/.kimi → ~/.kimi-code, see
//            packages/api/src/utils/local-cli-model-probes.ts:287-292; falls
//            back to ${KIMI_SHARE_DIR:-~/.kimi} for pre-migration installs)
//  - Gemini: ~/.gemini/tmp/<projectDirName>/chats/session-*.json
//            (GeminiAgentService.ts:87-107; projectDirName = basename(cwd),
//            NOT url-encoded)
//  - Claude: ~/.claude/projects/<url-encoded-cwd>/*.jsonl
//            (standard Claude Code CLI convention; not written by this repo's
//            code but the storage location Clowder's ClaudeAgentService.ts
//            --resume flag reads back from)
// ---------------------------------------------------------------------------

function resolveKimiSessionsRoot() {
  if (process.env.KIMI_CODE_HOME) return join(process.env.KIMI_CODE_HOME, 'sessions');
  const migrated = join(HOME, '.kimi-code', 'sessions');
  if (existsSync(migrated)) return migrated;
  const legacy = process.env.KIMI_SHARE_DIR ?? join(HOME, '.kimi');
  return join(legacy, 'sessions');
}

const PROVIDER_ROOTS = {
  codex: join(process.env.CODEX_HOME ?? join(HOME, '.codex'), 'sessions'),
  grok: join(process.env.GROK_HOME ?? join(HOME, '.grok'), 'sessions'),
  kimi: resolveKimiSessionsRoot(),
  gemini: join(HOME, '.gemini', 'tmp'),
  claude: join(HOME, '.claude', 'projects'),
};

/** Is this path plausibly related to a Clowder worktree/session (vs. some unrelated project on the same machine)? */
function looksClowderRelated(path) {
  return /clowder|cat-cafe/i.test(path);
}

function scanCodex(root) {
  if (!existsSync(root)) return { provider: 'codex', found: false, root };
  const files = collectFiles(root).filter((f) => f.path.endsWith('.jsonl'));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const top5 = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  const clowderFiles = files.filter((f) => looksClowderRelated(f.path));
  return {
    provider: 'codex',
    found: true,
    root,
    note: 'Codex 原生 session 按日期(yyyy/mm/dd)组织, 不按项目组织 —— 无法只读扫描文件名/路径确定"每个 rollout 属于哪个项目", 需要读内容(cwd 字段)才能精确归属; 下面是全量分布, clowderRelatedGuess 是按路径/文件名关键字的弱匹配, 仅供参考',
    fileCount: files.length,
    totalBytes,
    totalHuman: humanBytes(totalBytes),
    top5: top5.map((f) => ({ path: f.path, size: f.size, sizeHuman: humanBytes(f.size), mtime: new Date(f.mtimeMs).toISOString() })),
    clowderRelatedGuess: { fileCount: clowderFiles.length, totalBytes: clowderFiles.reduce((s, f) => s + f.size, 0) },
  };
}

/** Grok/Kimi share the same shape: root/<projectBucket>/<sessionUnit-dir-or-file>/... */
function scanProjectBucketedProvider(providerName, root, { sessionUnitIsDir }) {
  if (!existsSync(root)) return { provider: providerName, found: false, root };
  const buckets = safeReaddir(root).filter((e) => e.isDirectory());
  const units = [];
  for (const bucket of buckets) {
    const bucketPath = join(root, bucket.name);
    const bucketEntries = safeReaddir(bucketPath);
    for (const entry of bucketEntries) {
      const unitPath = join(bucketPath, entry.name);
      if (sessionUnitIsDir) {
        if (!entry.isDirectory()) continue; // skip loose root-level files (lockfiles, sqlite index, etc.)
        const size = dirSizeBytes(unitPath);
        const st = safeStat(unitPath);
        units.push({ bucket: bucket.name, unit: entry.name, path: unitPath, size, mtimeMs: st?.mtimeMs ?? 0 });
      } else {
        if (!entry.isFile()) continue;
        const st = safeStat(unitPath);
        if (!st) continue;
        units.push({ bucket: bucket.name, unit: entry.name, path: unitPath, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  const totalBytes = units.reduce((sum, u) => sum + u.size, 0);
  const top5 = [...units].sort((a, b) => b.size - a.size).slice(0, 5);
  const clowderUnits = units.filter((u) => looksClowderRelated(u.bucket));
  const clowderBytes = clowderUnits.reduce((s, u) => s + u.size, 0);
  const clowderTop5 = [...clowderUnits].sort((a, b) => b.size - a.size).slice(0, 5);
  return {
    provider: providerName,
    found: true,
    root,
    projectBucketCount: buckets.length,
    sessionUnitCount: units.length,
    totalBytes,
    totalHuman: humanBytes(totalBytes),
    top5: top5.map((u) => ({
      bucket: u.bucket,
      unit: u.unit,
      path: u.path,
      size: u.size,
      sizeHuman: humanBytes(u.size),
      mtime: u.mtimeMs ? new Date(u.mtimeMs).toISOString() : null,
    })),
    clowderRelated: {
      projectBucketCount: buckets.filter((b) => looksClowderRelated(b.name)).length,
      sessionUnitCount: clowderUnits.length,
      totalBytes: clowderBytes,
      totalHuman: humanBytes(clowderBytes),
      top5: clowderTop5.map((u) => ({
        bucket: u.bucket,
        unit: u.unit,
        path: u.path,
        size: u.size,
        sizeHuman: humanBytes(u.size),
        mtime: u.mtimeMs ? new Date(u.mtimeMs).toISOString() : null,
      })),
    },
  };
}

function scanGemini(root) {
  if (!existsSync(root)) return { provider: 'gemini', found: false, root };
  const projectDirs = safeReaddir(root).filter((e) => e.isDirectory());
  const files = [];
  for (const projectDir of projectDirs) {
    const chatsDir = join(root, projectDir.name, 'chats');
    if (!existsSync(chatsDir)) continue;
    for (const entry of safeReaddir(chatsDir)) {
      // Inventory scan is intentionally broader than GeminiAgentService.ts's own
      // `.json`-only lookup (readGeminiThinkingFromLocalSession, :106-107) —
      // some installs write `.jsonl` chat session files too; a size baseline
      // should count every session file this CLI has written, not just the
      // subset one lookup helper currently reads back.
      if (!entry.isFile() || !entry.name.startsWith('session-') || !/\.jsonl?$/.test(entry.name)) continue;
      const abs = join(chatsDir, entry.name);
      const st = safeStat(abs);
      if (st) files.push({ bucket: projectDir.name, unit: entry.name, path: abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const top5 = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  const clowderFiles = files.filter((f) => looksClowderRelated(f.bucket));
  return {
    provider: 'gemini',
    found: true,
    root,
    projectBucketCount: projectDirs.length,
    sessionUnitCount: files.length,
    totalBytes,
    totalHuman: humanBytes(totalBytes),
    top5: top5.map((f) => ({ bucket: f.bucket, unit: f.unit, path: f.path, size: f.size, sizeHuman: humanBytes(f.size), mtime: new Date(f.mtimeMs).toISOString() })),
    clowderRelated: (() => {
      const clowderBytes = clowderFiles.reduce((s, f) => s + f.size, 0);
      return { sessionUnitCount: clowderFiles.length, totalBytes: clowderBytes, totalHuman: humanBytes(clowderBytes) };
    })(),
  };
}

function scanClaude(root) {
  if (!existsSync(root)) return { provider: 'claude', found: false, root };
  const projectDirs = safeReaddir(root).filter((e) => e.isDirectory());
  const files = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir.name);
    for (const f of collectFiles(projectPath, 3)) {
      if (f.path.endsWith('.jsonl')) files.push({ bucket: projectDir.name, path: f.path, size: f.size, mtimeMs: f.mtimeMs });
    }
  }
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const top5 = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  const clowderFiles = files.filter((f) => looksClowderRelated(f.bucket));
  const clowderBytes = clowderFiles.reduce((s, f) => s + f.size, 0);
  const clowderTop5 = [...clowderFiles].sort((a, b) => b.size - a.size).slice(0, 5);
  return {
    provider: 'claude',
    found: true,
    root,
    note: '按项目目录(url-encode 后的 cwd)组织, session 单元 = 单个 .jsonl 文件; 一个项目目录下可能混有多个 Clowder 猫(opus/opus-45/gpt52/...)的会话 —— Claude CLI 本身不区分 Clowder 内部 catId, 只区分 cwd',
    projectBucketCount: projectDirs.length,
    sessionUnitCount: files.length,
    totalBytes,
    totalHuman: humanBytes(totalBytes),
    top5: top5.map((f) => ({ bucket: f.bucket, path: f.path, size: f.size, sizeHuman: humanBytes(f.size), mtime: new Date(f.mtimeMs).toISOString() })),
    clowderRelated: {
      projectBucketCount: projectDirs.filter((p) => looksClowderRelated(p.name)).length,
      sessionUnitCount: clowderFiles.length,
      totalBytes: clowderBytes,
      totalHuman: humanBytes(clowderBytes),
      top5: clowderTop5.map((f) => ({ bucket: f.bucket, path: f.path, size: f.size, sizeHuman: humanBytes(f.size), mtime: new Date(f.mtimeMs).toISOString() })),
    },
  };
}

function scanAllProviders() {
  return {
    codex: scanCodex(PROVIDER_ROOTS.codex),
    grok: scanProjectBucketedProvider('grok', PROVIDER_ROOTS.grok, { sessionUnitIsDir: true }),
    kimi: scanProjectBucketedProvider('kimi', PROVIDER_ROOTS.kimi, { sessionUnitIsDir: true }),
    gemini: scanGemini(PROVIDER_ROOTS.gemini),
    claude: scanClaude(PROVIDER_ROOTS.claude),
  };
}

// ---------------------------------------------------------------------------
// Wake-latency sampling from Clowder's own pm2 log (read-only, JSON lines).
//
// invoke-single-cat.ts emits two plain pino log lines per invocation:
//   log.info({ invocationId, catId, threadId, userId }, 'Created invocation')
//   log.info({ ..., cliSessionId, invocationId }, 'Session init: binding session')
// The delta between them is the time from "invocation created / cat woken up"
// to "the CLI subprocess actually initialized and bound a session" — exactly
// the window where the 25MB-session incident hung (启动就卡死，never even
// reaching session init). No existing metric captures this distribution today.
// ---------------------------------------------------------------------------

function resolvePm2LogPath() {
  const pm2Home = process.env.PM2_HOME ?? join(HOME, '.pm2');
  return join(pm2Home, 'logs', 'clowder-api-out.log');
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

function summarizeLatencies(deltasMs) {
  if (deltasMs.length === 0) return null;
  const sorted = [...deltasMs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: Math.round(quantile(sorted, 0.5)),
    meanMs: Math.round(sum / sorted.length),
    p95Ms: Math.round(quantile(sorted, 0.95)),
    maxMs: sorted[sorted.length - 1],
  };
}

function grepLines(logPath, fixedString) {
  try {
    const out = execFileSync('grep', ['-h', '-F', fixedString, logPath], {
      maxBuffer: 1024 * 1024 * 512, // 512MB — clowder-api-out.log can be several hundred MB
      encoding: 'utf-8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    // grep exits 1 when no lines match — that's a valid "zero results", not an error.
    if (err.status === 1) return [];
    throw err;
  }
}

function sampleWakeLatency() {
  const logPath = resolvePm2LogPath();
  if (!existsSync(logPath)) {
    return { found: false, logPath, reason: 'pm2 log not found at this path — sampling skipped (read-only, no fallback writes)' };
  }

  let createdLines;
  let sessionInitLines;
  try {
    createdLines = grepLines(logPath, '"msg":"Created invocation"');
    sessionInitLines = grepLines(logPath, '"msg":"Session init: binding session"');
  } catch (err) {
    return { found: false, logPath, reason: `grep over pm2 log failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const createdAt = new Map(); // invocationId -> { ts, catId }
  for (const line of createdLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.invocationId && row.time) createdAt.set(row.invocationId, { ts: Date.parse(row.time), catId: row.catId ?? 'unknown' });
  }

  const perCat = new Map(); // catId -> number[] (deltaMs)
  let matched = 0;
  for (const line of sessionInitLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row.invocationId || !row.time) continue;
    const created = createdAt.get(row.invocationId);
    if (!created) continue; // "Created invocation" line fell outside this log file's retained window
    const delta = Date.parse(row.time) - created.ts;
    if (!Number.isFinite(delta) || delta < 0) continue; // clock skew / corrupt line guard
    matched += 1;
    const catId = created.catId;
    if (!perCat.has(catId)) perCat.set(catId, []);
    perCat.get(catId).push(delta);
  }

  const allDeltas = [...perCat.values()].flat();
  const perCatSummary = {};
  for (const [catId, deltas] of perCat.entries()) {
    perCatSummary[catId] = summarizeLatencies(deltas);
  }

  return {
    found: true,
    logPath,
    logSizeBytes: safeStat(logPath)?.size ?? null,
    createdInvocationLinesScanned: createdLines.length,
    sessionInitLinesScanned: sessionInitLines.length,
    matchedPairs: matched,
    note: '"唤醒耗时" = Created invocation → Session init: binding session 的时间差；只统计同一 invocationId 在两条日志里都出现的样本（部分 Created 行可能落在日志滚动窗口之外，配对不到）。这是"invocation 创建到 CLI 子进程绑定 session"这一段，不是完整回复耗时。',
    overall: summarizeLatencies(allDeltas),
    perCat: perCatSummary,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    sessionSizeDistribution: scanAllProviders(),
    wakeLatencySampling: sampleWakeLatency(),
  };

  if (!JSON_ONLY) {
    console.error('=== Memory Session Baseline (read-only) ===');
    console.error(`Generated: ${report.generatedAt}\n`);
    for (const [name, result] of Object.entries(report.sessionSizeDistribution)) {
      if (!result.found) {
        console.error(`[${name}] NOT FOUND at ${result.root} — skipped`);
        continue;
      }
      console.error(`[${name}] root=${result.root}`);
      console.error(`  total: ${result.totalHuman ?? humanBytes(result.totalBytes)} across ${result.sessionUnitCount ?? result.fileCount} session unit(s)`);
      if (result.clowderRelated) {
        console.error(`  clowder-related subset: ${result.clowderRelated.totalHuman} across ${result.clowderRelated.sessionUnitCount} unit(s)`);
      }
      console.error(`  top5:`);
      for (const u of result.top5) {
        // Grok/Kimi/Gemini units carry both bucket + unit (short relative label);
        // Codex/Claude units are already-absolute file paths with no separate
        // `unit` name — print those as-is instead of double-prefixing.
        const label = u.unit ? `${u.bucket ?? ''}${u.bucket ? '/' : ''}${u.unit}` : u.path;
        console.error(`    ${u.sizeHuman.padStart(10)}  ${label}`);
      }
      console.error('');
    }

    const wake = report.wakeLatencySampling;
    if (!wake.found) {
      console.error(`[wake-latency] skipped: ${wake.reason}`);
    } else {
      console.error(`[wake-latency] log=${wake.logPath} (${humanBytes(wake.logSizeBytes ?? 0)})`);
      console.error(`  matched pairs: ${wake.matchedPairs} (from ${wake.createdInvocationLinesScanned} Created / ${wake.sessionInitLinesScanned} Session-init lines)`);
      if (wake.overall) {
        console.error(
          `  overall: mean=${wake.overall.meanMs}ms p50=${wake.overall.p50Ms}ms p95=${wake.overall.p95Ms}ms max=${wake.overall.maxMs}ms (n=${wake.overall.count})`,
        );
      }
      console.error('  per cat:');
      for (const [catId, s] of Object.entries(wake.perCat)) {
        if (!s) continue;
        console.error(`    ${catId.padEnd(16)} mean=${s.meanMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms (n=${s.count})`);
      }
    }
    console.error('\n=== JSON report follows on stdout ===\n');
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
