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
  | 'usage';

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
}

export type CreateTaskInput = Pick<TaskItem, 'threadId' | 'title' | 'why' | 'createdBy'> & {
  kind?: TaskKind;
  subjectKey?: string | null;
  ownerCatId?: CatId | null;
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
};
