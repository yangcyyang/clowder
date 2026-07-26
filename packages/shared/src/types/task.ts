/**
 * Task Types (毛线球)
 * 猫猫任务系统 — 让每只猫追踪自己负责的事项
 *
 * #320: Unified model — PR tracking merged into Task system.
 * kind=work: human/cat collaboration tasks (original)
 * kind=pr_tracking: automated PR monitoring tasks (merged from PrTrackingStore)
 */

import type { CatId } from './ids.js';

export type TaskStatus = 'todo' | 'doing' | 'in_review' | 'blocked' | 'done' | 'failed';
export type TaskFailureClass =
  | 'agent_error'
  | 'build_failed'
  | 'test_failed'
  | 'timeout'
  | 'budget_exhausted'
  | 'infra_error'
  | 'manual_fail';
export type TaskEventType =
  | 'claimed'
  | 'unclaimed'
  | 'status_changed'
  | 'completed'
  | 'failed'
  | 'handoff'
  | 'artifact'
  | 'usage'
  | 'capability_authorized'
  | 'capability_usage'
  | 'tool_usage'
  | 'compact_boundary'
  | 'fast_lane_decision'
  | 'fast_lane_started'
  | 'fast_lane_completed'
  | 'fast_lane_failed'
  /** Batch 3-A item 2: bookkeeping-only marker — a linked run succeeded while the task
   *  stayed in its current status (platform never auto-advances to in_review/done). */
  | 'run_succeeded'
  /** ClaimedIdleScheduler: a claimed-but-idle wake-up nudge was sent to the owner cat.
   *  Scoped per claim cycle — only events after the most recent 'claimed' event count
   *  toward the 2-nudge cap (see ClaimedIdleScheduler.ts). */
  | 'idle_nudged'
  /** ClaimedIdleScheduler: the 2-nudge cap was exhausted and the task is still idle —
   *  terminal marker for this claim cycle; the scheduler never acts on this task again
   *  until it is unclaimed/re-claimed. A system notice is posted to the main thread. */
  | 'task_idle_escalated'
  /** 批次4-B5 票面卫生 (docs/research/raft-r9-ticket-hygiene.md B5.3): a message-id claim
   *  attempt was downgraded onto this already-active task instead of minting a duplicate
   *  ticket — the source message's content was attached as a progress note in the task's
   *  own discussion thread. `data` carries { sourceMessageId, sourceThreadId,
   *  progressMessageId } pointers only (content lives in the discussion thread message). */
  | 'progress_note'
  /** 批次4-B1: task entered 'in_review' and its reviewer was resolved (default rule or
   *  inherited from parent) and notified. `data` carries { reviewerId, selfReviewRedirectedFrom?,
   *  reason? } — the redirect fields are present only when the "执行者永不 review 自己的票"
   *  server-side guard fired (see task-status-transitions.ts resolveReviewerAvoidingSelfReview). */
  | 'review_requested'
  /** 批次4-B2 分轨超时提醒: one reminder fired for the current review cycle (scoped to events
   *  after the most recent 'review_requested'/status_changed-to-in_review event — a fresh
   *  in_review entry gets a fresh budget). `data` carries { track: 'gate' | 'human', level: 1 | 2 | 3 }.
   *  Each (track, level) pair fires at most once per review cycle — see ReviewReminderScheduler.ts. */
  | 'review_reminder_sent'
  /** 批次4-B2 human 轨第三级状态动作: the review sat unanswered past the terminal window (default
   *  10 days, env-configurable within the spec's 7-14 day range) — platform force-reverted the
   *  task from 'in_review' back to 'doing' and notified both submitter and reviewer. Terminal for
   *  the review cycle: the scheduler never re-fires reminders for this cycle after this event. */
  | 'review_timeout_reverted'
  /** 批次4-B3 失能打标: the task's assignee (ownerCatId) has shown a continuous (no intervening
   *  success), >30-minute streak of an incapacitating provider-error classification (quota /
   *  permission_denied / repeated process-crash — see provider-error-classification.ts) and was
   *  auto-tagged. `data` carries { classification, since }. Never triggers auto-reassignment —
   *  see AssigneeIncapacitationScheduler.ts. */
  | 'assignee_incapacitated'
  /** 批次4-B3: the tagged assignee recovered (a successful run was observed) — tag cleared.
   *  `data` carries { classification, since, durationMs } as the permanent "vacuum period"
   *  record (Raft: 验收时要知道这段真空期), even though the live tag itself is gone. */
  | 'assignee_recovered'
  /** 批次4-B4①③: task entered 'in_review' — best-effort git evidence snapshot (commit sha,
   *  diff stat, changed file list) anchored to the task thread, plus a static scan result
   *  (binary files / bare control chars / secret-shaped strings in the diff). `data` carries
   *  { repoDir, commitSha, hasUncommittedChanges, changedFileCount, scanFlags }. Absent when the
   *  git snapshot itself failed (no repo, no permission, etc — best-effort, never blocks the
   *  transition) — see task-review-evidence.ts. */
  | 'evidence_anchored'
  /** 批次4-B4④ 验收动作留痕: the task left 'in_review' (approved to 'done', sent back to
   *  'doing'/'blocked', or marked 'failed') via a human/cat-initiated status change (never for
   *  the automated review_timeout_reverted path, which has its own event). `data` carries
   *  { from: 'in_review', to, actorId, evidenceEventTs? } pointing back at the evidence_anchored
   *  event (if any) that was current at decision time. */
  | 'review_action_recorded'
  /** 批次4-B5.5 建票上浮 (docs/prd/batch4-codex-execution.md §3 B5.5): an explicit
   *  ticket-creation entry point (cat cat_cafe_task_create, human "As Task", right-click
   *  Convert-to-Task) was invoked from inside a branch/discussion thread and the resulting
   *  task was anchored to the top-level channel it traced up to, instead of the branch —
   *  Raft's "分支=讨论, 频道=任务层" structural rule. Recorded once, at task creation, only
   *  when hoisting actually moved the anchor (top-level/DM-initiated creation never gets
   *  this event). `data` carries optional { originThreadId?, originMessageId? } — the
   *  pre-hoist thread the request came from, and (when a concrete message triggered the
   *  creation — As Task / Convert-to-Task, not cat_cafe_task_create) that message's id —
   *  so the discussion context that led to the task can still be traced back. See
   *  resolveTopLevelThreadId / resolveTaskHoistAnchor in work-admission-service.ts. */
  | 'hoisted_to_channel';

/**
 * Task kind discriminator (#320).
 * - work: manual tasks created by cats/humans
 * - pr_tracking: automated PR tasks (review-feedback, cicd-check, conflict-check)
 */
export type TaskKind = 'work' | 'pr_tracking';

/** CI/CD automation state for pr_tracking tasks */
export interface CiAutomationState {
  readonly headSha?: string;
  readonly lastFingerprint?: string;
  readonly lastBucket?: string;
  readonly lastNotifiedAt?: number;
  readonly enabled?: boolean;
  readonly skipNotified?: boolean;
}

/** Conflict detection automation state for pr_tracking tasks */
export interface ConflictAutomationState {
  readonly mergeState?: string;
  readonly lastFingerprint?: string;
  readonly lastNotifiedAt?: number;
}

/** Review feedback automation state for pr_tracking tasks */
export interface ReviewAutomationState {
  readonly lastCommentCursor?: number;
  readonly lastDecisionCursor?: number;
  readonly lastNotifiedAt?: number;
}

/** Composite automation state embedded in pr_tracking tasks (#320 KD-14) */
export interface AutomationState {
  readonly ci?: CiAutomationState;
  readonly conflict?: ConflictAutomationState;
  readonly review?: ReviewAutomationState;
  readonly closedAt?: number;
}

/** Delivery evidence attached to a work task. */
export interface TaskEvidence {
  readonly tests?: string;
  readonly build?: string;
  readonly screenshot?: string;
  readonly review?: string;
  readonly lesson?: string;
  readonly updatedAt?: number;
}

/** Append-only task activity ledger, embedded with the task record. */
export interface TaskEvent {
  readonly ts: string;
  /** Actor cat id, or 'user'/'system' when no cat actor exists. */
  readonly catId: string;
  /** Optional standard pointer to the agent invocation that produced this event. */
  readonly invocationId?: string;
  readonly type: TaskEventType;
  readonly data?: Record<string, unknown>;
}

export interface TaskItem {
  readonly id: string;
  /** Task kind: 'work' (default) or 'pr_tracking' (#320) */
  readonly kind: TaskKind;
  readonly threadId: string;
  /**
   * Unique subject key for dedup/lookup (#320 KD-15).
   * Format: `pr:{owner/repo}#{num}` | `thread:{threadId}` | `repo:{owner/repo}`
   * Null for kind=work tasks that don't need subject-based dedup.
   */
  readonly subjectKey: string | null;
  readonly title: string;
  readonly ownerCatId: CatId | null;
  readonly status: TaskStatus;
  readonly failureClass?: TaskFailureClass;
  readonly failureReason?: string;
  readonly why: string;
  readonly createdBy: CatId | 'user' | 'system';
  readonly createdAt: number;
  readonly updatedAt: number;
  /** PR tracking automation state (#320 KD-14). Only present for kind=pr_tracking. */
  readonly automationState?: AutomationState;
  /** User who registered this task (for ownership checks). */
  readonly userId?: string;
  /** Source message ID for traceability (4-A feature) */
  readonly sourceMessageId?: string;
  /** Source summary ID for traceability (4-A feature) */
  readonly sourceSummaryId?: string;
  /** Dedicated discussion thread for this task, Slock-style task thread. */
  readonly taskThreadId?: string;
  /** Human-visible delivery evidence for task acceptance. */
  readonly evidence?: TaskEvidence;
  /** Embedded task event ledger. Missing means legacy task with no recorded events yet. */
  readonly events?: readonly TaskEvent[];
  /** Parent task in a decomposition tree. */
  readonly parentTaskId?: string;
  /** Task this one retries after a failed/blocked attempt. */
  readonly retryOf?: string;
  /** Task this one branches from for an alternative approach. */
  readonly branchOf?: string;
  /**
   * 批次4-B1: 验收人——猫 id 或字面量 'human'. 只此一个字段(不做"gate 预验/人类终审"
   * 双字段). 缺省规则、自审校正见 task-reviewer-defaults.ts / task-status-transitions.ts。
   * Absent on legacy tasks created before this batch — callers should treat that the same
   * as 'human' (the ultimate default).
   */
  readonly reviewerId?: CatId | 'human';
}

export type CreateTaskInput = Pick<TaskItem, 'threadId' | 'title' | 'why' | 'createdBy'> & {
  kind?: TaskKind;
  subjectKey?: string | null;
  ownerCatId?: CatId | null;
  /** Internal admission paths may create an already-claimed task atomically. */
  status?: TaskStatus;
  failureClass?: TaskFailureClass;
  failureReason?: string;
  automationState?: AutomationState;
  userId?: string;
  sourceMessageId?: string;
  sourceSummaryId?: string;
  taskThreadId?: string;
  evidence?: TaskEvidence;
  events?: readonly TaskEvent[];
  parentTaskId?: string;
  retryOf?: string;
  branchOf?: string;
  /** 批次4-B1: explicit reviewer, when the caller already resolved one (e.g. inherited from a
   * parent task). Most creation paths omit this and let the platform resolve the default —
   * see task-reviewer-defaults.ts's resolveReviewerIdForNewTask(). */
  reviewerId?: CatId | 'human';
};

/** Mutable partial for updates — strips readonly from TaskItem fields */
export type UpdateTaskInput = {
  title?: string;
  ownerCatId?: CatId | null;
  status?: TaskStatus;
  failureClass?: TaskFailureClass;
  failureReason?: string;
  why?: string;
  sourceMessageId?: string;
  taskThreadId?: string;
  automationState?: AutomationState;
  evidence?: TaskEvidence;
  events?: readonly TaskEvent[];
  parentTaskId?: string;
  retryOf?: string;
  branchOf?: string;
  /** Actor to attribute auto-generated task ledger events to. */
  eventCatId?: string;
  /** 批次4-B1: reviewer reassignment (default-rule resolution at creation, or the
   * self-review auto-redirect at the in_review transition — see task-status-transitions.ts). */
  reviewerId?: CatId | 'human';
};
