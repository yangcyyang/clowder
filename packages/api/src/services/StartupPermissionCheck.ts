/**
 * A1 (batch 4-A): 启动权限自检 — Startup Permission Self-Check.
 *
 * One-shot on API startup — deliberately NOT a recurring poller (spec: "明确不做：
 * 每小时轮询"). The only re-check trigger besides the initial startup call is A2's
 * `permission_denied` classification path (see provider-error-classification.ts):
 * a CLI/governance-gate EPERM failure during dispatch calls `runCheck()` again so
 * a freshly-revoked directory is reported without waiting for a restart.
 *
 * For every project CONFIRMED in the governance registry, read-probes a known file
 * (CLAUDE.md — GovernanceBootstrapService.bootstrap() unconditionally writes this
 * for every provider, so it is always present after a real confirm+bootstrap) to
 * detect macOS TCC silently revoking folder access. Also write-probes the Clowder
 * data root itself (a temp file created + immediately removed).
 *
 * On failure: posts a zero-token Chinese system alert card to the lobby
 * (DEFAULT_THREAD_ID) with remediation guidance, mirroring the governance-blocked
 * card's messageStore.append shape (invoke-single-cat.ts) — connector/label/icon/
 * meta.presentation='system_notice' + idempotencyKey. On recovery (the SAME
 * directory later passes again), posts a resolution notice. A directory whose
 * status hasn't changed since the last check is never re-announced (in-memory
 * per-directory last-known-status map).
 */

import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GovernanceRegistry } from '../config/governance/governance-registry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { DEFAULT_THREAD_ID } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('StartupPermissionCheck');

/** Written unconditionally by GovernanceBootstrapService.bootstrap() for every provider — always present after a real confirm. */
const KNOWN_PROBE_FILENAME = 'CLAUDE.md';

/** Kill switch — default ON. See env-registry.ts CLOWDER_STARTUP_PERMISSION_CHECK entry. */
export function isStartupPermissionCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_STARTUP_PERMISSION_CHECK ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

/** Sentinel key for the data-root write-probe entry in the per-directory status map (never collides with a real absolute project path). */
const DATA_ROOT_STATUS_KEY = '__cat_cafe_data_root__';

export interface StartupPermissionCheckDeps {
  /** Clowder data root (contains .cat-cafe/governance-registry.json) — used for both the registry read and the write-probe. */
  catCafeRoot: string;
  messageStore: IMessageStore;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * A2 (base spec) wiring: "CLI 启动即退且 stderr 含 EPERM/permission... 并触发 A1 的自检
 * 立即复跑一次" — a module-level singleton accessor so invoke-single-cat.ts (a
 * different module, not part of index.ts's startup closure) can trigger an
 * immediate recheck from its permission_denied dispatch-block branch without
 * threading a new dependency through the entire routing/dependency chain. Mirrors
 * the plain singleton style already used for catRegistry-shaped process-wide
 * services in this codebase. index.ts registers the real instance once at
 * startup; tests never call set (so getActiveStartupPermissionCheck() is safely
 * `undefined` unless explicitly wired).
 */
let activeInstance: StartupPermissionCheck | undefined;

export function setActiveStartupPermissionCheck(instance: StartupPermissionCheck | undefined): void {
  activeInstance = instance;
}

export function getActiveStartupPermissionCheck(): StartupPermissionCheck | undefined {
  return activeInstance;
}

export class StartupPermissionCheck {
  private readonly deps: StartupPermissionCheckDeps;
  private readonly now: () => number;
  /** Last known ok/broken status per directory key. Absent = never checked yet. */
  private readonly lastStatus = new Map<string, boolean>();

  constructor(deps: StartupPermissionCheckDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Runs one full check pass (data root write-probe + every confirmed project's read-probe). Safe to call more than once. */
  async runCheck(): Promise<void> {
    await this.checkDataRootWritable();
    await this.checkRegisteredProjects();
  }

  private async checkDataRootWritable(): Promise<void> {
    const probePath = join(this.deps.catCafeRoot, `.permission-probe-${randomUUID()}.tmp`);
    let ok = true;
    let reason: string | undefined;
    try {
      await writeFile(probePath, 'probe', 'utf-8');
      await unlink(probePath).catch(() => {
        /* best-effort cleanup — a leftover probe file is harmless */
      });
    } catch (err) {
      ok = false;
      reason = err instanceof Error ? err.message : String(err);
    }
    await this.reportStatus(DATA_ROOT_STATUS_KEY, this.deps.catCafeRoot, ok, reason, 'write');
  }

  private async checkRegisteredProjects(): Promise<void> {
    let confirmedPaths: string[];
    try {
      const registry = new GovernanceRegistry(this.deps.catCafeRoot);
      const entries = await registry.listAll();
      confirmedPaths = entries.filter((e) => e.confirmedByUser).map((e) => e.projectPath);
    } catch (err) {
      // A3: registry.listAll()/read() now propagates EPERM/EACCES instead of silently
      // reporting "empty" — this self-check is best-effort and must not throw the API
      // startup path; log and skip the per-project pass for this run.
      log.warn(`[startup-permission-check] failed to read governance registry (best-effort): ${String(err)}`);
      return;
    }

    for (const projectPath of confirmedPaths) {
      let ok = true;
      let reason: string | undefined;
      try {
        await readFile(join(projectPath, KNOWN_PROBE_FILENAME), 'utf-8');
      } catch (err) {
        ok = false;
        reason = err instanceof Error ? err.message : String(err);
      }
      await this.reportStatus(projectPath, projectPath, ok, reason, 'read');
    }
  }

  private async reportStatus(
    key: string,
    displayPath: string,
    ok: boolean,
    reason: string | undefined,
    mode: 'read' | 'write',
  ): Promise<void> {
    const previous = this.lastStatus.get(key);
    if (previous === ok) return; // unchanged since the last check — never re-announce
    this.lastStatus.set(key, ok);
    if (previous === undefined && ok) return; // first-ever check and it's healthy — nothing to tell anyone

    const verb = mode === 'write' ? '写入' : '读取';
    const content = ok
      ? `✅ Clowder 权限自检恢复：现在可以正常${verb} ${displayPath} 了。`
      : [
          `🔒 Clowder 权限自检失败：无法${verb} ${displayPath}。`,
          '可能原因：macOS 隐私设置（TCC）静默收回了访问权限。',
          '修复指引：在有完整磁盘访问权限的终端跑 pm2 update；或打开 系统设置 → 隐私与安全性 → 完整磁盘访问权限，勾选运行 Clowder 的程序后重启。',
          reason ? `原始错误：${reason}` : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n');

    try {
      await this.deps.messageStore.append({
        userId: 'system',
        catId: null,
        threadId: DEFAULT_THREAD_ID,
        content,
        mentions: [],
        timestamp: this.now(),
        source: {
          connector: 'startup-permission-check',
          label: '权限自检',
          icon: ok ? '✅' : '🔒',
          meta: { presentation: 'system_notice', noticeTone: ok ? 'success' : 'warning', path: displayPath, mode },
        },
        idempotencyKey: `startup-permission-check:${key}:${ok ? 'recovered' : 'failed'}:${this.now()}`,
      });
    } catch (err) {
      // Best-effort — visibility must not break the self-check itself.
      log.warn(`[startup-permission-check] failed to post system notice (best-effort): ${String(err)}`);
    }
  }
}
