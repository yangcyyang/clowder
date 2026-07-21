/**
 * 理智线 T6 (task #388): quota-cooldown expiry sweep.
 *
 * QueueProcessor's layer-1 dispatch gate (see QueueProcessor.ts's
 * `isEntryCoolingDown`) only re-checks a blocked entry reactively, when some
 * OTHER invocation completes and triggers `onInvocationComplete`/`tryAutoExecute`.
 * A thread with nothing else running would never get re-checked once its
 * blocking cat's cooldown actually expires — this periodic sweep is the
 * restart-safe "到点自动续跑" trigger kimi's spec calls for. Redis-persisted
 * cooldown state means a process restart is just "resume scanning", not a lost
 * wake-up.
 *
 * Idempotency: `tryAutoExecute()` re-runs QueueProcessor's own slot-mutex gate
 * (`processingSlots`/`invocationTracker.has`), so calling it redundantly here
 * (e.g. a natural `onInvocationComplete` firing around the same moment) is a
 * safe no-op — same CAS-style guarantee as the rest of the dispatch pipeline,
 * not a new locking mechanism.
 */

export interface CooldownSweepDeps {
  cooldownStore: {
    listActive(): Promise<readonly { catId: string; until: number }[]> | readonly { catId: string; until: number }[];
  };
  invocationQueue: {
    listThreadsWithQueuedEntryForCat(catId: string): string[];
  };
  queueProcessor: {
    tryAutoExecute(threadId: string): Promise<void>;
  };
  log: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface CooldownSweepResult {
  expiredCatCount: number;
  retriedThreadCount: number;
}

export async function sweepExpiredCooldowns(
  deps: CooldownSweepDeps,
  now: number = Date.now(),
): Promise<CooldownSweepResult> {
  const active = await deps.cooldownStore.listActive();
  const expired = active.filter((record) => record.until <= now);
  if (expired.length === 0) return { expiredCatCount: 0, retriedThreadCount: 0 };

  const retriedThreads = new Set<string>();
  for (const record of expired) {
    let threadIds: string[] = [];
    try {
      threadIds = deps.invocationQueue.listThreadsWithQueuedEntryForCat(record.catId);
    } catch (err) {
      deps.log.warn({ err, catId: record.catId }, '[T6 cooldown-sweep] listThreadsWithQueuedEntryForCat failed');
      continue;
    }
    for (const threadId of threadIds) {
      retriedThreads.add(threadId);
      try {
        await deps.queueProcessor.tryAutoExecute(threadId);
      } catch (err) {
        deps.log.warn({ err, threadId, catId: record.catId }, '[T6 cooldown-sweep] tryAutoExecute retry failed');
      }
    }
  }

  if (retriedThreads.size > 0) {
    deps.log.info(
      { expiredCatCount: expired.length, retriedThreadCount: retriedThreads.size },
      '[T6 cooldown-sweep] retried threads after cooldown expiry',
    );
  }
  return { expiredCatCount: expired.length, retriedThreadCount: retriedThreads.size };
}
