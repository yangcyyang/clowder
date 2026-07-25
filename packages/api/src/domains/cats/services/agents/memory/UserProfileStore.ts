/**
 * 批次 2-D: 用户画像层 —— 共享铲屎官画像文件 `.cat-cafe/memory/USER.md`。
 *
 * 三节固定结构：
 *  - 偏好：语气/格式/工作习惯等软性偏好。
 *  - 硬约束：不可违反的红线（端口/权限/身份/危险操作等）。
 *  - 账号级事实：跨项目稳定的账号级信息（不是某个 cat 的记忆，是铲屎官本人的事实）。
 *
 * 全部猫共享同一份、只读注入（见 SystemPromptBuilder.buildUserProfileLines，
 * 仅 v2 meta 槽，预算 ≤1k tokens）。写入受控——见 UserProfilePromotionGate.ts，
 * 走 promotion gate 的 enforce 档（候选队列 + 人审），不允许猫直接改写此文件。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { getAgentMemoryDir } from './AgentMemoryStore.js';

export const USER_PROFILE_MAX_CHARS = 12_000;
/**
 * Per-section defense cap for the Owner direct-edit API (batch 3-H). Three
 * sections at this cap (~11_400 chars) plus title/heading overhead stay
 * comfortably under USER_PROFILE_MAX_CHARS, so the common case never hits the
 * total-length rejection in the route handler.
 */
export const USER_PROFILE_SECTION_MAX_CHARS = 3_800;
export const USER_PROFILE_FILE_NAME = 'USER.md';

export type UserProfileSection = '偏好' | '硬约束' | '账号级事实';

export const USER_PROFILE_SECTIONS: readonly UserProfileSection[] = ['偏好', '硬约束', '账号级事实'];

export interface UserProfileRecord {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly truncated: boolean;
}

export function getUserProfilePath(projectRoot = findMonorepoRoot()): string {
  return join(getAgentMemoryDir(projectRoot), USER_PROFILE_FILE_NAME);
}

const DEFAULT_USER_PROFILE_TEMPLATE = ['# 铲屎官画像', '', '## 偏好', '', '## 硬约束', '', '## 账号级事实', ''].join(
  '\n',
);

export function getDefaultUserProfileTemplate(): string {
  return DEFAULT_USER_PROFILE_TEMPLATE;
}

export async function readUserProfile(projectRoot = findMonorepoRoot()): Promise<UserProfileRecord> {
  const path = getUserProfilePath(projectRoot);
  if (!existsSync(path)) {
    return { path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > USER_PROFILE_MAX_CHARS;
  return {
    path,
    content: truncated ? `${raw.slice(0, USER_PROFILE_MAX_CHARS)}\n\n[USER.md 内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

/** For prompt injection — trims and returns null when empty (same contract as AgentMemoryStore.readAgentMemoryForPrompt). */
export async function readUserProfileForPrompt(projectRoot = findMonorepoRoot()): Promise<string | null> {
  try {
    const record = await readUserProfile(projectRoot);
    const content = record.content.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

export interface ParsedUserProfile {
  readonly title: string;
  readonly sections: Map<UserProfileSection, string[]>;
  /**
   * 批次 3 F-E: lightweight Memobase topic/sub_topic analogue — derived,
   * read-only breakdown of each section's lines. `sections` (the raw bullet
   * array) stays the single source of truth for rendering/appending; this map
   * is purely a parsed VIEW on top of it, rebuilt every call by
   * `deriveUserProfileSubTopics`. Never required on write — a line with no
   * `**子主题**:` prefix parses with `subTopic: null` and is 100% unaffected.
   */
  readonly subTopics: Map<UserProfileSection, UserProfileSubTopicEntry[]>;
}

/**
 * One profile line, optionally broken into a Memobase-style sub_topic label +
 * content. `**子主题**: 内容` is the lightweight markdown convention (bold-then-
 * colon), matched after stripping an optional leading bullet marker (`- `) and
 * an optional `[YYYY-MM-DD]` dated tag (the format `appendUserProfileLine`
 * already writes) — so both cat-proposed and Owner-typed lines parse the same
 * way. Lines without the prefix (100% of pre-batch-3 storage) parse with
 * `subTopic: null, content: raw` — no forced migration, no data loss.
 */
export interface UserProfileSubTopicEntry {
  readonly subTopic: string | null;
  readonly content: string;
  readonly raw: string;
}

const SUB_TOPIC_LINE_RE = /^(?:[-*+]\s*)?(?:\[\d{4}-\d{2}-\d{2}\]\s*)?\*\*([^*]+)\*\*\s*[:：]\s*(.*)$/;

/**
 * Parse the optional `**子主题**: 内容` prefix out of one already-trimmed
 * profile line. Pure, exported for reuse (classifyUserProfileSection,
 * routes/user-profile.ts) and direct unit testing.
 */
export function parseUserProfileSubTopicLine(rawLine: string): UserProfileSubTopicEntry {
  const match = rawLine.match(SUB_TOPIC_LINE_RE);
  if (!match) return { subTopic: null, content: rawLine, raw: rawLine };
  const subTopic = (match[1] ?? '').trim();
  const content = (match[2] ?? '').trim();
  if (!subTopic) return { subTopic: null, content: rawLine, raw: rawLine };
  return { subTopic, content, raw: rawLine };
}

/**
 * Derive the sub_topic breakdown for all three sections from an already-split
 * `sections` map. Pure — reused by both `parseUserProfile` and the Owner
 * direct-edit route (`routes/user-profile.ts`), which rebuilds a
 * `ParsedUserProfile` from three edited textareas and must produce the same
 * `subTopics` shape without re-deriving this parsing rule.
 */
export function deriveUserProfileSubTopics(
  sections: ReadonlyMap<UserProfileSection, readonly string[]>,
): Map<UserProfileSection, UserProfileSubTopicEntry[]> {
  const subTopics = new Map<UserProfileSection, UserProfileSubTopicEntry[]>();
  for (const section of USER_PROFILE_SECTIONS) {
    const lines = sections.get(section) ?? [];
    subTopics.set(
      section,
      lines.map((line) => parseUserProfileSubTopicLine(line)),
    );
  }
  return subTopics;
}

/**
 * Exported (batch 3-H) so the Owner direct-edit route (`routes/user-profile.ts`)
 * can reuse the exact same section-splitting rules the promotion gate relies on,
 * instead of re-deriving heading-matching logic in the API layer.
 */
export function parseUserProfile(content: string): ParsedUserProfile {
  const sections = new Map<UserProfileSection, string[]>(USER_PROFILE_SECTIONS.map((s) => [s, []]));
  const trimmed = content.trim();
  if (!trimmed) return { title: '# 铲屎官画像', sections, subTopics: deriveUserProfileSubTopics(sections) };

  const lines = trimmed.split(/\r?\n/);
  const title = lines[0]?.startsWith('# ') ? lines[0] : '# 铲屎官画像';
  const bodyLines = lines[0]?.startsWith('# ') ? lines.slice(1) : lines;

  let current: UserProfileSection | null = null;
  for (const line of bodyLines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const heading = (headingMatch[1] ?? '').trim();
      current = (USER_PROFILE_SECTIONS.find((s) => heading.includes(s)) ?? null) as UserProfileSection | null;
      continue;
    }
    if (current && line.trim()) {
      sections.get(current)?.push(line.trim());
    }
  }
  return { title, sections, subTopics: deriveUserProfileSubTopics(sections) };
}

/**
 * Exported (batch 3-H) for the same reason as `parseUserProfile` — the Owner
 * direct-edit route rebuilds a `ParsedUserProfile` from three edited section
 * texts and renders it back to canonical markdown through this function,
 * rather than hand-rolling its own markdown assembly.
 */
export function renderUserProfile(parsed: ParsedUserProfile): string {
  const chunks = [parsed.title.trim()];
  for (const section of USER_PROFILE_SECTIONS) {
    chunks.push(`## ${section}`);
    const body = (parsed.sections.get(section) ?? []).join('\n');
    chunks.push(body);
  }
  const rendered = `${chunks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
  return rendered.length > USER_PROFILE_MAX_CHARS
    ? `${rendered.slice(0, USER_PROFILE_MAX_CHARS - 40)}\n\n[USER.md 内容过长，已截断]\n`
    : rendered;
}

const HARD_CONSTRAINT_RE = /硬约束|红线|禁止|不允许|不可|必须/;
const PREFERENCE_RE = /偏好|喜欢|风格|简短|简洁|详细|格式|语气|以后|默认/;

/**
 * Heuristic content → section classification, used only as a fallback when the
 * caller doesn't specify a target section explicitly. Same spirit as
 * AgentMemoryPromotionGate's classifyContent (deterministic, auditable).
 *
 * 批次 3 F-E: when the candidate text carries an explicit `**子主题**:` label,
 * that label is checked FIRST (it's a deliberate structured signal — e.g.
 * `**端口红线**: ...` should route to 硬约束 even if the body text alone
 * wouldn't match). Falls through to the original whole-text scan unchanged
 * when there's no sub_topic prefix (subTopic === null) or the label itself
 * doesn't match either regex — so all pre-existing behavior (and the batch-1
 * gold set, which exercises `evaluateMemoryPromotion`, not this function) is
 * untouched.
 */
export function classifyUserProfileSection(text: string): UserProfileSection {
  const { subTopic } = parseUserProfileSubTopicLine(text.trim());
  if (subTopic) {
    if (HARD_CONSTRAINT_RE.test(subTopic)) return '硬约束';
    if (PREFERENCE_RE.test(subTopic)) return '偏好';
  }
  if (HARD_CONSTRAINT_RE.test(text)) return '硬约束';
  if (PREFERENCE_RE.test(text)) return '偏好';
  return '账号级事实';
}

/**
 * Append one durable line to a section, deduping exact repeats. Pure function —
 * used by the promotion gate after a write is approved (fast-track or human
 * promotion), never called directly by a cat.
 *
 * 批次 3 F-E: `subTopic` is optional and additive — omitted (the only path
 * before batch 3, and still the default for existing callers) produces the
 * exact same `- [date] content` bullet as before. When provided, the line is
 * written as `- [date] **subTopic**: content`, which `parseUserProfileSubTopicLine`
 * round-trips back into `{ subTopic, content }` on the next read. No forced
 * migration — this only changes what NEW entries look like.
 */
export function appendUserProfileLine(
  existingContent: string,
  section: UserProfileSection,
  line: string,
  date: string,
  subTopic?: string,
): string {
  const parsed = parseUserProfile(existingContent);
  const entries = parsed.sections.get(section) ?? [];
  const normalized = line.trim();
  const trimmedSubTopic = subTopic?.trim();
  const bulletLine = trimmedSubTopic
    ? `- [${date}] **${trimmedSubTopic}**: ${normalized}`
    : `- [${date}] ${normalized}`;
  const already = entries.some((existing) => existing.includes(normalized));
  if (!already) entries.push(bulletLine);
  parsed.sections.set(section, entries);
  return renderUserProfile(parsed);
}

/**
 * Rough token estimate — same `chars / 4` convention as
 * `SystemPromptBuilder.roughTokenEstimate` (that module is injection-only and
 * intentionally untouched by batch 3-H, so this is a small, deliberate
 * duplication rather than an import across layers). Used by the Owner
 * direct-edit API to echo a `tokenEstimate` the web UI can compare against the
 * ≤1k-token injection budget (`USER_PROFILE_INDEX_MAX_TOKENS`).
 */
export function estimateUserProfileTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Low-level, atomic write. NOT exported for direct cat use — only
 * UserProfilePromotionGate (after an approved write) should call this, and
 * always through UserProfileWriteQueue so concurrent proposals serialize.
 */
export async function writeUserProfileAtomic(
  content: string,
  projectRoot = findMonorepoRoot(),
): Promise<UserProfileRecord> {
  const path = getUserProfilePath(projectRoot);
  await mkdir(getAgentMemoryDir(projectRoot), { recursive: true });
  await writeFileAtomically(path, content.endsWith('\n') ? content : `${content}\n`);
  return readUserProfile(projectRoot);
}
