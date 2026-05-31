import type { FastifyPluginAsync } from 'fastify';
import type {
  IInvocationRecordStore,
  InvocationRecord,
  InvocationStatus,
} from '../domains/cats/services/stores/ports/InvocationRecordStore.js';

export type TrafficLightState = 'idle' | 'running' | 'error';

export interface RuntimeTrafficLightRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
  now?: () => number;
}

const RECENT_FAILURE_WINDOW_MS = 5 * 60 * 1000;

function latestByUpdatedAt(records: InvocationRecord[], statuses: InvocationStatus[]): InvocationRecord | null {
  const allowed = new Set(statuses);
  let latest: InvocationRecord | null = null;
  for (const record of records) {
    if (!allowed.has(record.status)) continue;
    if (!latest || record.updatedAt > latest.updatedAt) latest = record;
  }
  return latest;
}

export function buildRuntimeTrafficLightSnapshot(
  records: InvocationRecord[],
  now = Date.now(),
): {
  state: TrafficLightState;
  runningCount: number;
  queuedCount: number;
  failedCount: number;
  lastCompletedAt: string | null;
  lastAgent: string | null;
  lastStatus: InvocationStatus | null;
  checkedAt: string;
} {
  const runningCount = records.filter((record) => record.status === 'running').length;
  const queuedCount = records.filter((record) => record.status === 'queued').length;
  const failedCount = records.filter((record) => record.status === 'failed').length;
  const latestDone = latestByUpdatedAt(records, ['succeeded', 'failed', 'canceled']);
  const latestFailed = latestByUpdatedAt(records, ['failed']);

  let state: TrafficLightState = 'idle';
  if (runningCount > 0 || queuedCount > 0) {
    state = 'running';
  } else if (latestFailed && now - latestFailed.updatedAt <= RECENT_FAILURE_WINDOW_MS) {
    state = 'error';
  }

  return {
    state,
    runningCount,
    queuedCount,
    failedCount,
    lastCompletedAt: latestDone ? new Date(latestDone.updatedAt).toISOString() : null,
    lastAgent: latestDone?.targetCats[0] ?? null,
    lastStatus: latestDone?.status ?? null,
    checkedAt: new Date(now).toISOString(),
  };
}

export const runtimeTrafficLightRoutes: FastifyPluginAsync<RuntimeTrafficLightRoutesOptions> = async (app, opts) => {
  app.get('/api/runtime/traffic-light', async () => {
    const records = opts.invocationRecordStore.scanAll ? await opts.invocationRecordStore.scanAll() : [];
    return buildRuntimeTrafficLightSnapshot(records, opts.now?.() ?? Date.now());
  });
};
