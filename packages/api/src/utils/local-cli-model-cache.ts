import type { LocalCliProbeResult } from './local-cli-probe.js';

export interface LocalCliModelsSnapshot {
  readonly scannedAt: string;
  readonly clis: readonly LocalCliProbeResult[];
}

const latestSnapshotsByUser = new Map<string, LocalCliModelsSnapshot>();

export function getLocalCliModelsSnapshot(userId: string): LocalCliModelsSnapshot | null {
  return latestSnapshotsByUser.get(userId) ?? null;
}

export function updateLocalCliModelsSnapshot(userId: string, snapshot: LocalCliModelsSnapshot): void {
  latestSnapshotsByUser.set(userId, snapshot);
}

/** Test-only reset for isolating the process-local manual scan cache. */
export function resetLocalCliModelsSnapshot(userId?: string): void {
  if (userId) {
    latestSnapshotsByUser.delete(userId);
    return;
  }
  latestSnapshotsByUser.clear();
}
