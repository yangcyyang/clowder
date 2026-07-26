/**
 * AutoRetryScheduler — batch 3-B, item 3: whitelisted automatic retry.
 *
 * Gated by env `CLOWDER_AUTO_RETRY` (default OFF — see src/config/env-registry.ts).
 * When enabled, periodically scans terminal `failed` InvocationRecords and
 * automatically retries the ones whose Terminal Invariant classification
 * (batch 3-B item 1 + 2) is in the whitelist {transient_network, cli_crash}.
 * quota / aborted / agent_error / context_overflow are NEVER auto-retried —
 * those require a human decision (budget, explicit cancel, a real bug, or a
 * prompt that's just too big to shrink automatically).
 *
 * Reuses the existing failed→running CAS transition (invocation-state-machine.ts)
 * — the same guard the manual POST /api/invocations/:id/retry endpoint relies
 * on — so a manual retry and an auto-retry attempt can never both win: only
 * one CAS claim succeeds, the other observes `null` and backs off.
 *
 * Polling design (not event-driven): most terminal `failed` transitions for
 * ordinary (non-retry) invocations happen inside QueueProcessor.ts, which is
 * out of this batch's edit scope (parallel batch 3-A owns it — see report).
 * A periodic scan lets this feature observe those records without touching
 * that file, mirroring the existing StartupReconciler.ts scan pattern.
 *
 * batch 4-A (F070 addendum — 07-26 governance-interception storm root-cause fix):
 * a governance-gate block (errorCode PROJECT_PERMISSION_DENIED /
 * GOVERNANCE_BOOTSTRAP_REQUIRED, see invoke-single-cat.ts) now classifies as the
 * dedicated `permission_denied` kind (provider-error-classification.ts) instead of
 * falling through to `agent_error` by accident. Both are outside
 * AUTO_RETRY_WHITELIST, so this was already a no-op in practice — but the accidental
 * safety depended on no regex happening to match the literal errorCode text. This
 * scheduler's OWN retry-completion path (runClaimedRetry, below) now tags a
 * re-encountered governance block with the explicit `permission_denied` terminalEvent
 * kind rather than `agent_error`, so classification is structurally guaranteed rather
 * than incidental. Investigation note (see batch report for full evidence): the
 * production storm's actual re-dispatch driver was ClaimedIdleScheduler re-sending its
 * idle nudge every ~60s scan (pre-fix nudge-count persistence bug, batch 4-C's C1) —
 * NOT this scheduler, which was never enabled in production during that window
 * (CLOWDER_AUTO_RETRY defaults off). This fix is defense-in-depth: it guarantees that
 * *no* current or future consumer of InvocationRecord classification (this scheduler,
 * or anything built on top of it later) can ever treat a permission block as
 * retry-eligible, regardless of which mechanism re-triggers dispatch.
 */

import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { AgentMessage, TokenUsage } from '../../types.js';
import { mergeTokenUsage } from '../../types.js';
import { parseIntent } from '../../context/IntentParser.js';
import type { PersistenceContext } from '../routing/route-helpers.js';
import type {
  IInvocationRecordStore,
  InvocationRecord,
  InvocationStatus,
} from '../../stores/ports/InvocationRecordStore.js';
import { buildTerminalEvent } from '../../stores/ports/invocation-terminal-event.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { classifyProviderErrorText, isAutoRetryEligible } from './provider-error-classification.js';

const log = createModuleLogger('AutoRetryScheduler');

const TERMINAL_SOURCE = 'AutoRetryScheduler';

/** Backoff schedule: 1st auto-retry waits 30s after the failure, 2nd waits 120s. Hard cap: 2 attempts per run. */
const BACKOFF_SCHEDULE_MS = [30_000, 120_000] as const;
export const MAX_AUTO_RETRIES = BACKOFF_SCHEDULE_MS.length;

/** Default scan cadence — deliberately short relative to the 30s first-tier backoff so a due retry isn't left waiting much past its window. */
const DEFAULT_SCAN_INTERVAL_MS = 15_000;

export function isAutoRetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CLOWDER_AUTO_RETRY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/** Minimal structural dependencies — deliberately duck-typed (not the concrete classes) so tests can supply lightweight fakes, matching StartupReconciler's test style. */
export interface AutoRetryRouterLike {
  routeExecution(
    userId: string,
    content: string,
    threadId: string,
    userMessageId: string,
    targetCats: CatId[],
    intent: ReturnType<typeof parseIntent>,
    options: Record<string, unknown>,
  ): AsyncIterable<AgentMessage>;
  ackCollectedCursors(userId: string, threadId: string, boundaries: Map<string, string>): Promise<void>;
}

export interface AutoRetrySocketManagerLike {
  broadcastAgentMessage(msg: AgentMessage, threadId: string): void;
}

export interface AutoRetryInvocationTrackerLike {
  isDeleting(threadId: string): boolean;
  startAll(threadId: string, catIds: string[], userId: string): AbortController;
  completeSlot(threadId: string, catId: string, controller?: AbortController): void;
  completeAll(threadId: string, catIds: string[], controller?: AbortController): void;
}

export interface AutoRetryQueueProcessorLike {
  onInvocationComplete(
    threadId: string,
    catId: string,
    status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
  ): Promise<void>;
  hasQueuedUserMessagesForThread?(threadId: string): boolean;
  hasActiveOrQueuedAgentForCat?(threadId: string, catId: string): boolean;
}

type ScanStore = IInvocationRecordStore & { scanByStatus(status: InvocationStatus): Promise<string[]> };

export interface AutoRetrySchedulerDeps {
  invocationRecordStore: IInvocationRecordStore;
  messageStore: IMessageStore;
  router: AutoRetryRouterLike;
  socketManager: AutoRetrySocketManagerLike;
  invocationTracker: AutoRetryInvocationTrackerLike;
  queueProcessor?: AutoRetryQueueProcessorLike;
  uploadDir?: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable env lookup for tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  scanIntervalMs?: number;
}

export class AutoRetryScheduler {
  private readonly deps: AutoRetrySchedulerDeps;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks if a scan takes longer than the interval. */
  private ticking = false;

  constructor(deps: AutoRetrySchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`[auto-retry-scheduler] tick failed (best-effort): ${String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan pass. Exposed for tests — production code should use start()/stop(). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (!isAutoRetryEnabled(this.deps.env)) return;

    const store = this.deps.invocationRecordStore;
    if (!('scanByStatus' in store) || typeof (store as Record<string, unknown>).scanByStatus !== 'function') {
      // Memory mode — no cross-process scan surface, mirrors StartupReconciler's guard.
      return;
    }

    this.ticking = true;
    try {
      const scanStore = store as ScanStore;
      const ids = await scanStore.scanByStatus('failed');
      for (const id of ids) {
        try {
          await this.maybeRetry(id);
        } catch (err) {
          log.warn(`[auto-retry-scheduler] failed to evaluate invocation ${id}: ${String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeRetry(id: string): Promise<void> {
    const store = this.deps.invocationRecordStore;
    const record = await store.get(id);
    if (!record || record.status !== 'failed') return;

    const retryCount = record.autoRetryCount ?? 0;
    if (retryCount >= MAX_AUTO_RETRIES) return;

    const classificationKind = record.terminalEvent
      ? record.terminalEvent.kind
      : classifyProviderErrorText(record.error ?? '').kind;
    // Cast is safe: isAutoRetryEligible only ever returns true for the two
    // ProviderErrorClassificationKind values in AUTO_RETRY_WHITELIST — any
    // other TerminalEventKind (succeeded/canceled_*/process_restart/
    // missing_terminal_event) falls through to false.
    if (!isAutoRetryEligible(classificationKind as Parameters<typeof isAutoRetryEligible>[0])) return;

    const backoffMs = BACKOFF_SCHEDULE_MS[retryCount] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!;
    if (this.now() - record.updatedAt < backoffMs) return;

    if (record.userMessageId === null) return;
    if (this.deps.invocationTracker.isDeleting(record.threadId)) return;

    const claimed = await store.update(id, {
      status: 'running',
      phase: 'context_building',
      error: '',
      expectedStatus: 'failed',
      autoRetryCount: retryCount + 1,
    });
    if (!claimed) return; // lost the race — manual retry or another tick already claimed it

    const storedMessage = await this.deps.messageStore.getById(record.userMessageId);
    if (!storedMessage) {
      await store.update(id, {
        status: 'failed',
        expectedStatus: 'running',
        error: 'user_message_expired',
        terminalEvent: buildTerminalEvent('agent_error', TERMINAL_SOURCE, { reason: 'user_message_expired' }),
      });
      return;
    }

    const intent = parseIntent(storedMessage.content, record.targetCats.length);
    const controller = this.deps.invocationTracker.startAll(record.threadId, record.targetCats, record.userId);
    if (controller.signal.aborted) {
      await store.update(id, {
        status: 'canceled',
        expectedStatus: 'running',
        terminalEvent: buildTerminalEvent('canceled_system', TERMINAL_SOURCE, { reason: 'thread_deleting' }),
      });
      this.deps.invocationTracker.completeAll(record.threadId, record.targetCats, controller);
      return;
    }

    // Fire-and-forget: don't block the scan loop on full execution.
    void this.runClaimedRetry(id, record, storedMessage.content, intent, controller);
  }

  private async runClaimedRetry(
    id: string,
    record: InvocationRecord,
    userMessageContent: string,
    intent: ReturnType<typeof parseIntent>,
    controller: AbortController,
  ): Promise<void> {
    const { invocationRecordStore, router, socketManager, invocationTracker, queueProcessor } = this.deps;
    let finalStatus: 'succeeded' | 'failed' | 'canceled' = 'failed';

    try {
      const cursorBoundaries = new Map<string, string>();
      const persistenceContext: PersistenceContext = { failed: false, errors: [] };
      let governanceErrorCode: string | undefined;
      const pendingProviderErrors = new Map<string, string>();
      const collectedUsage = new Map<string, TokenUsage>();

      for await (const msg of router.routeExecution(
        record.userId,
        userMessageContent,
        record.threadId,
        record.userMessageId!,
        record.targetCats,
        intent,
        {
          uploadDir: this.deps.uploadDir,
          signal: controller.signal,
          ...(queueProcessor
            ? {
                queueHasQueuedMessages: (tid: string) => queueProcessor.hasQueuedUserMessagesForThread?.(tid) ?? false,
                hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
                  queueProcessor.hasActiveOrQueuedAgentForCat?.(tid, catId) ?? false,
              }
            : {}),
          cursorBoundaries,
          persistenceContext,
          parentInvocationId: id,
        },
      )) {
        if (msg.type === 'done' && msg.errorCode) governanceErrorCode = msg.errorCode;
        if (msg.type === 'error' && msg.catId) {
          pendingProviderErrors.set(msg.catId, msg.error?.trim() || 'Provider error');
        }
        if (msg.type === 'text' && msg.catId && msg.content?.trim()) {
          pendingProviderErrors.delete(msg.catId);
        }
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId && msg.metadata?.usage) {
          collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), msg.metadata.usage));
        }
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
          invocationTracker.completeSlot(record.threadId, msg.catId, controller);
        }
        socketManager.broadcastAgentMessage({ ...msg, invocationId: id }, record.threadId);
      }

      const usageFields = collectedUsage.size > 0 ? { usageByCat: Object.fromEntries(collectedUsage) } : {};

      if (controller.signal.aborted) {
        await invocationRecordStore.update(id, {
          status: 'canceled',
          phase: 'done',
          terminalEvent: buildTerminalEvent('canceled_system', TERMINAL_SOURCE, {}),
          ...usageFields,
        });
        finalStatus = 'canceled';
      } else if (persistenceContext.failed) {
        const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
        await invocationRecordStore.update(id, {
          status: 'failed',
          phase: 'done',
          error: `Message delivered but persistence failed: ${errorDetail}`,
          terminalEvent: buildTerminalEvent('agent_error', TERMINAL_SOURCE, {
            reason: 'message_persistence_failed',
            persistenceErrors: persistenceContext.errors,
          }),
          ...usageFields,
        });
      } else if (governanceErrorCode) {
        await invocationRecordStore.update(id, {
          status: 'failed',
          phase: 'done',
          error: governanceErrorCode,
          // batch 4-A (F070 addendum): explicit permission_denied, not agent_error —
          // this is a governance/OS block, never auto-retry-eligible (see module doc).
          terminalEvent: buildTerminalEvent('permission_denied', TERMINAL_SOURCE, {
            reason: 'governance_block',
            governanceErrorCode,
          }),
          ...usageFields,
        });
      } else if (pendingProviderErrors.size > 0) {
        // No explicit terminalEvent: let the store derive classification from
        // the joined provider error text (same as routes/invocations.ts).
        await invocationRecordStore.update(id, {
          status: 'failed',
          phase: 'done',
          error: [...pendingProviderErrors.values()].join('\n'),
          ...usageFields,
        });
      } else {
        await router.ackCollectedCursors(record.userId, record.threadId, cursorBoundaries);
        await invocationRecordStore.update(id, {
          status: 'succeeded',
          phase: 'done',
          terminalEvent: buildTerminalEvent('succeeded', TERMINAL_SOURCE, {}),
          ...usageFields,
        });
        finalStatus = 'succeeded';
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, invocationId: id }, '[auto-retry-scheduler] retry execution error');
      await invocationRecordStore.update(id, { status: 'failed', phase: 'done', error: errorMsg });
    } finally {
      invocationTracker.completeAll(record.threadId, record.targetCats, controller);
      if (queueProcessor) {
        const primaryCat = record.targetCats[0];
        if (primaryCat) {
          queueProcessor.onInvocationComplete(record.threadId, primaryCat, finalStatus).catch(() => {
            /* best-effort */
          });
        }
      }
    }
  }
}
