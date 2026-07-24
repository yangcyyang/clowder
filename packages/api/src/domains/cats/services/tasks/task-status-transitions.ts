import type { TaskStatus } from '@cat-cafe/shared';

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
