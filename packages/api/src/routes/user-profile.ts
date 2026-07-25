/**
 * 批次 3-H: 铲屎官画像 Owner 直接编辑 API — GET/PUT /api/user-profile.
 *
 * This is a *different* write path from `UserProfilePromotionGate` /
 * `proposeUserProfileWrite`. That gate exists so a cat's *proposed* edit to
 * the shared `.cat-cafe/memory/USER.md` always goes through a candidate
 * queue + human review before touching the file — the blast radius of a bad
 * AI-authored edit is every cat at once. Here the Owner (cy) is editing their
 * own profile directly, authenticated, in the member-config modal: that *is*
 * the human review, so this path writes straight through and never touches
 * the candidate queue or `evaluateMemoryPromotion`.
 *
 * Both paths still serialize through the single process-wide
 * `userProfileWriteQueue` — an Owner edit and a concurrent cat proposal must
 * never interleave a read-modify-write cycle against the same file.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOwnerUserId } from '../config/cat-config-loader.js';
import {
  approveUserProfileCandidate,
  listUserProfileCandidatesForReview,
  rejectUserProfileCandidate,
  type UserProfileCandidateListItem,
} from '../domains/cats/services/agents/memory/UserProfilePromotionGate.js';
import {
  deriveUserProfileSubTopics,
  estimateUserProfileTokens,
  parseUserProfile,
  readUserProfile,
  renderUserProfile,
  USER_PROFILE_MAX_CHARS,
  USER_PROFILE_SECTION_MAX_CHARS,
  writeUserProfileAtomic,
  type ParsedUserProfile,
  type UserProfileSection,
  type UserProfileSubTopicEntry,
} from '../domains/cats/services/agents/memory/UserProfileStore.js';
import { userProfileWriteQueue } from '../domains/cats/services/agents/memory/UserProfileWriteQueue.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface UserProfileRoutesOptions {
  /** Test seam — defaults to the live monorepo root in production. */
  projectRoot?: string;
}

interface UserProfileSectionsPayload {
  readonly preferences: string;
  readonly constraints: string;
  readonly facts: string;
}

interface UserProfileSubTopicsPayload {
  readonly preferences: readonly UserProfileSubTopicEntry[];
  readonly constraints: readonly UserProfileSubTopicEntry[];
  readonly facts: readonly UserProfileSubTopicEntry[];
}

/** English keys for the wire contract — internal parsing still keys off the Chinese `## 标题` headings. */
function sectionsFromParsed(parsed: ParsedUserProfile): UserProfileSectionsPayload {
  return {
    preferences: (parsed.sections.get('偏好') ?? []).join('\n'),
    constraints: (parsed.sections.get('硬约束') ?? []).join('\n'),
    facts: (parsed.sections.get('账号级事实') ?? []).join('\n'),
  };
}

/**
 * 批次 3 F-E: expose the parsed sub_topic breakdown alongside `sections` — the
 * edit UI itself is untouched this round (still three free-text boxes), this
 * is read-only extra structure for future UI iterations / debugging.
 */
function subTopicsFromParsed(parsed: ParsedUserProfile): UserProfileSubTopicsPayload {
  return {
    preferences: parsed.subTopics.get('偏好') ?? [],
    constraints: parsed.subTopics.get('硬约束') ?? [],
    facts: parsed.subTopics.get('账号级事实') ?? [],
  };
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const putSchema = z.object({
  preferences: z.string().max(USER_PROFILE_SECTION_MAX_CHARS),
  constraints: z.string().max(USER_PROFILE_SECTION_MAX_CHARS),
  facts: z.string().max(USER_PROFILE_SECTION_MAX_CHARS),
});

const TRUNCATION_MARKER = '[USER.md 内容过长，已截断]';

export async function userProfileRoutes(app: FastifyInstance, opts: UserProfileRoutesOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? resolveActiveProjectRoot();

  // GET is an open read (consistent with GET /api/config/cat-order) — the
  // member-config modal that renders this is Owner-only UI, but the read
  // itself carries no write risk.
  app.get('/api/user-profile', async () => {
    const record = await readUserProfile(projectRoot);
    const parsed = parseUserProfile(record.exists ? record.content : '');
    return {
      sections: sectionsFromParsed(parsed),
      // 批次 3 F-E: parsed sub_topic breakdown, additive — the edit UI itself
      // still reads/writes only `sections` this round.
      subTopics: subTopicsFromParsed(parsed),
      rawExists: record.exists,
      tokenEstimate: estimateUserProfileTokens(record.exists ? record.content : ''),
    };
  });

  app.put('/api/user-profile', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    if (operator !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can edit the user profile' };
    }

    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { preferences, constraints, facts } = parsed.data;

    const outcome = await userProfileWriteQueue.enqueue(async () => {
      const existing = await readUserProfile(projectRoot);
      const existingParsed = parseUserProfile(existing.exists ? existing.content : '');

      const tokenEstimate = estimateUserProfileTokens(
        [existingParsed.title, preferences, constraints, facts].join('\n\n'),
      );

      const nextSections = new Map<UserProfileSection, string[]>([
        ['偏好', splitLines(preferences)],
        ['硬约束', splitLines(constraints)],
        ['账号级事实', splitLines(facts)],
      ]);
      const nextParsed: ParsedUserProfile = {
        title: existingParsed.title,
        sections: nextSections,
        subTopics: deriveUserProfileSubTopics(nextSections),
      };
      const rendered = renderUserProfile(nextParsed);

      // renderUserProfile silently truncates + stamps a marker when the
      // rebuilt content would exceed USER_PROFILE_MAX_CHARS. For an Owner
      // direct edit we never want to persist a silently-truncated file —
      // detect that marker and reject the write instead (length defense
      // "before" the write actually lands on disk).
      if (rendered.includes(TRUNCATION_MARKER)) {
        return { status: 'too_large' as const, tokenEstimate };
      }

      const written = await writeUserProfileAtomic(rendered, projectRoot);
      return { status: 'written' as const, tokenEstimate, written };
    });

    if (outcome.status === 'too_large') {
      reply.status(400);
      return {
        error: `画像总长度超出上限（约 ${USER_PROFILE_MAX_CHARS} 字符），请精简后重试`,
        tokenEstimate: outcome.tokenEstimate,
      };
    }

    const finalParsed = parseUserProfile(outcome.written.content);
    return {
      sections: sectionsFromParsed(finalParsed),
      subTopics: subTopicsFromParsed(finalParsed),
      rawExists: true,
      tokenEstimate: outcome.tokenEstimate,
    };
  });

  // ---------------------------------------------------------------------
  // 批次 3 F-E: 画像人审 UI — candidate queue read/decide routes.
  // Same Owner-only auth as PUT above: the review queue can contain
  // pre-promotion drafts of personal profile content, so it's gated exactly
  // like a direct profile edit, not left as an open read like GET above.
  // ---------------------------------------------------------------------

  /** Returns null (caller must reply+return it) when authorized; else sets the reply status/body and returns the error payload. */
  function authorizeOwner(request: FastifyRequest, reply: FastifyReply): { error: string } | null {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    if (operator !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can review user-profile candidates' };
    }
    return null;
  }

  function toWireCandidate(record: UserProfileCandidateListItem) {
    return {
      id: record.id,
      content: record.content,
      // 候选队列的 catId 字段固定是队列 key 'USER'（AgentMemoryPromotionGate 的
      // per-cat 分片命名法），真正的"来源猫"是 proposeUserProfileWrite 另外记的
      // proposedByCatId —— 旧数据（批次 3 之前写入、此前从未落盘这个字段）缺省为
      // null，前端展示"未知来源猫"。
      sourceCatId: record.proposedByCatId ?? null,
      threadId: record.threadId,
      action: record.evaluation.action,
      conflict: record.evaluation.conflict ?? null,
      suggestion: extractCandidateSuggestion(record),
      createdAt: record.createdAt,
    };
  }

  app.get('/api/user-profile/candidates', async (request: FastifyRequest, reply: FastifyReply) => {
    const authError = authorizeOwner(request, reply);
    if (authError) return authError;

    const candidates = await listUserProfileCandidatesForReview(projectRoot);
    return {
      candidates: candidates.map(toWireCandidate),
      pendingCount: candidates.length,
    };
  });

  app.post('/api/user-profile/candidates/:id/approve', async (request: FastifyRequest, reply: FastifyReply) => {
    const authError = authorizeOwner(request, reply);
    if (authError) return authError;

    const { id } = request.params as { id: string };
    const outcome = await approveUserProfileCandidate(id, {}, projectRoot);
    if (outcome.status === 'not_found') {
      reply.status(404);
      return { error: '候选条目不存在或已被处理' };
    }
    if (outcome.status === 'already_decided') {
      reply.status(409);
      return { error: `该候选已被处理（状态：${outcome.decision}）`, decision: outcome.decision };
    }
    if (outcome.status !== 'approved') {
      // Unreachable via approveUserProfileCandidate in practice (it never
      // resolves 'rejected') — the shared decision-outcome union just also
      // covers reject's shape. Kept as an explicit branch so TS narrows
      // `outcome` to the 'approved' variant below without an unsafe cast.
      reply.status(500);
      return { error: 'unexpected outcome' };
    }
    return { status: outcome.status, id: outcome.id, section: outcome.section };
  });

  app.post('/api/user-profile/candidates/:id/reject', async (request: FastifyRequest, reply: FastifyReply) => {
    const authError = authorizeOwner(request, reply);
    if (authError) return authError;

    const { id } = request.params as { id: string };
    const outcome = await rejectUserProfileCandidate(id, {}, projectRoot);
    if (outcome.status === 'not_found') {
      reply.status(404);
      return { error: '候选条目不存在或已被处理' };
    }
    if (outcome.status === 'already_decided') {
      reply.status(409);
      return { error: `该候选已被处理（状态：${outcome.decision}）`, decision: outcome.decision };
    }
    return { status: outcome.status, id: outcome.id };
  });
}

/**
 * 批次 2 (F-B) 冲突消解若给候选附带合并/退休建议文案，字段位置未定（可能在
 * `evaluation` 顶层或 `evaluation.conflict` 上）——这里做防御式多路径探测，
 * 命中任一路径就展示，全部缺失时返回 undefined，绝不硬依赖某个具体形状。
 */
function extractCandidateSuggestion(record: UserProfileCandidateListItem): string | undefined {
  const evaluation = record.evaluation as unknown as Record<string, unknown>;
  const direct = evaluation?.suggestion;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const conflict = evaluation?.conflict as Record<string, unknown> | undefined;
  const nestedKeys = ['suggestion', 'mergeSuggestion', 'suggestionText'];
  for (const key of nestedKeys) {
    const value = conflict?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
