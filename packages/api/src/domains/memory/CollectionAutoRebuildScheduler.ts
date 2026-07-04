import { CollectionIndexBuilder, type CollectionRebuildResult } from './CollectionIndexBuilder.js';
import type { CollectionManifest } from './collection-types.js';
import type { IEvidenceStore } from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { resolveCollectionScanner } from './scanner-resolver.js';

export const DEFAULT_COLLECTION_AUTO_REBUILD_INTERVAL_MS = 5 * 60 * 1000;
const MIN_COLLECTION_AUTO_REBUILD_INTERVAL_MS = 30 * 1000;

export interface CollectionAutoRebuildSchedulerOptions {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  intervalMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface CollectionAutoRebuildCycleResult {
  eligible: number;
  rebuilt: number;
  skipped: number;
  failed: Array<{ collectionId: string; error: string }>;
  results: Array<{ collectionId: string; result: CollectionRebuildResult }>;
}

export function resolveCollectionAutoRebuildIntervalMs(raw?: string | number | null): number {
  const value = typeof raw === 'number' ? raw : raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(value) && value >= MIN_COLLECTION_AUTO_REBUILD_INTERVAL_MS) return value;
  return DEFAULT_COLLECTION_AUTO_REBUILD_INTERVAL_MS;
}

export class CollectionAutoRebuildScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<string>();
  private readonly intervalMs: number;

  constructor(private readonly opts: CollectionAutoRebuildSchedulerOptions) {
    this.intervalMs = resolveCollectionAutoRebuildIntervalMs(
      opts.intervalMs ?? process.env.CAT_CAFE_COLLECTION_AUTO_REBUILD_INTERVAL_MS,
    );
  }

  start(): void {
    if (this.timer) return;
    if (this.getAutoRebuildManifests().length === 0) return;

    this.timer = setInterval(() => {
      void this.rebuildAutoCollections().catch((err) => {
        this.opts.logger?.error?.({ err }, 'collection auto rebuild cycle failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async rebuildAutoCollections(options?: { force?: boolean }): Promise<CollectionAutoRebuildCycleResult> {
    const manifests = this.getAutoRebuildManifests();
    const cycle: CollectionAutoRebuildCycleResult = {
      eligible: manifests.length,
      rebuilt: 0,
      skipped: 0,
      failed: [],
      results: [],
    };

    for (const manifest of manifests) {
      if (this.running.has(manifest.id)) {
        cycle.skipped++;
        continue;
      }

      try {
        const result = await this.rebuildCollection(manifest.id, { force: options?.force ?? false });
        cycle.rebuilt++;
        cycle.results.push({ collectionId: manifest.id, result });
      } catch (err) {
        cycle.failed.push({
          collectionId: manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return cycle;
  }

  async rebuildCollection(collectionId: string, options?: { force?: boolean }): Promise<CollectionRebuildResult> {
    if (this.running.has(collectionId)) {
      throw new Error(`Collection "${collectionId}" is already rebuilding`);
    }

    const manifest = this.opts.catalog.get(collectionId);
    if (!manifest) throw new Error(`Collection "${collectionId}" not found`);
    if (manifest.readOnly !== true) {
      throw new Error(`Collection "${collectionId}" is not a read-only knowledge collection`);
    }
    const store = this.opts.stores.get(manifest.id);
    if (!store) throw new Error(`Collection "${collectionId}" store not found`);

    this.running.add(collectionId);
    try {
      return await rebuildCollectionIndex(manifest, store, { force: options?.force ?? false });
    } finally {
      this.running.delete(collectionId);
    }
  }

  private getAutoRebuildManifests(): CollectionManifest[] {
    return this.opts.catalog
      .list()
      .filter((manifest) => manifest.readOnly === true && manifest.indexPolicy.autoRebuild);
  }
}

export async function rebuildCollectionIndex(
  manifest: CollectionManifest,
  store: IEvidenceStore,
  options?: { force?: boolean },
): Promise<CollectionRebuildResult> {
  const scanner = resolveCollectionScanner(manifest);
  const builder = new CollectionIndexBuilder(store as SqliteEvidenceStore, manifest, scanner);
  return builder.rebuild({ force: options?.force ?? false });
}
