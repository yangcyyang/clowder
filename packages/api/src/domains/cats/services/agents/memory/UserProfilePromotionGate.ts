/**
 * 批次 2-D 任务二: UserProfile write gate — designated ENFORCE tier.
 *
 * `.cat-cafe/memory/USER.md` is shared and read by every cat (see
 * SystemPromptBuilder.buildUserProfileLines, v2 meta 槽, 全猫可见). A bad write
 * here pollutes every cat's context at once — strictly higher blast radius than
 * a single cat's own `.cat-cafe/memory/{catId}.md`. So unlike
 * AgentMemoryPromotionGate (governed by `CAT_CAFE_MEMORY_PROMOTION_MODE`,
 * default 'off'), UserProfile writes are **always** evaluated at the 'enforce'
 * tier — no env var opts out of review here. This module is intentionally thin:
 * it reuses `evaluateMemoryPromotion` + the candidate-queue ledger mechanism
 * from AgentMemoryPromotionGate.ts wholesale (catId key `'USER'`), rather than
 * re-deriving promotion heuristics.
 *
 * Fast-track: an explicit user "记住：…" instruction still promotes directly
 * (evaluateMemoryPromotion rule 4) — same discipline as per-cat memory. Every
 * other path (candidate / hold / skip) queues to
 * `.cat-cafe/memory/candidates/USER.jsonl` for human review; USER.md itself is
 * untouched until then.
 *
 * Concurrency: all reads-then-writes are serialized through
 * `userProfileWriteQueue` (single-writer FIFO, same pattern as F163's
 * EvidenceWriteQueue) so concurrent proposals from different cats/threads never
 * interleave a read-modify-write cycle.
 */

import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import {
  appendMemoryCandidate,
  evaluateMemoryPromotion,
  listMemoryCandidates,
  recordPromotionDecision,
  type MemoryCandidateRecord,
  type MemoryFrontmatter,
  type MemoryPromotionEvaluation,
} from './AgentMemoryPromotionGate.js';
import {
  appendUserProfileLine,
  classifyUserProfileSection,
  readUserProfile,
  writeUserProfileAtomic,
  type UserProfileSection,
} from './UserProfileStore.js';
import { userProfileWriteQueue } from './UserProfileWriteQueue.js';

/** Shared candidate-queue key — reuses AgentMemoryPromotionGate's per-catId ledger plumbing. */
export const USER_PROFILE_CANDIDATE_KEY = 'USER';

export interface UserProfileWriteProposal {
  /** Candidate content (one-line durable statement, no delivery prefix). */
  readonly candidateText: string;
  /** Explicit target section; falls back to classifyUserProfileSection heuristic. */
  readonly section?: UserProfileSection;
  /** Raw user message text, when available — grounds user-stated fast-track grading. */
  readonly userMessageText?: string | undefined;
  /** Optional four-category frontmatter (see AgentMemoryPromotionGate.parseMemoryFrontmatter). */
  readonly frontmatter?: MemoryFrontmatter | null;
  /** Which cat proposed this write (attribution in the ledger). */
  readonly proposedByCatId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly now?: () => number;
}

export interface UserProfileWriteResult {
  readonly status: 'updated' | 'held' | 'skipped';
  readonly reason?: 'pending_review' | 'conflict_hold' | 'low_confidence' | 'session_temp' | 'duplicate';
  readonly evaluation: MemoryPromotionEvaluation;
  readonly path?: string;
  readonly section?: UserProfileSection;
}

let candidateSequence = 0;

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Propose a durable write to USER.md. Always enforce-tier: either fast-tracked
 * (explicit user "记住：…") straight to durable USER.md, or held in the shared
 * candidate queue pending human review. Never writes speculatively.
 */
export async function proposeUserProfileWrite(
  input: UserProfileWriteProposal,
  projectRoot = findMonorepoRoot(),
): Promise<UserProfileWriteResult> {
  return userProfileWriteQueue.enqueue(async () => {
    const now = input.now?.() ?? Date.now();
    const existing = await readUserProfile(projectRoot);
    const queued = await listMemoryCandidates(USER_PROFILE_CANDIDATE_KEY, projectRoot);

    const evaluation = evaluateMemoryPromotion({
      candidateText: input.candidateText,
      existingMemory: existing.content,
      userMessageText: input.userMessageText,
      queuedContents: queued.map((record) => record.content),
      frontmatter: input.frontmatter,
    });
    recordPromotionDecision('enforce', evaluation);

    const appendLedger = (status: MemoryCandidateRecord['status']): Promise<void> =>
      appendMemoryCandidate(
        {
          id: `user-cand-${now}-${candidateSequence++}`,
          catId: USER_PROFILE_CANDIDATE_KEY,
          invocationId: input.invocationId,
          threadId: input.threadId,
          content: input.candidateText,
          evaluation,
          status,
          ...(evaluation.reviewer ? { reviewer: evaluation.reviewer } : {}),
          createdAt: now,
        },
        projectRoot,
      );

    if (evaluation.action === 'hold') {
      await appendLedger('pending_review');
      return { status: 'held', reason: 'conflict_hold', evaluation };
    }
    if (evaluation.action === 'candidate') {
      await appendLedger('pending_review');
      return { status: 'held', reason: 'pending_review', evaluation };
    }
    if (evaluation.action === 'skip') {
      return { status: 'skipped', reason: evaluation.skipReason, evaluation };
    }

    // promote: only reached via explicit user "记住：" fast-track
    // (evaluateMemoryPromotion rule 4) — reviewer='user' is recorded.
    await appendLedger('promoted');
    const section = input.section ?? classifyUserProfileSection(input.candidateText);
    const nextContent = appendUserProfileLine(existing.content, section, input.candidateText, formatDate(now));
    const written = await writeUserProfileAtomic(nextContent, projectRoot);
    return { status: 'updated', evaluation, path: written.path, section };
  });
}

/** List pending/promoted USER.md candidates — same shape as per-cat memory candidates. */
export async function listUserProfileCandidates(
  projectRoot = findMonorepoRoot(),
): Promise<MemoryCandidateRecord[]> {
  return listMemoryCandidates(USER_PROFILE_CANDIDATE_KEY, projectRoot);
}

export function resetUserProfilePromotionGateForTests(): void {
  candidateSequence = 0;
}
