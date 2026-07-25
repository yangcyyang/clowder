/**
 * F048 Phase A + A+: StartupReconciler
 *
 * On API startup, sweeps Redis for orphaned invocation records
 * left by a crashed/restarted process. Converges:
 * - running → failed(error=process_restart) or requeued recovery
 * - stale queued (> 5min) → failed(error=process_restart)
 * Also clears associated TaskProgress snapshots.
 *
 * Phase A+: Posts visible error messages to affected threads
 * so users know their request was interrupted.
 * (Intake from community PR #78 / Issue #77, with source field fix.)
 */

import { randomUUID } from 'node:crypto';
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { IInvocationRecordStore, InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import { buildTerminalEvent } from '../../stores/ports/invocation-terminal-event.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

/** Terminal Invariant (batch 3-B): explicit termination fact for the
 *  process_restart convergence path, so a reconciled orphan record carries
 *  the same auditable evidence as any other terminal transition instead of
 *  falling back to the store's legacy-implicit synthesis. */
const RECONCILER_TERMINAL_SOURCE = 'startup-reconciler';

export interface StartupSweepResult {
  swept: number;
  running: number;
  queued: number;
  /** Running invocations recovered by requeueing the original user message. */
  requeued: number;
  taskProgressCleared: number;
  /** Queued user messages made visible after orphan sweep. */
  messagesRecovered: number;
  notifiedThreads: number;
  durationMs: number;
}

interface ReconcilerLog {
  info(msg: string): void;
  warn(msg: string): void;
}

interface MessageAppender {
  append(msg: AppendMessageInput): unknown;
  /** Read the original user message so a crashed running invocation can be requeued. */
  getById?(id: string): { content: string } | null | Promise<{ content: string } | null>;
  /** Recent thread messages, used only to suppress duplicate restart notices. */
  getByThread?(
    threadId: string,
    limit?: number,
    userId?: string,
  ):
    | Array<{
        id?: string;
        content?: string;
        timestamp?: number;
        catId?: CatId | string | null;
        source?: ConnectorSource;
      }>
    | Promise<
        Array<{
          id?: string;
          content?: string;
          timestamp?: number;
          catId?: CatId | string | null;
          source?: ConnectorSource;
        }>
      >;
  /** Mark a queued message as delivered (make visible in timeline). */
  markDelivered?(id: string, deliveredAt: number): unknown;
}

interface ConnectorMessageBroadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

interface RecoveryQueue {
  enqueue(input: {
    threadId: string;
    userId: string;
    content: string;
    source: 'user' | 'agent';
    sourceCategory?: 'a2a';
    targetCats: CatId[];
    intent: InvocationRecord['intent'];
    idempotencyKey: string;
    autoExecute: true;
    priority: 'urgent';
    callerCatId?: CatId;
    a2aTriggerMessageId?: string;
  }): { outcome: 'enqueued' | 'full' | 'resetting'; entry?: { id: string }; deduped?: boolean };
  backfillMessageId?(threadId: string, userId: string, entryId: string, messageId: string): void;
}

interface RecoveryQueueProcessor {
  tryAutoExecute(threadId: string): Promise<void>;
}

const RECONCILER_SOURCE: ConnectorSource = {
  connector: 'startup-reconciler',
  label: '重启通知',
  icon: '⚠️',
  meta: { presentation: 'system_notice', noticeTone: 'warning' },
};

const RESTART_NOTICE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface StartupReconcilerDeps {
  invocationRecordStore: IInvocationRecordStore;
  taskProgressStore: TaskProgressStore;
  log: ReconcilerLog;
  /** Only sweep records created before this timestamp (prevents sweeping new invocations from current process). */
  processStartAt?: number;
  /** Phase A+: Optional — post visible error messages to affected threads. */
  messageStore?: MessageAppender;
  /** Phase A+: Optional — push real-time WebSocket notification to frontend. */
  socketManager?: ConnectorMessageBroadcaster;
  /** Slock-like recovery: requeue pre-restart running invocations instead of only failing them. */
  invocationQueue?: RecoveryQueue;
  queueProcessor?: RecoveryQueueProcessor;
}

type ScanStore = IInvocationRecordStore & { scanByStatus(status: string): Promise<string[]> };
type AffectedThread = { catIds: CatId[]; userId: string; requeued: number };
type RequeueDecision = 'requeued' | 'already_answered' | 'skipped';

const STALE_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;

export class StartupReconciler {
  private readonly deps: StartupReconcilerDeps;

  constructor(deps: StartupReconcilerDeps) {
    this.deps = deps;
  }

  async reconcileOrphans(): Promise<StartupSweepResult> {
    const start = Date.now();
    const store = this.deps.invocationRecordStore;

    // biome-ignore lint/complexity/useLiteralKeys: TS index signature requires bracket access
    if (!('scanByStatus' in store) || typeof (store as Record<string, unknown>)['scanByStatus'] !== 'function') {
      this.deps.log.info('[startup-reconciler] Memory mode — no orphans to sweep');
      return {
        swept: 0,
        running: 0,
        queued: 0,
        requeued: 0,
        taskProgressCleared: 0,
        messagesRecovered: 0,
        notifiedThreads: 0,
        durationMs: Date.now() - start,
      };
    }

    const scanStore = store as ScanStore;
    const affectedThreads = new Map<string, AffectedThread>();
    const runResult = await this.sweepRunning(scanStore, this.deps.processStartAt, affectedThreads);
    const queueResult = await this.sweepStaleQueued(scanStore, affectedThreads);

    const notifiedThreads = await this.notifyAffectedThreads(affectedThreads);

    const running = runResult.running;
    const queued = queueResult.queued;
    const requeued = runResult.requeued;
    const taskProgressCleared = runResult.taskProgressCleared;
    const messagesRecovered = runResult.messagesRecovered + queueResult.messagesRecovered;
    const swept = running + queued;
    const durationMs = Date.now() - start;
    this.deps.log.info(
      `[startup-reconciler] Sweep complete: ${swept} orphans (${running} running, ${queued} stale queued), ` +
        `${requeued} requeued, ${taskProgressCleared} task-progress cleared, ${messagesRecovered} messages recovered, ` +
        `${notifiedThreads} threads notified, ${durationMs}ms`,
    );
    return { swept, running, queued, requeued, taskProgressCleared, messagesRecovered, notifiedThreads, durationMs };
  }

  private async sweepRunning(
    store: ScanStore,
    cutoff: number | undefined,
    affectedThreads: Map<string, AffectedThread>,
  ): Promise<{ running: number; requeued: number; taskProgressCleared: number; messagesRecovered: number }> {
    let running = 0;
    let requeued = 0;
    let taskProgressCleared = 0;
    let messagesRecovered = 0;

    const ids = await store.scanByStatus('running');
    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record) continue;
        if (cutoff && record.createdAt >= cutoff) continue;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'running',
          error: 'process_restart',
          terminalEvent: buildTerminalEvent('process_restart', RECONCILER_TERMINAL_SOURCE, { previousStatus: 'running' }),
        });
        if (updated) {
          running++;
          const requeueDecision = await this.tryRequeueRunningInvocation(record);
          const wasRequeued = requeueDecision === 'requeued';
          if (wasRequeued) {
            requeued++;
            await store.update(id, { error: 'process_restart_requeued' });
          }
          if (requeueDecision !== 'already_answered') {
            this.trackAffectedThread(affectedThreads, record, wasRequeued);
          }
          taskProgressCleared += await this.clearTaskProgress(record.threadId, record.targetCats);
          // Safe: markDelivered is a no-op for non-queued messages (undefined/delivered/canceled),
          // so already-visible messages won't be re-scored. Only catches the edge case where
          // process crashed between invocation→running and markDelivered.
          if (await this.ensureMessageVisible(record)) messagesRecovered++;
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep running invocation ${id}: ${String(err)}`);
      }
    }
    return { running, requeued, taskProgressCleared, messagesRecovered };
  }

  private async sweepStaleQueued(
    store: ScanStore,
    affectedThreads: Map<string, AffectedThread>,
  ): Promise<{ queued: number; messagesRecovered: number }> {
    let queued = 0;
    let messagesRecovered = 0;
    const ids = await store.scanByStatus('queued');
    const staleThreshold = Date.now() - STALE_QUEUED_THRESHOLD_MS;

    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record || record.createdAt > staleThreshold) continue;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'queued',
          error: 'process_restart',
          terminalEvent: buildTerminalEvent('process_restart', RECONCILER_TERMINAL_SOURCE, { previousStatus: 'queued' }),
        });
        if (updated) {
          queued++;
          this.trackAffectedThread(affectedThreads, record, false);
          if (await this.ensureMessageVisible(record)) messagesRecovered++;
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep queued invocation ${id}: ${String(err)}`);
      }
    }
    return { queued, messagesRecovered };
  }

  private trackAffectedThread(map: Map<string, AffectedThread>, record: InvocationRecord, requeued: boolean): void {
    const existing = map.get(record.threadId) ?? { catIds: [], userId: record.userId, requeued: 0 };
    for (const catId of record.targetCats) {
      if (!existing.catIds.includes(catId)) existing.catIds.push(catId);
    }
    if (requeued) existing.requeued++;
    map.set(record.threadId, existing);
  }

  private async notifyAffectedThreads(affectedThreads: Map<string, AffectedThread>): Promise<number> {
    if (affectedThreads.size === 0) return 0;
    const { messageStore, socketManager } = this.deps;
    if (!messageStore && !socketManager) return 0;

    let notified = 0;
    for (const [threadId, { catIds, userId, requeued }] of affectedThreads) {
      const catLabel = catIds.length === 1 ? catIds[0] : `${catIds.length} cats`;
      const content =
        requeued > 0
          ? `运行服务已恢复，已自动接续 ${catLabel} 的 ${requeued} 个进行中请求；已发送的消息会保留。`
          : `运行服务已恢复，${catLabel} 的进行中请求已中断；已发送的消息会保留，若存在流式草稿会自动恢复到对话中。`;
      if (await this.hasRecentDuplicateNotice(threadId, content)) continue;
      const fallbackId = `startup-reconciler-${threadId}-${randomUUID().slice(0, 8)}`;
      let messageId = fallbackId;
      let timestamp = Date.now();

      let persisted = false;
      let broadcasted = false;
      if (messageStore) {
        try {
          const stored = await messageStore.append({
            threadId,
            userId,
            catId: null,
            content,
            mentions: [],
            source: RECONCILER_SOURCE,
            timestamp,
          });
          if (stored && typeof stored === 'object') {
            const maybeStored = stored as { id?: unknown; timestamp?: unknown };
            if (typeof maybeStored.id === 'string') messageId = maybeStored.id;
            if (typeof maybeStored.timestamp === 'number') timestamp = maybeStored.timestamp;
          }
          persisted = true;
        } catch (err) {
          this.deps.log.warn(
            `[startup-reconciler] Failed to persist notification for thread ${threadId}: ${String(err)}`,
          );
        }
      }

      if (socketManager) {
        try {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
            threadId,
            message: {
              id: messageId,
              type: 'connector' as const,
              content,
              source: RECONCILER_SOURCE,
              timestamp,
            },
          });
          broadcasted = true;
        } catch (err) {
          this.deps.log.warn(
            `[startup-reconciler] Failed to broadcast notification for thread ${threadId}: ${String(err)}`,
          );
        }
      }

      if (persisted || broadcasted) notified++;
    }
    return notified;
  }

  private async hasRecentDuplicateNotice(threadId: string, content: string): Promise<boolean> {
    const getByThread = this.deps.messageStore?.getByThread;
    if (!getByThread) return false;

    try {
      const recent = await getByThread.call(this.deps.messageStore, threadId, 20);
      const cutoff = Date.now() - RESTART_NOTICE_DEDUPE_WINDOW_MS;
      return recent.some((msg) => {
        if (msg.source?.connector !== RECONCILER_SOURCE.connector) return false;
        if (msg.content !== content) return false;
        return typeof msg.timestamp !== 'number' || msg.timestamp >= cutoff;
      });
    } catch (err) {
      this.deps.log.warn(`[startup-reconciler] Failed to inspect recent notifications: ${String(err)}`);
      return false;
    }
  }

  private async tryRequeueRunningInvocation(record: InvocationRecord): Promise<RequeueDecision> {
    const { invocationQueue, queueProcessor, messageStore } = this.deps;
    if (!invocationQueue || !queueProcessor || !messageStore?.getById || !record.userMessageId) return 'skipped';

    try {
      const userMessage = await messageStore.getById(record.userMessageId);
      if (!userMessage) return 'skipped';
      if (await this.hasTargetReplyAfterUserMessage(record)) return 'already_answered';

      const result = invocationQueue.enqueue({
        threadId: record.threadId,
        userId: record.userId,
        content: userMessage.content ?? '',
        source: record.callerCatId ? 'agent' : 'user',
        ...(record.callerCatId ? { sourceCategory: 'a2a' as const } : {}),
        targetCats: record.targetCats,
        intent: record.intent,
        idempotencyKey: `restart-requeue:${record.id}`,
        autoExecute: true,
        priority: 'urgent',
        ...(record.callerCatId ? { callerCatId: record.callerCatId } : {}),
        ...(record.a2aTriggerMessageId ? { a2aTriggerMessageId: record.a2aTriggerMessageId } : {}),
      });
      if (result.outcome !== 'enqueued' || !result.entry) return 'skipped';

      invocationQueue.backfillMessageId?.(record.threadId, record.userId, result.entry.id, record.userMessageId);
      await queueProcessor.tryAutoExecute(record.threadId);
      return 'requeued';
    } catch (err) {
      this.deps.log.warn(`[startup-reconciler] Failed to requeue running invocation ${record.id}: ${String(err)}`);
      return 'skipped';
    }
  }

  private async hasTargetReplyAfterUserMessage(record: InvocationRecord): Promise<boolean> {
    const getByThread = this.deps.messageStore?.getByThread;
    if (!getByThread || !record.userMessageId) return false;
    try {
      const recent = await getByThread.call(this.deps.messageStore, record.threadId, 200);
      const sourceIndex = recent.findIndex((msg) => msg.id === record.userMessageId);
      if (sourceIndex < 0) return false;
      const targetCats = new Set(record.targetCats);
      return recent.slice(sourceIndex + 1).some((msg) => {
        if (!msg.catId || !targetCats.has(msg.catId as CatId)) return false;
        return Boolean(msg.content?.trim());
      });
    } catch (err) {
      this.deps.log.warn(
        `[startup-reconciler] Failed to inspect completed replies for invocation ${record.id}: ${String(err)}`,
      );
      return false;
    }
  }

  private async clearTaskProgress(threadId: string, targetCats: CatId[]): Promise<number> {
    let cleared = 0;
    for (const catId of targetCats) {
      try {
        await this.deps.taskProgressStore.deleteSnapshot(threadId, catId);
        cleared++;
      } catch {
        /* best-effort */
      }
    }
    return cleared;
  }

  /**
   * P1-C: Make queued user messages visible after orphan invocation sweep.
   * Without this, messages with deliveryStatus='queued' stay invisible in timeline/context
   * after a process_restart, because markDelivered() was never called.
   */
  private async ensureMessageVisible(record: InvocationRecord): Promise<boolean> {
    const { messageStore } = this.deps;
    if (!messageStore?.markDelivered || !record.userMessageId) return false;
    try {
      const result = await messageStore.markDelivered(record.userMessageId, Date.now());
      return result != null;
    } catch (err) {
      this.deps.log.warn(
        `[startup-reconciler] Failed to recover message ${record.userMessageId} for invocation ${record.id}: ${String(err)}`,
      );
      return false;
    }
  }
}
