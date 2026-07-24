import type { CatId, TaskEvent, TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';
import { redactSecretsInText } from '../utils/env-var-secret-guard.js';
import type { WorkAdmissionDecision } from './work-admission.js';

const log = createModuleLogger('routes/work-admission-service');

export interface ExecutionRouteV1 {
  version: 1;
  sourceThreadId: string;
  rootMessageId: string;
  replyTargetThreadId: string;
  executionMessageId: string;
  mode: 'task_thread' | 'explicit_cross_thread';
  taskId?: string;
  ownerCatId?: CatId;
}

export interface WorkAdmissionResult {
  route: ExecutionRouteV1;
  task: TaskItem;
  created: boolean;
}

export interface WorkAdmissionDeps {
  taskStore: ITaskStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

export function isAutoTaskThreadRoutingEnabled(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOWDER_AUTO_TASK_THREAD_ROUTING === 'true') return true;
  return (env.CLOWDER_AUTO_TASK_THREAD_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(threadId);
}

function initialClaimEvents(ownerCatId: CatId | undefined, timestamp: number): readonly TaskEvent[] | undefined {
  if (!ownerCatId) return undefined;
  const ts = new Date(timestamp).toISOString();
  return [
    { ts, catId: ownerCatId, type: 'claimed', data: { from: null, to: ownerCatId } },
    { ts, catId: ownerCatId, type: 'status_changed', data: { from: 'todo', to: 'doing' } },
  ];
}

function taskTitleForSource(sourceMessage: StoredMessage, classifiedTitle: string): string {
  // Task metadata is injected into every cat's navigation context. An
  // unrevealed whisper body therefore cannot be reused as the task title even
  // though the source copy itself is protected by canViewMessage().
  if (sourceMessage.visibility === 'whisper' && !sourceMessage.revealedAt) return '私密工作指令';
  // Defense-in-depth: classified path already redacts; re-apply for resume_pending_plan titles.
  return redactSecretsInText(classifiedTitle);
}

const UNCLAIMED_NOTICE_TITLE_MAX = 60;

function truncateTaskTitleForNotice(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > UNCLAIMED_NOTICE_TITLE_MAX ? `${trimmed.slice(0, UNCLAIMED_NOTICE_TITLE_MAX - 1)}…` : trimmed;
}

/** Same "#N" convention as tasks.ts's getTaskLabel — 1-based position among non-pr_tracking tasks in the thread. */
async function unclaimedTaskLabel(taskStore: ITaskStore, task: TaskItem): Promise<string> {
  const tasks = (await taskStore.listByThread(task.threadId)).filter((item) => item.kind !== 'pr_tracking');
  const index = tasks.findIndex((item) => item.id === task.id);
  return index >= 0 ? `#${index + 1}` : `#${task.id}`;
}

/**
 * F194 可见性修复 (§2 root cause 3): create_from_message without a unique @mention
 * previously left a todo task with zero trace in the main thread — the 202 response
 * was the only signal, and only to the original HTTP caller. Post a normal, socket-visible
 * system notice so "谁来认领" is answered without opening the Tasks tab.
 *
 * Mirrors the existing system-notice append shape (persistA2ARoutingMessage /
 * persistA2APendingNotice): userId:'system', catId:null, + connector_message broadcast.
 */
async function persistUnclaimedTaskNotice(task: TaskItem, deps: WorkAdmissionDeps): Promise<void> {
  const label = await unclaimedTaskLabel(deps.taskStore, task);
  const content = `已创建任务 ${label}：${truncateTaskTitleForNotice(task.title)}（待认领）`;
  const source = {
    connector: 'task-system',
    label: 'Task',
    icon: '📋',
    meta: { presentation: 'system_notice', noticeTone: 'info', eventType: 'task_created_unclaimed', taskId: task.id },
  } as const;
  try {
    const stored = await deps.messageStore.append({
      userId: 'system',
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId: task.threadId,
      source,
      extra: { systemKind: 'task_created_unclaimed' },
    });
    deps.socketManager.broadcastToRoom(`thread:${task.threadId}`, 'connector_message', {
      threadId: task.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: stored.content,
        source,
        timestamp: stored.timestamp,
      },
    });
  } catch (err) {
    log.warn({ err, taskId: task.id, threadId: task.threadId }, 'Failed to persist unclaimed task notice');
  }
}

export async function admitWorkMessage(input: {
  decision: Exclude<WorkAdmissionDecision, { kind: 'reply_only' }>;
  sourceMessage: StoredMessage;
  userId: string;
  deps: WorkAdmissionDeps;
}): Promise<WorkAdmissionResult> {
  const { decision, sourceMessage, userId, deps } = input;
  const ownerCatId = decision.ownerCatId;
  const now = Date.now();
  const subjectKey = `work-intake:${sourceMessage.threadId}:${sourceMessage.id}`;
  const task = await deps.taskStore.upsertBySubject({
    kind: 'work',
    threadId: sourceMessage.threadId,
    subjectKey,
    title: taskTitleForSource(sourceMessage, decision.taskTitle),
    why:
      decision.kind === 'resume_pending_plan'
        ? `用户批准挂起方案 ${decision.pendingPlanMessageId}`
        : `来自明确工作指令 ${sourceMessage.id}`,
    createdBy: 'user',
    userId,
    sourceMessageId: sourceMessage.id,
    ...(ownerCatId ? { ownerCatId, status: 'doing', events: initialClaimEvents(ownerCatId, now) } : {}),
  });

  const discussion = await ensureTaskDiscussionThread(
    task,
    {
      taskStore: deps.taskStore,
      threadStore: deps.threadStore,
      messageStore: deps.messageStore,
      socketManager: deps.socketManager,
    },
    { userId, broadcastUpdate: false },
  );

  if (discussion.created) {
    deps.socketManager.broadcastToRoom(`thread:${discussion.task.threadId}`, 'task_created', discussion.task);
    deps.socketManager.broadcastToRoom(`thread:${discussion.task.threadId}`, 'thread_branched', {
      sourceThreadId: discussion.task.threadId,
      newThreadId: discussion.threadId,
      fromMessageId: sourceMessage.id,
    });
    // §2 root cause 3: no unique @mention → no owner → the task would otherwise
    // sit silently in the Tasks tab with zero trace in the main thread.
    if (!ownerCatId) {
      await persistUnclaimedTaskNotice(discussion.task, deps);
    }
  }

  return {
    task: discussion.task,
    created: discussion.created,
    route: {
      version: 1,
      sourceThreadId: sourceMessage.threadId,
      rootMessageId: sourceMessage.id,
      replyTargetThreadId: discussion.threadId,
      executionMessageId: discussion.sourceMessage.id,
      mode: 'task_thread',
      taskId: discussion.task.id,
      ...(ownerCatId ? { ownerCatId } : {}),
    },
  };
}
