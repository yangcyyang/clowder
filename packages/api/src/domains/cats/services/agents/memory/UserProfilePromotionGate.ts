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

import { appendFile, mkdir } from 'node:fs/promises';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import {
  appendMemoryCandidate,
  evaluateMemoryPromotion,
  getMemoryCandidatesDir,
  getMemoryCandidatesPath,
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

/**
 * `appendMemoryCandidate` requires exactly `MemoryCandidateRecord` — this
 * widens it (locally, in the one file that owns USER-profile candidates) with
 * `proposedByCatId`, so the ledger can carry "who proposed this" without
 * touching the shared type in AgentMemoryPromotionGate.ts. A variable typed
 * this way is still structurally assignable to `MemoryCandidateRecord` (extra
 * property, not a literal passed inline) so no cast is needed at the call site.
 */
interface UserProfileCandidateRecordSeed extends MemoryCandidateRecord {
  readonly proposedByCatId?: string;
}

/**
 * 批次 3 F-E: human-review decision status, layered on top of
 * `MemoryCandidateRecord['status']` (`'pending_review' | 'promoted'`) without
 * editing that shared union — 'approved'/'rejected' only exist in this file's
 * view of the ledger.
 */
export type UserProfileCandidateStatus = MemoryCandidateRecord['status'] | 'approved' | 'rejected';

/**
 * One candidate as read back for the human-review UI. Structurally a superset
 * of `MemoryCandidateRecord` (status widened, a few optional fields added) —
 * every real `MemoryCandidateRecord` value is directly assignable to this
 * type, no cast needed when reading the shared ledger via `listMemoryCandidates`.
 */
export interface UserProfileCandidateListItem {
  readonly id: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly content: string;
  readonly evaluation: MemoryPromotionEvaluation;
  readonly status: UserProfileCandidateStatus;
  readonly reviewer?: 'user';
  readonly createdAt: number;
  /** Set only on entries written via `proposeUserProfileWrite` after this batch — absent (undefined) for any pre-existing ledger entries written before this field existed. */
  readonly proposedByCatId?: string;
  /** Set only on approve/reject decision-append records (see `appendUserProfileCandidateRecord`). */
  readonly decidedAt?: number;
  /** Section the content was filed under — attached at approve time. */
  readonly section?: UserProfileSection;
}

export type UserProfileCandidateDecisionOutcome =
  | { readonly status: 'approved'; readonly id: string; readonly section: UserProfileSection; readonly path: string }
  | { readonly status: 'rejected'; readonly id: string }
  | { readonly status: 'not_found'; readonly id: string }
  | { readonly status: 'already_decided'; readonly id: string; readonly decision: UserProfileCandidateStatus };

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

    const appendLedger = (status: MemoryCandidateRecord['status']): Promise<void> => {
      // `record` is typed as the wider seed shape (adds `proposedByCatId`, the
      // provenance batch-3's human-review UI needs to show "来源猫" — the base
      // `catId` field is always the fixed queue key 'USER', never the
      // proposing cat's id). Passed through a typed variable (not an inline
      // literal) so it's assignable to `appendMemoryCandidate`'s
      // `MemoryCandidateRecord` param without touching that shared type in
      // AgentMemoryPromotionGate.ts (owned by concurrent batch-3 work).
      const record: UserProfileCandidateRecordSeed = {
        id: `user-cand-${now}-${candidateSequence++}`,
        catId: USER_PROFILE_CANDIDATE_KEY,
        invocationId: input.invocationId,
        threadId: input.threadId,
        content: input.candidateText,
        evaluation,
        status,
        proposedByCatId: input.proposedByCatId,
        ...(evaluation.reviewer ? { reviewer: evaluation.reviewer } : {}),
        createdAt: now,
      };
      return appendMemoryCandidate(record, projectRoot);
    };

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

// ---------------------------------------------------------------------------
// 批次 3 F-E: 画像人审 UI — approve/reject on top of the existing candidate
// ledger (`.cat-cafe/memory/candidates/USER.jsonl`).
//
// The ledger is append-only (F163-style audit discipline: never physically
// delete). A decision (approve/reject) is recorded by APPENDING a new line
// with the SAME `id` and an updated `status` — never by rewriting/mutating
// the original `pending_review` line in place. Readers reduce the file by id
// and take the LAST line per id (standard event-log "last write wins"), so
// the full history (proposal → decision) stays on disk for audit while the
// "current" view only shows the latest state per candidate.
// ---------------------------------------------------------------------------

/** Same append-only-JSONL shape as `appendMemoryCandidate`, but typed for the widened `UserProfileCandidateListItem` (status can be 'approved'/'rejected') — kept local so AgentMemoryPromotionGate.ts's shared type is never touched. */
async function appendUserProfileCandidateRecord(
  record: UserProfileCandidateListItem,
  projectRoot: string,
): Promise<void> {
  const path = getMemoryCandidatesPath(USER_PROFILE_CANDIDATE_KEY, projectRoot);
  await mkdir(getMemoryCandidatesDir(projectRoot), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

/** Reduce the append-only ledger to one (latest) record per candidate id. */
async function loadLatestCandidatesById(projectRoot: string): Promise<Map<string, UserProfileCandidateListItem>> {
  const raw = await listMemoryCandidates(USER_PROFILE_CANDIDATE_KEY, projectRoot);
  const byId = new Map<string, UserProfileCandidateListItem>();
  for (const record of raw) {
    // `record` (MemoryCandidateRecord) is directly assignable to
    // UserProfileCandidateListItem — see that interface's doc comment.
    byId.set(record.id, record);
  }
  return byId;
}

/**
 * List candidates still awaiting human review (status === 'pending_review'
 * in the latest-per-id view), oldest first — what the review UI renders.
 * Fast-tracked ('promoted') and already-decided ('approved'/'rejected')
 * entries are excluded; they remain on disk for audit but aren't "pending".
 */
export async function listUserProfileCandidatesForReview(
  projectRoot = findMonorepoRoot(),
): Promise<UserProfileCandidateListItem[]> {
  const byId = await loadLatestCandidatesById(projectRoot);
  return Array.from(byId.values())
    .filter((record) => record.status === 'pending_review')
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Approve a pending candidate: write its content to USER.md (same
 * `appendUserProfileLine` path fast-track promotion uses) and append a
 * decision record (status 'approved') to the ledger. Serialized through
 * `userProfileWriteQueue` — must never interleave with a concurrent Owner PUT
 * or another proposal's fast-track write.
 */
export async function approveUserProfileCandidate(
  id: string,
  opts: { readonly section?: UserProfileSection; readonly now?: () => number } = {},
  projectRoot = findMonorepoRoot(),
): Promise<UserProfileCandidateDecisionOutcome> {
  return userProfileWriteQueue.enqueue(async () => {
    const now = opts.now?.() ?? Date.now();
    const byId = await loadLatestCandidatesById(projectRoot);
    const target = byId.get(id);
    if (!target) return { status: 'not_found', id };
    if (target.status !== 'pending_review') {
      return { status: 'already_decided', id, decision: target.status };
    }

    const section = opts.section ?? classifyUserProfileSection(target.content);
    const existing = await readUserProfile(projectRoot);
    const nextContent = appendUserProfileLine(existing.content, section, target.content, formatDate(now));
    const written = await writeUserProfileAtomic(nextContent, projectRoot);

    await appendUserProfileCandidateRecord(
      { ...target, status: 'approved', section, decidedAt: now, reviewer: 'user' },
      projectRoot,
    );

    return { status: 'approved', id, section, path: written.path };
  });
}

/**
 * Reject a pending candidate: appends a decision record (status 'rejected')
 * to the ledger. USER.md is never touched — rejection is purely a queue
 * decision. The original `pending_review` line is never deleted (audit trail).
 */
export async function rejectUserProfileCandidate(
  id: string,
  opts: { readonly now?: () => number } = {},
  projectRoot = findMonorepoRoot(),
): Promise<UserProfileCandidateDecisionOutcome> {
  return userProfileWriteQueue.enqueue(async () => {
    const now = opts.now?.() ?? Date.now();
    const byId = await loadLatestCandidatesById(projectRoot);
    const target = byId.get(id);
    if (!target) return { status: 'not_found', id };
    if (target.status !== 'pending_review') {
      return { status: 'already_decided', id, decision: target.status };
    }

    await appendUserProfileCandidateRecord({ ...target, status: 'rejected', decidedAt: now, reviewer: 'user' }, projectRoot);

    return { status: 'rejected', id };
  });
}

export function resetUserProfilePromotionGateForTests(): void {
  candidateSequence = 0;
}
