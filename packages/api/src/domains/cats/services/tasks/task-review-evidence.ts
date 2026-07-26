/**
 * 批次4-B4①③ 验收证据自动化 (docs/prd/batch4-codex-execution.md §3 B4):
 *   ① 置 in_review 时自动把 commit sha / diff stat / 改动文件清单锚进票 thread;
 *   ③ 静态扫描: 二进制文件 + 裸控制字符 + diff 内密钥形态 (历史真实拦截对象: 裸 NUL 进
 *     代码、API key 进标题 — 复用现成的 textContainsSecretValue, 不新造平行正则).
 *
 * Scope/design notes (see batch report for the full writeup):
 * - Repo resolution: the task's home thread's `projectPath` (ThreadStore) when bound to a
 *   real project directory, otherwise falls back to the api process's own cwd (this works
 *   because `git -C <dir>` finds the enclosing repo from any subdirectory — no need to locate
 *   a monorepo root explicitly). Resolved directory must pass isUnderAllowedRoot() before any
 *   git subprocess runs (same guard already used for project-path validation elsewhere).
 * - Evidence = the *latest commit* (HEAD vs its first parent), not the live working tree —
 *   "commit sha" pairs naturally with "this commit's diff", and by the time a cat marks
 *   in_review its work is expected to be committed (this repo's own "小步提交" discipline).
 *   `hasUncommittedChanges` is captured as a supplementary flag (via `git status --porcelain`)
 *   so a reviewer can see when the working tree doesn't fully match the anchored diff.
 * - Never blocks or fails the in_review transition: every failure mode (not a git repo, repo
 *   outside the allowed roots, git missing, timeout, no commits yet) is caught and skipped —
 *   this is best-effort visibility, not a gate.
 * - Raw diff text scanned for static-scan purposes is capped (MAX_DIFF_SCAN_BYTES) — this is a
 *   lightweight guardrail, not a full-repo linter.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { appendTaskLifecycleNotice, taskLifecycleLabel } from '../../../../routes/task-event-notices.js';
import { textContainsSecretValue } from '../../../../utils/env-var-secret-guard.js';
import { isUnderAllowedRoot } from '../../../../utils/project-path.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { SocketManager } from '../../../../infrastructure/websocket/index.js';

const log = createModuleLogger('task-review-evidence');
const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const MAX_DIFF_SCAN_BYTES = 200_000;
const MAX_FILES_LISTED = 30;

/** Kill switch — default ON. See env-registry.ts CLOWDER_REVIEW_EVIDENCE_AUTO_ANCHOR entry. */
export function isReviewEvidenceAutoAnchorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_REVIEW_EVIDENCE_AUTO_ANCHOR ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export interface GitRunner {
  (cwd: string, args: string[]): Promise<string | null>;
}

/** Real git runner — read-only subcommands only, args passed as an array (no shell). */
export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
};

export interface GitEvidenceSnapshot {
  repoDir: string;
  commitSha: string;
  diffStat: string;
  changedFiles: string[];
  hasUncommittedChanges: boolean;
  scanFlags: string[];
}

/** Resolve which directory's git history to inspect for this task's most recent work. */
export async function resolveEvidenceRepoDir(
  task: Pick<TaskItem, 'threadId'>,
  threadStore: Pick<IThreadStore, 'get'> | undefined,
): Promise<string | null> {
  let candidate: string | undefined;
  if (threadStore) {
    const thread = await threadStore.get(task.threadId);
    if (thread?.projectPath && thread.projectPath !== 'default') candidate = thread.projectPath;
  }
  const dir = candidate ?? process.cwd();
  if (!isUnderAllowedRoot(dir)) return null;
  return dir;
}

/** git diff --numstat lines for binary files read "-\t-\t<path>" — no textual add/remove counts. */
function extractBinaryFiles(numstat: string): string[] {
  const binary: string[] = [];
  for (const line of numstat.split('\n')) {
    const [added, removed, ...pathParts] = line.split('\t');
    if (added === '-' && removed === '-' && pathParts.length > 0) {
      binary.push(pathParts.join('\t'));
    }
  }
  return binary;
}

/** 裸控制字符: bytes that have no business appearing in a text diff (NUL and other C0 controls, excluding \t\n\r). */
function findBareControlCharacters(diffText: string): boolean {
  // eslint-disable-next-line no-control-regex -- intentional: scanning for stray control bytes.
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(diffText);
}

function runStaticScan(diffText: string, numstat: string): string[] {
  const flags: string[] = [];
  const binaryFiles = extractBinaryFiles(numstat);
  if (binaryFiles.length > 0) {
    flags.push(`diff 含二进制文件改动(${binaryFiles.length} 个): ${binaryFiles.slice(0, 5).join(', ')}`);
  }
  const scanText = diffText.length > MAX_DIFF_SCAN_BYTES ? diffText.slice(0, MAX_DIFF_SCAN_BYTES) : diffText;
  if (findBareControlCharacters(scanText)) {
    flags.push('diff 中检测到裸控制字符(非 \\t\\n\\r 的 C0 控制码，含 NUL)');
  }
  if (textContainsSecretValue(scanText)) {
    flags.push('diff 中检测到密钥形态字符串(API key/token 等) — 请在验收前确认无凭证泄漏');
  }
  return flags;
}

/** Best-effort git snapshot for the latest commit. Returns null on any failure (no repo, no commits, timeout, denied root). */
export async function captureGitEvidence(
  repoDir: string,
  git: GitRunner = runGit,
): Promise<GitEvidenceSnapshot | null> {
  const sha = await git(repoDir, ['rev-parse', 'HEAD']);
  if (!sha) return null;
  const commitSha = sha.trim();

  const hasParent = (await git(repoDir, ['rev-parse', `${commitSha}~1`])) !== null;
  const range = hasParent ? [`${commitSha}~1`, commitSha] : commitSha;
  const rangeArgs = Array.isArray(range) ? range : [range];

  const diffStat = (await git(repoDir, ['diff', '--stat', ...rangeArgs])) ?? '(diff --stat 不可用)';
  const numstat = (await git(repoDir, ['diff', '--numstat', ...rangeArgs])) ?? '';
  const nameOnly = (await git(repoDir, ['diff', '--name-only', ...rangeArgs])) ?? '';
  const rawDiff = (await git(repoDir, ['diff', ...rangeArgs])) ?? '';
  const statusPorcelain = await git(repoDir, ['status', '--porcelain']);

  const changedFiles = nameOnly
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    repoDir,
    commitSha,
    diffStat: diffStat.trim(),
    changedFiles,
    hasUncommittedChanges: Boolean(statusPorcelain && statusPorcelain.trim().length > 0),
    scanFlags: runStaticScan(rawDiff, numstat),
  };
}

function formatEvidenceContent(snapshot: GitEvidenceSnapshot, label: string): string {
  const fileLines =
    snapshot.changedFiles.length === 0
      ? '(无改动文件 — 可能是无父提交的首个 commit，或 diff 为空)'
      : snapshot.changedFiles
          .slice(0, MAX_FILES_LISTED)
          .map((f) => `- ${f}`)
          .join('\n') +
        (snapshot.changedFiles.length > MAX_FILES_LISTED
          ? `\n… 另有 ${snapshot.changedFiles.length - MAX_FILES_LISTED} 个文件未列出`
          : '');

  const scanSection =
    snapshot.scanFlags.length === 0 ? '静态扫描: 未发现异常' : `静态扫描发现 ${snapshot.scanFlags.length} 项:\n${snapshot.scanFlags.map((f) => `⚠️ ${f}`).join('\n')}`;

  return [
    `[验收证据自动锚定] 任务 ${label} 已置 in_review`,
    `提交: ${snapshot.commitSha}${snapshot.hasUncommittedChanges ? '（工作区仍有未提交改动，以下证据可能不完整）' : ''}`,
    `diff stat:\n\`\`\`\n${snapshot.diffStat || '(无变更)'}\n\`\`\``,
    `改动文件(${snapshot.changedFiles.length}):\n${fileLines}`,
    scanSection,
  ].join('\n\n');
}

export interface AnchorEvidenceDeps {
  taskStore: Pick<ITaskStore, 'update' | 'listByThread'>;
  threadStore?: Pick<IThreadStore, 'get'>;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
}

/**
 * Best-effort: resolve repo → capture snapshot → post into the task's own discussion thread
 * → append an 'evidence_anchored' ledger event. Never throws — every step degrades to a no-op
 * on failure so the in_review transition itself is never blocked by this.
 */
export async function anchorReviewEvidence(task: TaskItem, deps: AnchorEvidenceDeps): Promise<void> {
  if (!isReviewEvidenceAutoAnchorEnabled(deps.env)) return;
  try {
    const repoDir = await resolveEvidenceRepoDir(task, deps.threadStore);
    if (!repoDir) return;
    const snapshot = await captureGitEvidence(repoDir, deps.git);
    if (!snapshot) return;

    const label = await taskLifecycleLabel(deps.taskStore, task).catch(() => `#${task.id}`);
    const targetThreadId = task.taskThreadId ?? task.threadId;
    const content = formatEvidenceContent(snapshot, label);

    await appendTaskLifecycleNotice({
      task: { id: task.id, threadId: targetThreadId },
      content,
      systemKind: 'task_status_changed',
      eventType: 'evidence_anchored',
      tone: snapshot.scanFlags.length > 0 ? 'warning' : 'info',
      dedupeKey: `evidence:${snapshot.commitSha}`,
      deps: { messageStore: deps.messageStore, socketManager: deps.socketManager },
    });

    await deps.taskStore.update(task.id, {
      eventCatId: 'system',
      events: [
        {
          ts: new Date().toISOString(),
          catId: 'system',
          type: 'evidence_anchored',
          data: {
            repoDir: snapshot.repoDir,
            commitSha: snapshot.commitSha,
            hasUncommittedChanges: snapshot.hasUncommittedChanges,
            changedFileCount: snapshot.changedFiles.length,
            scanFlags: snapshot.scanFlags,
          },
        },
      ],
    });
  } catch (err) {
    log.warn(`[task-review-evidence] anchor failed (best-effort): ${String(err)}`);
  }
}
