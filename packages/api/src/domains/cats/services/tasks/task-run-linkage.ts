/**
 * Batch 3-A item 2: task↔run 状态联动.
 * docs/research/clowder-raft-thread-task-design.md §5.2 rule 2 ("先认领后干活；认领失败就
 * 走开") — this module is the mirror on the completion side: when a run behind a task
 * reaches a terminal state, the platform records the outcome on the task. It never marks
 * a task done/in_review on the platform's own initiative (Raft: that's the cat's call).
 *
 * Scope note: InvocationRecord (stores/ports/InvocationRecordStore.ts) does not carry a
 * taskId field, and that port file plus invocation-state-machine.ts / providers error
 * paths are being edited concurrently by batch 3-B — this module deliberately avoids
 * touching any of them. Instead it is called from QueueProcessor.executeEntry's `finally`
 * block (see `linkTaskRunOutcome` there), which already resolves the entry's associated
 * task via the same sourceMessageId/taskThreadId lookup used by the existing
 * appendUsageTaskEvents/appendArtifactTaskEvent task-event helpers (findSourceTaskForLedger).
 *
 * Rules:
 * - run failed, failureClass ∈ {timeout, infra_error} → task status → 'blocked'
 * - run failed, other failureClass                    → task status → 'failed'
 * - run succeeded → task status is left untouched regardless of current status (only the
 *   cat itself moves a task to in_review/done); a 'run_succeeded' bookkeeping event is
 *   appended so the ledger has a record, but no chat notice is posted (no status change).
 * - run canceled/canceled_by_user → no-op. Cancellation is often user- or system-initiated
 *   for reasons unrelated to task health (force-send, context reset); v1 leaves this
 *   uninterpreted rather than guessing.
 * - task already 'done' → status transition is skipped (human verdict wins); the failure
 *   is still logged as an event for traceability.
 */
import type { TaskFailureClass, TaskItem, TaskStatus } from '@cat-cafe/shared';
import { redactSecretsInText } from '../../../../utils/env-var-secret-guard.js';
import type { SocketManager } from '../../../../infrastructure/websocket/index.js';
import { appendTaskLifecycleNotice, TASK_STATUS_LABEL_ZH, taskLifecycleLabel } from '../../../../routes/task-event-notices.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import { isLegalTaskStatusTransition } from './task-status-transitions.js';

/** failureClass values that indicate the *platform/runtime* stalled rather than the cat's own work being wrong. */
const BLOCKING_FAILURE_CLASSES: ReadonlySet<TaskFailureClass> = new Set<TaskFailureClass>(['timeout', 'infra_error']);

const FAILURE_CLASS_LABEL_ZH: Record<TaskFailureClass, string> = {
  agent_error: '执行出错',
  build_failed: '构建失败',
  test_failed: '测试失败',
  timeout: '超时',
  budget_exhausted: '额度耗尽',
  infra_error: '基础设施错误',
  manual_fail: '人工标记失败',
};

const MAX_ERROR_TEXT_LEN = 500;

/**
 * Best-effort classifier from a free-text invocation error into the TaskFailureClass enum.
 * Deliberately independent from RunLedgerAssembler's classifyFailure (different target enum,
 * different file — not touched here to stay clear of unrelated concurrent edits).
 *
 * A 包遗留转交 (2026-07-26, 批次4-A 验收报告点名转交给 B 域): this classifier did not
 * recognize the governance-gate errorCodes (PROJECT_PERMISSION_DENIED /
 * GOVERNANCE_BOOTSTRAP_REQUIRED, see invoke-single-cat.ts's governance block) or
 * EPERM/EACCES/"operation not permitted"/"permission denied" wording — a task whose linked
 * run failed because governance intercepted dispatch was therefore classified agent_error →
 * task moved to 'failed' instead of infra_error → 'blocked'. Fixed by adding these to the
 * infra_error tier (same bucket "process/environment problem, not the agent's fault" as the
 * existing spawn/ENOENT/ECONNREFUSED checks below) — mirrors
 * provider-error-classification.ts's PERMISSION_DENIED_TEXT_PATTERN wording exactly, but kept
 * as a literal string-match addition here rather than delegating to that module's
 * classifyProviderErrorText: the two classifiers have different taxonomies (9 kinds mapped
 * through toTaskFailureClass vs this function's 7 direct TaskFailureClass values) and
 * different priority orders, so a wholesale switch would silently reclassify other error
 * texts (e.g. abort-shaped text) beyond the specific gap being closed here.
 */
export function classifyRunFailureForTask(errorText: string | undefined): TaskFailureClass {
  const value = (errorText ?? '').toLowerCase();
  if (value.includes('timeout') || value.includes('timed out') || value.includes('runtime_hung')) return 'timeout';
  if (
    value.includes('project_permission_denied') ||
    value.includes('governance_bootstrap_required') ||
    value.includes('eperm') ||
    value.includes('eacces') ||
    value.includes('operation not permitted') ||
    value.includes('permission denied') ||
    value.includes('spawn') ||
    value.includes('enoent') ||
    value.includes('econnrefused') ||
    value.includes('enotfound') ||
    value.includes('process_restart') ||
    value.includes('runtime_spawn_failed') ||
    value.includes('infra')
  ) {
    return 'infra_error';
  }
  if (value.includes('budget')) return 'budget_exhausted';
  return 'agent_error';
}

export interface TaskRunLinkageDeps {
  taskStore: Pick<ITaskStore, 'update' | 'listByThread'>;
  messageStore: IMessageStore;
  socketManager: Pick<SocketManager, 'broadcastToRoom'>;
}

export interface TaskRunOutcomeParams {
  task: TaskItem;
  invocationId: string;
  finalStatus: 'succeeded' | 'failed';
  /** Raw invocation error text (only present/meaningful when finalStatus === 'failed'). */
  errorText?: string;
  deps: TaskRunLinkageDeps;
}

/**
 * Applies the task↔run linkage rule for one terminal invocation.
 * Returns the updated task, or null if the underlying taskStore.update() call itself
 * returned null (task vanished). Never throws — callers still wrap this in try/catch as
 * defense in depth, but this function's own side effects (store write, notice, broadcast)
 * are already best-effort internally consistent with the sibling appendUsageTaskEvents/
 * appendArtifactTaskEvent helpers in QueueProcessor.ts.
 */
export async function applyTaskRunOutcome(params: TaskRunOutcomeParams): Promise<TaskItem | null> {
  const { task, deps } = params;

  if (params.finalStatus === 'succeeded') {
    const updated = await deps.taskStore.update(task.id, {
      eventCatId: task.ownerCatId ?? 'system',
      events: [
        {
          ts: new Date().toISOString(),
          catId: task.ownerCatId ?? 'system',
          invocationId: params.invocationId,
          type: 'run_succeeded',
          data: { taskStatusAtCompletion: task.status },
        },
      ],
    });
    if (updated) {
      deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    }
    return updated;
  }

  // failed
  const failureClass = classifyRunFailureForTask(params.errorText);
  const nextStatus: TaskStatus = BLOCKING_FAILURE_CLASSES.has(failureClass) ? 'blocked' : 'failed';
  const legality = isLegalTaskStatusTransition(task.status, nextStatus);
  const redactedError = params.errorText
    ? redactSecretsInText(params.errorText).slice(0, MAX_ERROR_TEXT_LEN)
    : undefined;

  const updated = await deps.taskStore.update(task.id, {
    eventCatId: task.ownerCatId ?? 'system',
    ...(legality.ok
      ? {
          status: nextStatus,
          failureClass,
          ...(redactedError ? { failureReason: redactedError } : {}),
        }
      : {}),
    events: [
      {
        ts: new Date().toISOString(),
        catId: task.ownerCatId ?? 'system',
        invocationId: params.invocationId,
        type: 'failed',
        data: {
          failureClass,
          taskStatus: legality.ok ? nextStatus : task.status,
          ...(redactedError ? { runError: redactedError } : {}),
          ...(legality.ok ? {} : { statusChangeSkipped: legality.reason }),
        },
      },
    ],
  });
  if (!updated) return null;

  deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

  if (legality.ok && nextStatus !== task.status) {
    const label = await taskLifecycleLabel(deps.taskStore, updated).catch(() => `#${updated.id}`);
    await appendTaskLifecycleNotice({
      task: updated,
      content: `任务 ${label} 状态变更：${TASK_STATUS_LABEL_ZH[task.status]} → ${TASK_STATUS_LABEL_ZH[nextStatus]}（关联 run 失败：${FAILURE_CLASS_LABEL_ZH[failureClass]}）`,
      systemKind: 'task_status_changed',
      eventType: 'task_status_changed',
      tone: nextStatus === 'blocked' ? 'warning' : 'info',
      dedupeKey: nextStatus,
      deps: { messageStore: deps.messageStore, socketManager: deps.socketManager },
    }).catch(() => {});
  }

  return updated;
}
