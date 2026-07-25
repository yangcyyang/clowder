/**
 * F-G (docs/prd/PRD-memory-upgrade.md 批次 3): CLI 原生 session 撑爆治理 — 轮转判定。
 *
 * 背景（docs/research/memory-absorption.md §3 + docs/research/memory-eval-baseline.md §5.2）：
 * 各 provider CLI 自己维护的原生续接历史（grok/kimi/claude/codex/gemini 各自的
 * --resume/--continue/--session 机制）没有体积上限。已实测确认一个 24.4MB 的事故 session
 * （grok，唤醒即卡死）和一个更大的、仍在活跃增长的 76.4MB session（同一台机器的
 * clowder-ai-slock-like-webui/packages/api worktree 下）。Clowder 自己的 ThreadStore/
 * SessionSealer 只压缩自己的会话摘要，管不到这类 CLI 私有历史文件。
 *
 * 这个模块只做"轮转判定"本身：在 invoke-single-cat.ts 即将 --resume 一个旧 session 之前，
 * 检查它在磁盘上的原生体积；超限且该猫在灰度白名单内 → 本次调用不带 sessionId（等效强制
 * 轮转——调用方把 `sessionId` 置回 undefined 后，各 provider adapter 会以"全新会话"发起，
 * 详见各 AgentService 的 `options?.sessionId` 分支），旧文件只**改名归档**
 * （`<path>.rotated-<yyyy-mm-dd>[-N]`），绝不删除。
 *
 * 灰度纪律：默认全关——`CLOWDER_CLI_SESSION_MAX_MB` 未设置或 <=0 时 `loadCliSessionRotationPolicy`
 * 返回 `thresholdBytes: 0`，`isCliSessionRotationEnabledFor` 恒为 false，`maybeRotateCliNativeSession`
 * 在做任何 fs 访问之前就短路返回 `{ rotated: false, reason: 'disabled' }`——零行为变化。
 *
 * === 各 provider 续接机制调研结论（用于决定这一轮实现哪些 provider） ===
 *
 * | Provider | 续接 CLI 参数（invoke-single-cat.ts 里的 sessionId → provider adapter） | 原生 session 路径约定 | 本轮是否实现体积轮转 |
 * |---|---|---|---|
 * | Grok   | `--resume <sessionId>`（GrokAgentService.ts:226-227） | `${GROK_HOME:-~/.grok}/sessions/<encodeURIComponent(cwd)>/<sessionId>/`（一个 session = 一个目录，已用真实磁盘目录核实 encodeURIComponent 的编码规则，见本文件 `resolveNativeSessionPath`） | **是**——本批次唯一灰度对象 |
 * | Claude | `--resume <sessionId>`（ClaudeAgentService.ts:250-251） | `~/.claude/projects/<cwd 经过某种非标准字符替换>/<sessionId>.jsonl`；实测目录名类似 `-Users-cy--slock-worktrees-clowder-ai-slock-like-webui-packages-api`，替换规则不是标准 `encodeURIComponent`，是 Claude Code CLI 自己未公开为契约的私有算法 | 否——盲猜替换规则有算错命中文件、误归档别的 session 的风险；且本批次灰度只圈定 grok |
 * | Kimi   | `--session <sessionId>`（KimiAgentService.ts:69-70） | 实测目录形如 `${KIMI_CODE_HOME}/sessions/wd_<slug>_<hash>/ses_<sessionId>/`，但 `<hash>` 是 Kimi CLI 自己的私有哈希算法，仓库内没有任何计算它的代码（`memory-session-baseline.mjs` 的注释也只是"手工发现的经验路径"） | 否——哈希算法不可靠推导 |
 * | Gemini | `--resume <sessionId>`（GeminiAgentService.ts:209-210） | `~/.gemini/tmp/<basename(cwd)>/chats/session-*.json`；文件名不等于 sessionId，必须逐个打开解析 `parsed.sessionId` 才能确认匹配（GeminiAgentService.ts:106-117 现成的读取逻辑就是这么做的）——"找到文件"本身就不是纯 stat 操作 | 否——且体积基线极小（332.4 KB，memory-eval-baseline.md #12），不是本轮治理目标 |
 * | Codex  | `resume <sessionId>` 子命令（CodexAgentService.ts:484-488） | 按日期 `yyyy/mm/dd` 组织，不按项目/session 归属；只读扫描拿不到"这个 sessionId 对应哪个 rollout 文件"，需要读内容（cwd 字段）才能精确归属（codex-session-context-snapshot.ts + memory-session-baseline.mjs 已确认） | 否——归属问题未解决 |
 * | Pi     | `options?.sessionId` 只用来 yield 一条 `session_init` 消息（PiAgentService.ts:150-159），`buildArgs` 从不把它转成 `--resume`/`--session` 之类的 CLI 参数 | 不适用——Pi 这条 adapter 目前并不会让 CLI 原生续接旧 session，没有"越攒越大"的同类问题 | 不适用，跳过 |
 * | Dare / OpenCode | `--session-id <sessionId>` / `--session <sessionId>`（DareAgentService.ts:265-266、OpenCodeAgentService.ts:307-308） | 仓库内未调研到这两家 CLI 的原生存储路径约定 | 否——未调研，且都不是本批次灰度对象；留作后续 |
 *
 * 设计上的安全网：只要 `resolveNativeSessionPath` 对某个 clientId 返回 `undefined`
 * （上表"否"的所有 provider），`maybeRotateCliNativeSession` 就会安全短路成
 * `path_unresolved`（不轮转、不报错）。即使灰度白名单误配置了这些猫的 catId，
 * 效果也只是"不轮转"，不会误删/误归档任何文件。
 *
 * ADR-024 兼容性：本模块的判定产物（是否轮转）只影响"要不要把 sessionId 传给
 * provider.invoke()"这个纯服务端调用参数，从不写入任何 system prompt 静态前缀或
 * 队尾 meta 块——本身没有新增任何 prompt 注入通道。轮转后新 session 的首轮上下文
 * 依旧只来自既有的 v2 记忆索引注入路径（`SystemPromptBuilder.ts` 的
 * `buildAgentMemoryIndexLines`），不重放原始 CLI 历史，符合 D3"meta 永不持久化，
 * 记忆摘要走已有两层索引注入"的既定分工。
 */
import { existsSync } from 'node:fs';
import { readdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('cli-session-rotation');

/** Only providers with a reconstructable, read-only-verifiable native session path. See module doc table. */
const SUPPORTED_CLIENT_IDS = new Set(['grok']);

export interface CliSessionRotationPolicy {
  /** 0 = rotation entirely disabled (default; zero fs access, zero behavior change). */
  readonly thresholdBytes: number;
  /** Empty set = no cat opted in (default). Canary recommendation: just "grok". */
  readonly cats: ReadonlySet<string>;
}

function parseAllowlist(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseThresholdMb(value: string | undefined): number {
  if (value == null || value.trim() === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

export function loadCliSessionRotationPolicy(env: NodeJS.ProcessEnv = process.env): CliSessionRotationPolicy {
  const thresholdMb = parseThresholdMb(env.CLOWDER_CLI_SESSION_MAX_MB);
  return {
    thresholdBytes: thresholdMb > 0 ? thresholdMb * 1024 * 1024 : 0,
    cats: parseAllowlist(env.CLOWDER_CLI_SESSION_ROTATE_CATS),
  };
}

/** Both a positive threshold AND the cat's presence in the whitelist are required. */
export function isCliSessionRotationEnabledFor(policy: CliSessionRotationPolicy, catId: string): boolean {
  if (policy.thresholdBytes <= 0) return false;
  if (policy.cats.size === 0) return false;
  return policy.cats.has(catId);
}

export interface ResolveNativeSessionPathInput {
  readonly clientId: string | undefined;
  readonly sessionId: string;
  readonly workingDirectory: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Grok-only this round (see module doc table for why the rest are skipped).
 * Verified 2026-07-25 against real `~/.grok/sessions/` directory names —
 * the bucket segment is `encodeURIComponent(cwd)` (e.g. `%2FUsers%2Fcy%2F...`),
 * one session = one directory named exactly `<sessionId>`.
 */
export function resolveNativeSessionPath(input: ResolveNativeSessionPathInput): string | undefined {
  if (!input.clientId || !SUPPORTED_CLIENT_IDS.has(input.clientId)) return undefined;
  if (!input.workingDirectory) return undefined; // Grok buckets sessions by cwd; can't build the path without it
  const env = input.env ?? process.env;
  const grokHome = env.GROK_HOME?.trim() || join(homedir(), '.grok');
  return join(grokHome, 'sessions', encodeURIComponent(input.workingDirectory), input.sessionId);
}

/** Recursive, bounded-depth, read-tolerant directory size sum (mirrors scripts/memory-session-baseline.mjs's dirSizeBytes). */
export async function computeNativeSessionSizeBytes(path: string, maxDepth = 12, depth = 0): Promise<number> {
  if (depth > maxDepth) return 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const abs = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await computeNativeSessionSizeBytes(abs, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      try {
        const st = await stat(abs);
        total += st.size;
      } catch {
        /* unreadable file — skip, best effort */
      }
    }
  }
  return total;
}

function formatDateSuffix(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // yyyy-mm-dd
}

/**
 * Archive-only rename — HARD CONSTRAINT: never deletes any session file.
 * `<path>` → `<path>.rotated-<yyyy-mm-dd>`, with a `-N` counter suffix on same-day collision.
 */
export async function archiveNativeSessionPath(sessionPath: string, nowMs: number): Promise<string> {
  const dateSuffix = formatDateSuffix(nowMs);
  let candidate = `${sessionPath}.rotated-${dateSuffix}`;
  let counter = 1;
  while (existsSync(candidate)) {
    counter += 1;
    candidate = `${sessionPath}.rotated-${dateSuffix}-${counter}`;
  }
  await rename(sessionPath, candidate);
  return candidate;
}

export type CliSessionRotationReason =
  | 'disabled'
  | 'not_whitelisted'
  | 'no_session'
  | 'path_unresolved'
  | 'session_not_found'
  | 'under_threshold'
  | 'rotated';

export interface CliSessionRotationResult {
  readonly rotated: boolean;
  readonly reason: CliSessionRotationReason;
  readonly catId: string;
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly sizeBytes?: number;
  readonly thresholdBytes?: number;
  readonly archivedPath?: string;
}

export interface MaybeRotateCliNativeSessionInput {
  readonly catId: string;
  readonly clientId: string | undefined;
  /** The CLI-native sessionId Clowder was about to `--resume` with. Undefined = fresh thread anyway, nothing to rotate. */
  readonly sessionId: string | undefined;
  readonly workingDirectory: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/**
 * Single entry point called from invoke-single-cat.ts right before the CLI subprocess
 * would be launched with `--resume <sessionId>`. Pure orchestration: policy check →
 * path resolve → size stat → archive-rename. Never touches Clowder's own
 * sessionManager/sessionChainStore — the caller is responsible for dropping its local
 * `sessionId` variable when `rotated: true` so the CLI starts a fresh native session;
 * Clowder's existing `session_init` → `cli_session_replaced` handling (invoke-single-cat.ts)
 * already seals the stale chain record and binds the new one automatically.
 */
export async function maybeRotateCliNativeSession(
  input: MaybeRotateCliNativeSessionInput,
): Promise<CliSessionRotationResult> {
  const env = input.env ?? process.env;
  const policy = loadCliSessionRotationPolicy(env);
  const base = { catId: input.catId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };

  if (!isCliSessionRotationEnabledFor(policy, input.catId)) {
    return { ...base, rotated: false, reason: policy.thresholdBytes <= 0 ? 'disabled' : 'not_whitelisted' };
  }
  if (!input.sessionId) {
    return { ...base, rotated: false, reason: 'no_session' };
  }

  const sessionPath = resolveNativeSessionPath({
    clientId: input.clientId,
    sessionId: input.sessionId,
    workingDirectory: input.workingDirectory,
    env,
  });
  if (!sessionPath) {
    return { ...base, rotated: false, reason: 'path_unresolved' };
  }
  if (!existsSync(sessionPath)) {
    return { ...base, rotated: false, reason: 'session_not_found', sessionPath };
  }

  const sizeBytes = await computeNativeSessionSizeBytes(sessionPath);
  if (sizeBytes < policy.thresholdBytes) {
    return {
      ...base,
      rotated: false,
      reason: 'under_threshold',
      sessionPath,
      sizeBytes,
      thresholdBytes: policy.thresholdBytes,
    };
  }

  const archivedPath = await archiveNativeSessionPath(sessionPath, input.now?.() ?? Date.now());
  log.warn(
    {
      catId: input.catId,
      sessionId: input.sessionId,
      sessionPath,
      sizeBytes,
      thresholdBytes: policy.thresholdBytes,
      archivedPath,
    },
    'CLI native session over size threshold — rotated (archived by rename, not deleted)',
  );
  return {
    ...base,
    rotated: true,
    reason: 'rotated',
    sessionPath,
    sizeBytes,
    thresholdBytes: policy.thresholdBytes,
    archivedPath,
  };
}
