/**
 * 批次4-B1: reviewer 缺省规则.
 * docs/prd/batch4-codex-execution.md §3 B1 / docs/prd/batch4-reliability-task-closure-session.md
 * 第七轮访谈参数落定: "人建的票 → 常设 gate(可配置的 gate 猫, 未配置时=human; 不是建票人);
 * agent 子票 → 继承父票 reviewer".
 *
 * Scope note: this module only resolves WHICH reviewer a *new* task gets. The
 * "执行者永不 review 自己的票" server-side guard that can override this at the
 * in_review transition lives in task-status-transitions.ts (resolveReviewerAvoidingSelfReview) —
 * kept separate so that file stays free of catRegistry/env dependencies, matching its
 * existing pure-function style.
 */

import { catRegistry, type CatId, type TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';

const log = createModuleLogger('task-reviewer-defaults');

/** env var registered in env-registry.ts — configures the standing "gate cat". */
export const DEFAULT_REVIEWER_ENV_VAR = 'CLOWDER_TASK_DEFAULT_REVIEWER';

/** Literal reviewer value meaning "a human verifies this" — never collides with a real CatId. */
export const HUMAN_REVIEWER = 'human' as const;

export type ReviewerId = CatId | typeof HUMAN_REVIEWER;

/**
 * Resolves the platform-wide configured default reviewer (the "gate cat").
 * Unset/blank → 'human'. Configured but not a currently-registered cat → 'human'
 * (fail-open on operator typos/renames/removed cats, same convention as
 * ClaimedIdleScheduler's resolveClaimedIdleThresholdMinutes) with a warning log.
 */
export function resolveConfiguredDefaultReviewerId(env: NodeJS.ProcessEnv = process.env): ReviewerId {
  const raw = (env[DEFAULT_REVIEWER_ENV_VAR] ?? '').trim();
  if (!raw) return HUMAN_REVIEWER;
  if (!catRegistry.has(raw)) {
    log.warn(
      `[task-reviewer-defaults] ${DEFAULT_REVIEWER_ENV_VAR}=${raw} is not a registered cat — falling back to '${HUMAN_REVIEWER}'`,
    );
    return HUMAN_REVIEWER;
  }
  return raw as CatId;
}

/**
 * 批次4-B1 缺省规则 (applies uniformly to every task-creation call site — human-originated
 * work-admission tasks and agent task_create alike, since the spec's "人建的票" rule and the
 * "no other rule specified" case resolve identically to the platform default):
 *   - parentTaskId present → inherit the parent's reviewerId (falls through to the platform
 *     default when the parent itself has none — e.g. a legacy pre-batch-4 parent task).
 *   - otherwise → the configured default reviewer (CLOWDER_TASK_DEFAULT_REVIEWER, or 'human').
 * Resolved once at creation time; not re-derived on every read (a task's reviewer is stable
 * unless explicitly redirected by the self-review guard at the in_review transition).
 */
export function resolveReviewerIdForNewTask(params: {
  parentTask?: Pick<TaskItem, 'reviewerId'> | null;
  env?: NodeJS.ProcessEnv;
}): ReviewerId {
  if (params.parentTask?.reviewerId) return params.parentTask.reviewerId;
  return resolveConfiguredDefaultReviewerId(params.env);
}

/** True when `reviewerId` names a currently-registered cat (the "gate 轨" case), false for 'human' or undefined. */
export function isGateReviewer(reviewerId: ReviewerId | undefined): reviewerId is CatId {
  return reviewerId !== undefined && reviewerId !== HUMAN_REVIEWER && catRegistry.has(reviewerId);
}
