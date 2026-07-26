import type { CatId, TaskStatus } from '@cat-cafe/shared';
import { HUMAN_REVIEWER, type ReviewerId } from './task-reviewer-defaults.js';

/**
 * Batch 2-C: minimal legal-transition guard for `cat_cafe_task_update`.
 *
 * Encodes exactly the one SOP rule that matters here (design doc
 * docs/research/clowder-raft-thread-task-design.md §5.2 rule 6 — "完成先
 * 置 in_review，人验过才 done"): a task cannot jump straight to `done`
 * without first passing through `in_review`, and `done` is terminal (no
 * further status changes through this endpoint — reopening a completed
 * task is a deliberate human/owner decision, not a routine cat update).
 *
 * Everything else is left permissive on purpose — this is a guardrail
 * against the one documented failure mode, not a full state machine no one
 * asked for.
 */
export type TaskTransitionCheck = { ok: true } | { ok: false; reason: string };

export function isLegalTaskStatusTransition(from: TaskStatus, to: TaskStatus): TaskTransitionCheck {
  if (from === to) return { ok: true };

  if (from === 'done') {
    return {
      ok: false,
      reason: `Task is already 'done' (terminal state) — reopening it is not supported via task_update.`,
    };
  }

  if (to === 'done' && from !== 'in_review') {
    return {
      ok: false,
      reason: `Cannot move directly from '${from}' to 'done'. Mark 'in_review' first so evidence can be checked, then 'done'.`,
    };
  }

  return { ok: true };
}

/**
 * 批次4-B1: "执行者永不 review 自己的票" —— 服务端校验, 在置 in_review 的迁移里做
 * (docs/prd/batch4-codex-execution.md §3 B1 + B-AC1), 不能只靠前端.
 *
 * Pure function — no env/catRegistry access here (task-status-transitions.ts stays a plain
 * rules module, matching its existing style); callers resolve `defaultReviewerId` themselves
 * via task-reviewer-defaults.ts's resolveConfiguredDefaultReviewerId() and pass it in.
 *
 * Behavior: 执行文档正文允许"拒绝或落回缺省"两种实现，但 B-AC1 的验收标准明确写的是
 * "执行者=reviewer 被服务端拒绝"——按 AC 的可测试表述实现为拒绝（HTTP 409 style: caller
 * rejects the whole in_review transition), 而不是静默改派。错误结果里带上
 * `suggestedReviewerId`（默认验收人；若默认验收人恰好也是执行者自己，则建议人工验收）供
 * 调用方在错误提示里指引猫"下次应该怎么办"，不需要猫自己再去猜默认值。
 */
export type ReviewerAssignmentResolution =
  | { ok: true; reviewerId: ReviewerId }
  | { ok: false; reason: string; suggestedReviewerId: ReviewerId };

export function resolveReviewerAvoidingSelfReview(params: {
  candidateReviewerId: ReviewerId;
  ownerCatId: CatId | null;
  defaultReviewerId: ReviewerId;
}): ReviewerAssignmentResolution {
  const { candidateReviewerId, ownerCatId, defaultReviewerId } = params;
  if (!ownerCatId || candidateReviewerId !== ownerCatId) {
    return { ok: true, reviewerId: candidateReviewerId };
  }
  const suggestedReviewerId = defaultReviewerId !== ownerCatId ? defaultReviewerId : HUMAN_REVIEWER;
  return {
    ok: false,
    reason: `执行者与验收人相同(${String(ownerCatId)})，不能自己审自己的票——请改派验收人（建议：${String(suggestedReviewerId)}）后再置 in_review`,
    suggestedReviewerId,
  };
}
