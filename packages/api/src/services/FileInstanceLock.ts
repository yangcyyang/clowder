/**
 * A4 (batch 4-A): 属主锁最小版 — file-layer owner lock (anti double-start).
 *
 * Real incident (07-24): a desktop App and a PM2-managed process both started an
 * API instance against the SAME data root and fought over it. `ApiInstanceLease`
 * (services/ApiInstanceLease.ts) already guards this via a Redis key — but that
 * lease is only ever constructed `if (redis)` (see index.ts's startup sequence).
 * When Redis is unavailable/disabled (e.g. a quick/offline profile), NOTHING
 * currently stops a second instance from starting against the same `.cat-cafe`
 * data root. This is the fallback for exactly that gap: a marker file at the data
 * root, checked unconditionally (independent of whether Redis is up), so the two
 * layers are complementary rather than competing — see module doc on
 * ApiInstanceLease.ts for why this file does NOT touch that class.
 *
 * Identity check is pid + the data root DIRECTORY's own {dev, ino} (not the marker
 * file's) — this catches a stale marker that describes a *different* physical data
 * root that happens to share the same path (deleted+recreated directory, or a
 * leftover marker copied from elsewhere), which a bare pid check alone would miss.
 * A marker whose pid is dead (`kill -0` fails) is stale and safe to take over
 * automatically; a marker whose recorded {dev, ino} no longer matches the current
 * data root is treated the same way (foreign/stale, not a live conflict).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname as getHostname } from 'node:os';
import { join } from 'node:path';

export const FILE_INSTANCE_LOCK_FILENAME = 'api-instance.lock';

/** Kill switch — default ON. See env-registry.ts CLOWDER_FILE_INSTANCE_LOCK entry. */
export function isFileInstanceLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_FILE_INSTANCE_LOCK ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export interface FileInstanceLockMarker {
  version: 1;
  token: string;
  pid: number;
  /** Data root directory's own device id at acquire time — see module doc. */
  dev: number;
  /** Data root directory's own inode number at acquire time — see module doc. */
  ino: number;
  hostname: string;
  cwd: string;
  apiPort: number;
  startedAt: number;
}

export interface FileInstanceLockOptions {
  /** Clowder data root (e.g. `.cat-cafe`'s parent, or `.cat-cafe` itself — caller's choice; the marker is written directly inside this directory). */
  dataRoot: string;
  apiPort: number;
  pid?: number;
  hostname?: string;
  cwd?: string;
  startedAt?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface FileInstanceLockAcquireResult {
  acquired: boolean;
  /** Present when acquired === false: the live holder currently occupying the lock. */
  conflict?: FileInstanceLockMarker;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    return code !== 'ESRCH';
  }
}

/** Human-readable (Chinese) conflict message for a rejected startup. */
export function formatFileInstanceLockConflict(conflict: FileInstanceLockMarker, dataRoot: string): string {
  const markerPath = join(dataRoot, FILE_INSTANCE_LOCK_FILENAME);
  return (
    `另一个 Clowder API（pid ${conflict.pid}，工作目录 ${conflict.cwd}，端口 ${conflict.apiPort}）` +
    `正在使用此数据目录（${dataRoot}）。\n` +
    `如果确认该进程已不存在：请稍等几秒后重试（旧进程可能仍在退出中），或手动结束该进程后重启；` +
    `如果该锁文件确实是残留（比如强制关机后留下），可以删除 ${markerPath} 后重启。`
  );
}

export class FileInstanceLock {
  private readonly dataRoot: string;
  private readonly apiPort: number;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly cwd: string;
  private readonly startedAt: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly token: string;
  private held = false;

  constructor(options: FileInstanceLockOptions) {
    this.dataRoot = options.dataRoot;
    this.apiPort = options.apiPort;
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? getHostname();
    this.cwd = options.cwd ?? process.cwd();
    this.startedAt = options.startedAt ?? Date.now();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? (() => Date.now());
    this.token = randomUUID();
  }

  private get markerPath(): string {
    return join(this.dataRoot, FILE_INSTANCE_LOCK_FILENAME);
  }

  /**
   * Attempts to acquire the lock. A stale marker (dead pid, or {dev,ino} mismatch
   * against the CURRENT data root directory) is automatically taken over. Returns
   * `{acquired:false, conflict}` when a live, matching-root holder already owns it —
   * the caller must refuse to start (see formatFileInstanceLockConflict).
   */
  async acquire(): Promise<FileInstanceLockAcquireResult> {
    // A genuinely first-ever start (no prior .cat-cafe at all) must not crash here —
    // mirrors GovernanceRegistry.write()'s same defensive mkdir.
    await mkdir(this.dataRoot, { recursive: true });
    const rootStat = await stat(this.dataRoot);
    const existing = await this.readMarker();
    if (existing) {
      const stale =
        existing.dev !== rootStat.dev || existing.ino !== rootStat.ino || !this.isPidAlive(existing.pid);
      if (!stale) {
        return { acquired: false, conflict: existing };
      }
    }

    const marker: FileInstanceLockMarker = {
      version: 1,
      token: this.token,
      pid: this.pid,
      dev: rootStat.dev,
      ino: rootStat.ino,
      hostname: this.hostname,
      cwd: this.cwd,
      apiPort: this.apiPort,
      startedAt: this.startedAt,
    };
    await writeFile(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
    this.held = true;
    return { acquired: true };
  }

  /** Removes the marker file — only if we're the ones still holding it (token match), so a stale-takeover by a newer process is never clobbered by a slow-shutdown of the old one. */
  async release(): Promise<void> {
    if (!this.held) return;
    try {
      const current = await this.readMarker();
      if (current && current.token === this.token) {
        await unlink(this.markerPath);
      }
    } catch {
      /* best-effort — a leftover marker will be recognized as stale (dead pid) next start */
    } finally {
      this.held = false;
    }
  }

  private async readMarker(): Promise<FileInstanceLockMarker | null> {
    try {
      const raw = await readFile(this.markerPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<FileInstanceLockMarker>;
      if (
        parsed.version !== 1 ||
        typeof parsed.token !== 'string' ||
        typeof parsed.pid !== 'number' ||
        typeof parsed.dev !== 'number' ||
        typeof parsed.ino !== 'number' ||
        typeof parsed.hostname !== 'string' ||
        typeof parsed.cwd !== 'string' ||
        typeof parsed.apiPort !== 'number' ||
        typeof parsed.startedAt !== 'number'
      ) {
        return null; // corrupt/foreign marker — treat as absent, safe to overwrite
      }
      return parsed as FileInstanceLockMarker;
    } catch {
      return null; // ENOENT (first start) or unreadable — either way, nothing to conflict with
    }
  }
}
