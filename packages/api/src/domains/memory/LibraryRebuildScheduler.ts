/**
 * LibraryRebuildScheduler — F-H (batch 0), item 1: periodic auto-rebuild for
 * read-only library collections (currently: Obsidian vault mounts registered
 * via obsidian-readonly-collections.ts, e.g. domain:orbitos-knowledge).
 *
 * Gated by env `CLOWDER_LIBRARY_REBUILD_HOURS` (default 24h, 0 = off — see
 * src/config/env-registry.ts). Every collection's `indexPolicy.autoRebuild`
 * is hard-coded `false` at manifest-construction time (see
 * obsidian-readonly-collections.ts / library.ts POST /register) — that flag
 * is a per-collection policy switch reserved for a future "auto rebuild this
 * one collection" feature. This scheduler is a *separate*, coarser mechanism:
 * a single process-wide timer that periodically re-runs the exact same
 * rebuild logic the manual `POST /api/library/:collectionId/rebuild` route
 * uses (CollectionIndexBuilder + resolveCollectionScanner — no duplicated
 * logic) against every `readOnly: true` collection in the catalog.
 *
 * Mirrors AutoRetryScheduler.ts's shape:
 *  - .unref()'d timer — never keeps the process alive on its own.
 *  - tick() re-reads the env var every time (runtime toggle without restart).
 *  - a failed rebuild pass is logged and swallowed — never throws out of the
 *    interval callback — and simply gets retried on the next tick (lastRunAt
 *    only advances after an all-collections-succeeded pass), rather than
 *    waiting a full CLOWDER_LIBRARY_REBUILD_HOURS window again.
 *
 * Unlike AutoRetryScheduler, this scheduler does not depend on Redis: the
 * catalog/collection stores it operates on are plain in-process SQLite
 * (memoryServices.catalog / memoryServices.collectionStores), available
 * whether or not REDIS_URL is configured. It is constructed and started
 * directly from createMemoryServices() (factory.ts) for that reason.
 */

import { createModuleLogger } from '../../infrastructure/logger.js';
import { CollectionIndexBuilder } from './CollectionIndexBuilder.js';
import type { CollectionManifest } from './collection-types.js';
import type { IEvidenceStore } from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { resolveCollectionScanner } from './scanner-resolver.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

const log = createModuleLogger('LibraryRebuildScheduler');

export const DEFAULT_LIBRARY_REBUILD_HOURS = 24;

/** Scan cadence for the internal timer — deliberately much shorter than the
 * hours-scale rebuild threshold so a due rebuild isn't left waiting long
 * past its window, and so a failed pass gets retried reasonably soon. */
const DEFAULT_TICK_INTERVAL_MS = 15 * 60_000; // 15 minutes

const MS_PER_HOUR = 3_600_000;

/**
 * Parse CLOWDER_LIBRARY_REBUILD_HOURS. Unset/blank → default 24. Negative or
 * non-numeric → default 24 (fail-open on operator typos). `0` is a valid,
 * meaningful "off" value — it is NOT treated as invalid.
 */
export function resolveLibraryRebuildHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CLOWDER_LIBRARY_REBUILD_HOURS ?? '').trim();
  if (raw === '') return DEFAULT_LIBRARY_REBUILD_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIBRARY_REBUILD_HOURS;
  return n;
}

export function isLibraryRebuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveLibraryRebuildHours(env) > 0;
}

export interface LibraryRebuildSchedulerDeps {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable env lookup for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Internal timer cadence override for tests (default 15 min). */
  tickIntervalMs?: number;
}

export class LibraryRebuildScheduler {
  private readonly deps: LibraryRebuildSchedulerDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks if a rebuild pass takes longer than the tick interval. */
  private ticking = false;
  /** Wall-clock (per `now()`) of the last fully-successful rebuild pass. Seeded at construction so a fresh process waits a full window before its first automatic rebuild, rather than firing immediately on every restart. */
  private lastRunAt: number;

  constructor(deps: LibraryRebuildSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.lastRunAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`[library-rebuild-scheduler] tick failed (best-effort): ${String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @internal test-only: force the next tick to consider a rebuild due, regardless of the injected clock or configured hours. */
  _forceDueForTest(): void {
    this.lastRunAt = Number.NEGATIVE_INFINITY;
  }

  /** One scan pass. Exposed for tests — production code should use start()/stop(). */
  async tick(): Promise<void> {
    if (this.ticking) return;

    const hours = resolveLibraryRebuildHours(this.deps.env ?? process.env);
    if (hours <= 0) return; // disabled

    if (this.now() < this.lastRunAt + hours * MS_PER_HOUR) return; // not due yet

    this.ticking = true;
    try {
      const allOk = await this.rebuildAll();
      if (allOk) {
        this.lastRunAt = this.now();
      }
      // else: leave lastRunAt as-is so the NEXT tick retries sooner than a
      // full window away (silent retry — see class doc).
    } finally {
      this.ticking = false;
    }
  }

  /** Rebuild every readOnly collection. Returns true only if every collection's rebuild call resolved without throwing. */
  private async rebuildAll(): Promise<boolean> {
    const manifests = this.deps.catalog.list().filter((m: CollectionManifest) => m.readOnly === true);
    let allOk = true;

    for (const manifest of manifests) {
      const store = this.deps.stores.get(manifest.id);
      if (!store) continue; // no store bound (yet) — nothing to rebuild, not a failure

      try {
        const scanner = resolveCollectionScanner(manifest);
        const builder = new CollectionIndexBuilder(store as SqliteEvidenceStore, manifest, scanner);
        const result = await builder.rebuild();
        log.info(
          `[library-rebuild-scheduler] rebuilt ${manifest.id}: indexed=${result.indexed} skipped=${result.skipped} blocked=${result.blocked}${
            result.quarantinedFiles.length > 0 ? ` quarantined=${result.quarantinedFiles.length}` : ''
          }`,
        );
      } catch (err) {
        allOk = false;
        log.warn(
          `[library-rebuild-scheduler] rebuild failed for ${manifest.id} (best-effort, will retry next tick): ${String(err)}`,
        );
      }
    }

    return allOk;
  }
}
