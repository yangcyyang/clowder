import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { InvocationQueue } from '../agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import type { AgentReminderStore } from './AgentReminderStore.js';

interface QueueProcessorLike {
  tryAutoExecute(threadId: string): Promise<void>;
}

interface SocketManagerLike {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export interface AgentReminderSchedulerDeps {
  store: AgentReminderStore;
  messageStore: IMessageStore;
  threadStore: IThreadStore;
  invocationQueue: InvocationQueue;
  queueProcessor: QueueProcessorLike;
  socketManager?: SocketManagerLike;
  log: FastifyBaseLogger;
  intervalMs?: number;
}

const REMINDER_SOURCE: ConnectorSource = {
  connector: 'clowder-reminder',
  label: 'Clowder Reminder',
  icon: '⏰',
  meta: { presentation: 'system_notice' },
};

export function startAgentReminderScheduler(deps: AgentReminderSchedulerDeps): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await deps.store.due();
      for (const reminder of due) {
        let releaseMutation = () => {};
        try {
          const mutationGuard = deps.invocationQueue.guardCallbackMutation(reminder.threadId);
          if (!mutationGuard.acquired) continue;
          releaseMutation = mutationGuard.release;
          const thread = await deps.threadStore.get(reminder.threadId);
          const userId = thread?.createdBy ?? 'system';
          const content = `⏰ 提醒到期：${reminder.message}\n\n目标 Agent：@${reminder.catId}`;
          const enqueueResult = deps.invocationQueue.enqueue({
            threadId: reminder.threadId,
            userId,
            content: `提醒到期，请处理：${reminder.message}`,
            source: 'agent',
            targetCats: [reminder.catId],
            intent: 'execute',
            autoExecute: true,
            sourceCategory: 'scheduled',
            idempotencyKey: `reminder:${reminder.id}`,
          });
          // 票B B2: only mark fired when the invocation was actually queued.
          // On 'resetting' (the live false-fire path) nothing was enqueued —
          // leave the reminder scheduled so the next tick retries it. The
          // thread message append moved inside this branch: it is trivially
          // safe (no ordering dependency) and prevents one duplicate
          // "提醒到期" message per retry tick while the queue keeps resetting.
          if (enqueueResult.outcome === 'enqueued') {
            const stored = await deps.messageStore.append({
              userId: 'system',
              catId: null,
              threadId: reminder.threadId,
              content,
              mentions: [reminder.catId as CatId],
              timestamp: Date.now(),
              source: REMINDER_SOURCE,
            });

            deps.socketManager?.broadcastToRoom(`thread:${reminder.threadId}`, 'connector_message', {
              threadId: reminder.threadId,
              message: {
                id: stored.id,
                type: 'connector',
                content: stored.content,
                source: REMINDER_SOURCE,
                timestamp: stored.timestamp,
              },
            });

            await deps.queueProcessor.tryAutoExecute(reminder.threadId);
            await deps.store.markFired(reminder.id);
          } else {
            deps.log.warn(
              { reminderId: reminder.id, threadId: reminder.threadId, outcome: enqueueResult.outcome },
              '[reminder] enqueue did not succeed; leaving reminder scheduled for next tick',
            );
          }
        } catch (err) {
          deps.log.warn({ err, reminderId: reminder.id }, '[reminder] failed to fire reminder');
        } finally {
          releaseMutation();
        }
      }
    } catch (err) {
      deps.log.warn({ err }, '[reminder] scheduler tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000);
  void tick();
  return () => clearInterval(timer);
}
