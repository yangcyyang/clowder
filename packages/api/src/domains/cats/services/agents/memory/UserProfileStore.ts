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
}

/**
 * Exported (batch 3-H) so the Owner direct-edit route (`routes/user-profile.ts`)
 * can reuse the exact same section-splitting rules the promotion gate relies on,
 * instead of re-deriving heading-matching logic in the API layer.
 */
export function parseUserProfile(content: string): ParsedUserProfile {
  const sections = new Map<UserProfileSection, string[]>(USER_PROFILE_SECTIONS.map((s) => [s, []]));
  const trimmed = content.trim();
  if (!trimmed) return { title: '# 铲屎官画像', sections };

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
  return { title, sections };
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
 */
export function classifyUserProfileSection(text: string): UserProfileSection {
  if (HARD_CONSTRAINT_RE.test(text)) return '硬约束';
  if (PREFERENCE_RE.test(text)) return '偏好';
  return '账号级事实';
}

/**
 * Append one durable line to a section, deduping exact repeats. Pure function —
 * used by the promotion gate after a write is approved (fast-track or human
 * promotion), never called directly by a cat.
 */
export function appendUserProfileLine(
  existingContent: string,
  section: UserProfileSection,
  line: string,
  date: string,
): string {
  const parsed = parseUserProfile(existingContent);
  const entries = parsed.sections.get(section) ?? [];
  const normalized = line.trim();
  const bulletLine = `- [${date}] ${normalized}`;
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
