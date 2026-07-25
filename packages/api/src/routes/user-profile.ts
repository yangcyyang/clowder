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
  estimateUserProfileTokens,
  parseUserProfile,
  readUserProfile,
  renderUserProfile,
  USER_PROFILE_MAX_CHARS,
  USER_PROFILE_SECTION_MAX_CHARS,
  writeUserProfileAtomic,
  type ParsedUserProfile,
  type UserProfileSection,
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

/** English keys for the wire contract — internal parsing still keys off the Chinese `## 标题` headings. */
function sectionsFromParsed(parsed: ParsedUserProfile): UserProfileSectionsPayload {
  return {
    preferences: (parsed.sections.get('偏好') ?? []).join('\n'),
    constraints: (parsed.sections.get('硬约束') ?? []).join('\n'),
    facts: (parsed.sections.get('账号级事实') ?? []).join('\n'),
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

      const nextParsed: ParsedUserProfile = {
        title: existingParsed.title,
        sections: new Map<UserProfileSection, string[]>([
          ['偏好', splitLines(preferences)],
          ['硬约束', splitLines(constraints)],
          ['账号级事实', splitLines(facts)],
        ]),
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
      rawExists: true,
      tokenEstimate: outcome.tokenEstimate,
    };
  });
}
