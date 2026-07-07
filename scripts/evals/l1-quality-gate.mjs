#!/usr/bin/env node
/**
 * WI-2 L1 Quality Gate — 复刻类评分卡断言
 * 文件: scripts/evals/l1-quality-gate.mjs
 *
 * 设计原则：
 * 1. 不重复造轮子：复用 pre-merge-check.sh 的 build/tsc/test 命令
 * 2. 复用 WI-10 的 live-worktree-build-gate.mjs 做 worktree-clean 检查
 * 3. 新增：结构化报告（QualityGateResult），让"哪条过/哪条挂"清晰可读
 * 4. 收窄铁律：L1 全绿才允许 in_review
 *
 * 用法：
 *   node scripts/evals/l1-quality-gate.mjs          # 全量检查
 *   node scripts/evals/l1-quality-gate.mjs --json   # JSON 输出
 *   node scripts/evals/l1-quality-gate.mjs --web-only  # 只检查 web 包
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../..');

// ─── 解析参数 ───
function parseArgs(argv) {
  const args = { json: false, webOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--web-only') args.webOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// ─── 工具：跑命令 ───
function runCommand(cmd, args, cwd, timeoutMs = 120_000) {
  const start = Date.now();
  try {
    execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { ok: true, durationMs: Date.now() - start, error: null };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: e.stderr?.toString() || e.message || String(e),
    };
  }
}

// ─── 工具：找仓库根 ───
function findRepoRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (
      existsSync(resolve(current, 'pnpm-workspace.yaml')) &&
      existsSync(resolve(current, 'ecosystem.config.cjs'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ─── L1 断言 1: Worktree 干净（复用 WI-10 逻辑）───
function assertWorktreeClean(repoRoot) {
  const start = Date.now();
  try {
    const stdout = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });

    // 复用 WI-10 的敏感路径过滤逻辑
    function isSensitiveUntrackedPath(filePath) {
      return (
        filePath === 'package.json' ||
        filePath === 'pnpm-lock.yaml' ||
        filePath === 'pnpm-workspace.yaml' ||
        filePath === 'ecosystem.config.cjs' ||
        filePath.startsWith('packages/') ||
        filePath.startsWith('scripts/') ||
        filePath.startsWith('cat-cafe-skills/')
      );
    }

    const dirtyEntries = stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .flatMap((line) => {
        const code = line.slice(0, 2);
        const rawPath = line.slice(3);
        if (code === '??') {
          return isSensitiveUntrackedPath(rawPath) ? [{ code, path: rawPath }] : [];
        }
        return [{ code, path: rawPath }];
      });

    if (dirtyEntries.length === 0) {
      return {
        name: 'L1: Worktree clean',
        passed: true,
        durationMs: Date.now() - start,
        evidence: 'git status --porcelain=v1 returned empty (after sensitive-path filtering)',
      };
    }

    const summary = dirtyEntries.slice(0, 10).map((e) => `${e.code} ${e.path}`).join('\n');
    const more = dirtyEntries.length > 10 ? `\n... ${dirtyEntries.length - 10} more` : '';
    return {
      name: 'L1: Worktree clean',
      passed: false,
      durationMs: Date.now() - start,
      error: `Dirty entries:\n${summary}${more}`,
      evidence: 'git status --porcelain=v1 showed uncommitted changes',
    };
  } catch (e) {
    return {
      name: 'L1: Worktree clean',
      passed: false,
      durationMs: Date.now() - start,
      error: e.message || String(e),
      evidence: 'git status command failed',
    };
  }
}

// ─── L1 断言 2: Build 通过 ───
function assertBuildPasses(webOnly) {
  const start = Date.now();
  const cmd = webOnly
    ? runCommand('pnpm', ['--filter', '@cat-cafe/web', 'build'], rootDir, 120_000)
    : runCommand('pnpm', ['-r', '--if-present', 'run', 'build'], rootDir, 180_000);

  if (cmd.ok) {
    return {
      name: webOnly ? 'L1: Web build passes' : 'L1: Build passes (all packages)',
      passed: true,
      durationMs: cmd.durationMs,
      evidence: webOnly ? 'pnpm --filter @cat-cafe/web build succeeded' : 'pnpm -r --if-present run build succeeded',
    };
  }
  return {
    name: webOnly ? 'L1: Web build passes' : 'L1: Build passes (all packages)',
    passed: false,
    durationMs: cmd.durationMs,
    error: cmd.error.split('\n').slice(0, 5).join('\n'),
    evidence: 'build command failed',
  };
}

// ─── L1 断言 3: TypeScript 无类型错误 ───
function assertTypeCheckClean(webOnly) {
  const start = Date.now();
  // 复用 pre-merge-check.sh 的 tsc 命令：对所有含 tsc 的包跑 --noEmit
  const cmd = webOnly
    ? runCommand('pnpm', ['--filter', '@cat-cafe/web', 'exec', 'tsc', '--noEmit'], rootDir, 60_000)
    : runCommand('pnpm', ['-r', 'exec', 'bash', '-lc', 'if command -v tsc >/dev/null 2>&1; then tsc --noEmit; fi'], rootDir, 120_000);

  if (cmd.ok) {
    return {
      name: webOnly ? 'L1: Web TypeScript clean' : 'L1: TypeScript check clean (all packages)',
      passed: true,
      durationMs: cmd.durationMs,
      evidence: webOnly ? 'pnpm --filter @cat-cafe/web exec tsc --noEmit passed' : 'pnpm -r exec tsc --noEmit passed',
    };
  }
  return {
    name: webOnly ? 'L1: Web TypeScript clean' : 'L1: TypeScript check clean (all packages)',
    passed: false,
    durationMs: cmd.durationMs,
    error: cmd.error.split('\n').slice(0, 5).join('\n'),
    evidence: 'tsc --noEmit failed',
  };
}

// ─── L1 断言 4: 测试通过 ───
function assertTestsPass(webOnly) {
  const start = Date.now();
  // 复用 pre-merge-check.sh 的 test 命令：清除 REDIS_URL 避免触发 Redis 隔离守卫
  const env = { ...process.env, REDIS_URL: undefined };
  const cmd = webOnly
    ? runCommand('pnpm', ['--filter', '@cat-cafe/web', 'exec', 'vitest', 'run'], rootDir, 120_000)
    : runCommand('pnpm', ['test'], rootDir, 180_000);

  if (cmd.ok) {
    return {
      name: webOnly ? 'L1: Web tests pass' : 'L1: Tests pass (all packages)',
      passed: true,
      durationMs: cmd.durationMs,
      evidence: webOnly ? 'pnpm --filter @cat-cafe/web exec vitest run passed' : 'pnpm test passed',
    };
  }
  return {
    name: webOnly ? 'L1: Web tests pass' : 'L1: Tests pass (all packages)',
    passed: false,
    durationMs: cmd.durationMs,
    error: cmd.error.split('\n').slice(0, 5).join('\n'),
    evidence: 'test command failed',
  };
}

// ─── Quality Gate 主入口 ───
export function runL1QualityGate(webOnly = false) {
  const repoRoot = findRepoRoot(process.cwd()) || rootDir;
  const results = [];

  // 顺序执行：worktree-clean 最先（WI-10 保障）
  results.push(assertWorktreeClean(repoRoot));
  results.push(assertBuildPasses(webOnly));
  results.push(assertTypeCheckClean(webOnly));
  results.push(assertTestsPass(webOnly));

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results, repoRoot };
}

// ─── 报告格式 ───
function formatReport(result) {
  const lines = [
    '=== Clowder L1 Quality Gate ===',
    `Repo: ${relative(process.cwd(), result.repoRoot) || '.'}`,
    '',
    ...result.results.map((r) => {
      const icon = r.passed ? '✅' : '❌';
      const line = `${icon} ${r.name} (${r.durationMs}ms)`;
      if (r.error) {
        return `${line}\n   Error: ${r.error.split('\n')[0]}${r.error.includes('\n') ? '...' : ''}`;
      }
      return line;
    }),
    '',
    result.allPassed
      ? '🟢 All L1 assertions passed. Ready for in_review.'
      : '🔴 L1 assertions failed. Fix before in_review.',
  ];
  return lines.join('\n');
}

// ─── CLI 入口 ───
function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runL1QualityGate(args.webOnly);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }

  process.exit(result.allPassed ? 0 : 1);
}

main();
