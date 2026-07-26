/**
 * F194 §3 step 1.3 / §5.3 / §6 (batch 2-A item 4): shared "system posts a task
 * event message to the main thread" primitive for the auto-admission
 * (work-admission-service.ts) and MCP callback (callback-task-routes.ts) task
 * flows — both bypass the /api/tasks route entirely, so tasks.ts's own local
 * appendTaskSystemNotice/appendTaskUpdateNotices closures never run for them.
 *
 * docs/research/clowder-raft-thread-task-design.md §2 root cause 4: "batch 1
 * only notified the main thread for the unowned/unclaimed case" — this module
 * completes it: a brief one-line notice on task creation (even when owned)
 * and on doing→in_review→done (and other) status transitions.
 *
 * GOTCHA (already bit batch 1 once): any new `systemKind` value must also be
 * added to redis-message-parsers.ts's safeParseExtra whitelist (both spots),
 * or Redis round-trips silently drop it — see MessageStore.ts's `extra.systemKind`
 * type and redis-message-parsers.ts.
 */
import type { TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

const log = createModuleLogger('routes/task-event-notices');

/**
 * New-this-batch systemKind values. 'task_created_unclaimed' already existed
 * (batch 1) and is intentionally out of this union — it keeps its own literal
 * type at the call site in work-admission-service.ts.
 */
export type TaskLifecycleSystemKind =
  | 'task_created'
  | 'task_status_changed'
  | 'task_idle_escalated'
  /** 批次4-B5 (docs/research/raft-r9-ticket-hygiene.md B5.3): active-task downgrade notice. */
  | 'task_progress_attached'
  /** 批次4-B2 分轨超时提醒: gate(猫)轨 24h 私提醒 / human 轨 48h 私提醒 / human 轨 +48h
   *  频道内可见@owner —— 三个非终态提醒级别共用一个 systemKind，级别本身由 eventType/
   *  content 区分（见 ReviewReminderScheduler.ts）。 */
  | 'task_review_reminder'
  /** 批次4-B2 human 轨第三级状态动作: 超时未验收，平台强制把票从 in_review 打回 doing。 */
  | 'task_review_timeout_reverted'
  /** 批次4-B3 失能打标: assignee 状态异常持续 >30 分钟，票被打上"assignee 失能"标。 */
  | 'assignee_incapacitated'
  /** 批次4-B3: assignee 恢复，标记已清除（真空期记录留在 TaskEvent 里，不在此通知里）。 */
  | 'assignee_recovered'
  /** 批次4-B5.5 建票上浮: left in the ORIGINATING branch/discussion thread (not task.threadId —
   *  see `noticeThreadId` below) when an explicit task-creation entry point hoisted the new
   *  task up to the top-level channel it traced up to. */
  | 'task_hoisted_to_channel';

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
/** module-level, process-local: adequate for "don't spam the same transition twice within 5 minutes" — not a durable ledger. */
const recentNoticeAt = new Map<string, number>();

function dedupeGateOpen(key: string, now: number): boolean {
  const last = recentNoticeAt.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  recentNoticeAt.set(key, now);
  if (recentNoticeAt.size > 2000) {
    for (const [k, ts] of recentNoticeAt) {
      if (now - ts >= DEDUPE_WINDOW_MS) recentNoticeAt.delete(k);
    }
  }
  return true;
}

/** Test-only escape hatch — the module-level dedupe map otherwise leaks state across unrelated test cases. */
export function _resetTaskLifecycleNoticeDedupeForTests(): void {
  recentNoticeAt.clear();
}

/** Same "#N" convention as tasks.ts's getTaskLabel / work-admission-service.ts's unclaimedTaskLabel. */
export async function taskLifecycleLabel(
  taskStore: Pick<ITaskStore, 'listByThread'>,
  task: Pick<TaskItem, 'id' | 'threadId'>,
): Promise<string> {
  const tasks = await taskStore.listByThread(task.threadId);
  const index = tasks.findIndex((item) => item.id === task.id);
  return index >= 0 ? `#${index + 1}` : `#${task.id}`;
}

export const TASK_STATUS_LABEL_ZH: Record<TaskItem['status'], string> = {
  todo: '待办',
  doing: '进行中',
  in_review: '待验收',
  done: '已完成',
  blocked: '阻塞',
  failed: '失败',
};

/**
 * Append + broadcast a task-system notice, mirroring the existing
 * task_created_unclaimed shape (source.connector='task-system' + extra.systemKind).
 * Gated by a 5-minute same-task-same-dedupeKey window (design doc §3 step 4
 * anti-spam requirement) — returns `posted: false` when suppressed.
 */
export async function appendTaskLifecycleNotice(params: {
  task: Pick<TaskItem, 'id' | 'threadId'>;
  content: string;
  systemKind: TaskLifecycleSystemKind | 'task_created_unclaimed';
  eventType: string;
  tone?: 'info' | 'success' | 'warning';
  /** Dedupe scope beyond task id, e.g. the target status ("doing", "in_review"). */
  dedupeKey: string;
  /**
   * 批次4-B5.5 建票上浮: post to this thread instead of `task.threadId` — used for the
   * origin-branch receipt ("已在主频道创建任务 #N") when the task itself now lives in the
   * hoisted top-level channel but the notice belongs in the branch that asked. Defaults to
   * `task.threadId` (every pre-B5.5 caller is unaffected).
   */
  noticeThreadId?: string;
  /**
   * Batch 3-A item 2: narrowed to the one method this function actually calls so that
   * callers holding a minimal test-seam interface (e.g. QueueProcessor's SocketManagerLike)
   * can reuse this notice helper without needing a full concrete SocketManager instance.
   */
  deps: { messageStore: IMessageStore; socketManager: Pick<SocketManager, 'broadcastToRoom'> };
}): Promise<{ posted: boolean }> {
  const now = Date.now();
  const targetThreadId = params.noticeThreadId ?? params.task.threadId;
  if (!dedupeGateOpen(`${params.task.id}:${params.systemKind}:${params.dedupeKey}`, now)) {
    return { posted: false };
  }

  const source = {
    connector: 'task-system',
    label: 'Task',
    icon: '📋',
    meta: { presentation: 'system_notice', noticeTone: params.tone ?? 'info', eventType: params.eventType, taskId: params.task.id },
  } as const;

  try {
    const stored = await params.deps.messageStore.append({
      userId: 'system',
      catId: null,
      content: params.content,
      mentions: [],
      timestamp: now,
      threadId: targetThreadId,
      source,
      extra: { systemKind: params.systemKind },
    });
    params.deps.socketManager.broadcastToRoom(`thread:${targetThreadId}`, 'connector_message', {
      threadId: targetThreadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: stored.content,
        source,
        timestamp: stored.timestamp,
      },
    });
    return { posted: true };
  } catch (err) {
    log.warn({ err, taskId: params.task.id, threadId: targetThreadId }, 'Failed to persist task lifecycle notice');
    return { posted: false };
  }
}
