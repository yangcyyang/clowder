import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

const DEFAULT_SKILL_MANAGEMENT_DIR = '/Users/cy/Documents/03 life/AI design/产品项目/skill管理';
const DEFAULT_SKILL_MANIFEST_PATH = `${DEFAULT_SKILL_MANAGEMENT_DIR}/skills-manifest.json`;
const MAX_MENU_SKILLS = 35;
const MAX_MENU_DESCRIPTION_CHARS = 120;
const MAX_TRIGGERS_PER_SKILL = 5;
const MAX_MATCHED_SKILLS = 2;
const MAX_SKILL_CONTENT_CHARS = 10_000;

interface SkillManifest {
  skills?: SkillManifestEntry[];
}

interface SkillManifestEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  source?: unknown;
  risk_level?: unknown;
  source_path?: unknown;
  clowder_available?: unknown;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
}

interface SkillRouterCatalogEntry {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  riskLevel: string;
  sourcePath: string;
  relativePath: string;
  content: string;
}

export interface SkillRouterContext {
  promptBlock: string;
  matchedSkillNames: string[];
  menuSkillCount: number;
}

let catalogCache:
  | {
      manifestPath: string;
      manifestMtimeMs: number;
      entries: SkillRouterCatalogEntry[];
    }
  | null = null;

function resolveSkillManifestPath(): string {
  return process.env.CAT_CAFE_SKILL_MANIFEST_PATH || DEFAULT_SKILL_MANIFEST_PATH;
}

function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = flattenText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function safeReadJson(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SkillManifest) : null;
  } catch {
    return null;
  }
}

function resolveRepoSkillRoot(): string {
  return resolve(findMonorepoRoot(), 'cat-cafe-skills');
}

function isSafeCatCafeSkillPath(path: string): boolean {
  const resolvedPath = resolve(path);
  const skillRoot = resolveRepoSkillRoot();
  return resolvedPath.startsWith(`${skillRoot}/`) && resolvedPath.endsWith('/SKILL.md');
}

function toRelativeRepoPath(path: string): string {
  const root = findMonorepoRoot();
  const resolvedPath = resolve(path);
  return resolvedPath.startsWith(`${root}/`) ? resolvedPath.slice(root.length + 1) : resolvedPath;
}

function normalizeCatalogEntry(entry: SkillManifestEntry): SkillRouterCatalogEntry | null {
  if (entry.source !== 'cat-cafe') return null;
  if (entry.clowder_available === false) return null;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  if (typeof entry.source_path !== 'string' || !entry.source_path.trim()) return null;

  const sourcePath = resolve(entry.source_path);
  if (!isSafeCatCafeSkillPath(sourcePath) || !existsSync(sourcePath)) return null;

  let content: string;
  try {
    content = readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }

  const frontmatter = parseSkillFrontmatter(content);
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : entry.name.trim();
  const frontmatterDescription =
    typeof frontmatter.description === 'string' ? flattenText(frontmatter.description) : '';
  const manifestDescription =
    typeof entry.description === 'string' && entry.description.trim() !== '>' ? flattenText(entry.description) : '';
  const description = frontmatterDescription || manifestDescription || name;
  const triggers = Array.from(
    new Set([...toStringList(frontmatter.triggers), ...toStringList(entry.triggers), name].map((value) => value.trim())),
  )
    .filter(Boolean)
    .slice(0, MAX_TRIGGERS_PER_SKILL);

  return {
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `cat-cafe:${name}`,
    name,
    description,
    triggers,
    riskLevel: typeof entry.risk_level === 'string' && entry.risk_level.trim() ? entry.risk_level.trim() : 'unknown',
    sourcePath,
    relativePath: toRelativeRepoPath(sourcePath),
    content,
  };
}

export function loadSkillRouterCatalog(): SkillRouterCatalogEntry[] {
  const manifestPath = resolveSkillManifestPath();
  try {
    const manifestMtimeMs = statSync(manifestPath).mtimeMs;
    if (catalogCache?.manifestPath === manifestPath && catalogCache.manifestMtimeMs === manifestMtimeMs) {
      return catalogCache.entries;
    }

    const manifest = safeReadJson(manifestPath);
    const entries = (manifest?.skills ?? [])
      .map(normalizeCatalogEntry)
      .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, MAX_MENU_SKILLS);

    catalogCache = { manifestPath, manifestMtimeMs, entries };
    return entries;
  } catch {
    catalogCache = null;
    return [];
  }
}

function scoreSkillMatch(message: string, skill: SkillRouterCatalogEntry): number {
  const normalizedMessage = message.toLocaleLowerCase();
  let score = 0;
  for (const trigger of skill.triggers) {
    const normalizedTrigger = trigger.toLocaleLowerCase();
    if (normalizedTrigger.length < 2) continue;
    if (normalizedMessage.includes(normalizedTrigger)) {
      score += normalizedTrigger.length >= 4 ? 3 : 2;
    }
  }
  const normalizedName = skill.name.toLocaleLowerCase();
  if (normalizedMessage.includes(normalizedName)) score += 4;
  return score;
}

function matchSkills(userMessageText: string, skills: SkillRouterCatalogEntry[]): SkillRouterCatalogEntry[] {
  const message = userMessageText.trim();
  if (!message) return [];
  return skills
    .map((skill) => ({ skill, score: scoreSkillMatch(message, skill) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name, 'zh-Hans-CN'))
    .slice(0, MAX_MATCHED_SKILLS)
    .map((item) => item.skill);
}

function buildMenuLines(skills: SkillRouterCatalogEntry[]): string[] {
  return skills.map((skill) => {
    const triggers = skill.triggers.slice(0, MAX_TRIGGERS_PER_SKILL).join(' / ');
    const description = truncateText(skill.description, MAX_MENU_DESCRIPTION_CHARS);
    return `- ${skill.name}: ${description}；triggers: ${triggers}`;
  });
}

function formatSkillContent(skill: SkillRouterCatalogEntry): string {
  const content =
    skill.content.length <= MAX_SKILL_CONTENT_CHARS
      ? skill.content.trim()
      : `${skill.content.slice(0, MAX_SKILL_CONTENT_CHARS).trimEnd()}\n\n<!-- SKILL.md 已按上下文预算截断 -->`;
  return [
    `### SKILL: ${skill.name}`,
    `Source: ${skill.relativePath}`,
    '',
    '```markdown',
    content,
    '```',
  ].join('\n');
}

export function resolveSkillRouterContext(userMessageText: string | undefined): SkillRouterContext | null {
  const skills = loadSkillRouterCatalog();
  if (skills.length === 0) return null;

  const matchedSkills = matchSkills(userMessageText ?? '', skills);
  const lines = [
    '## Skill Router（可用 Skill 菜单）',
    '你可以在任务相关时使用下列 cat-cafe skills。先看用户任务是否命中 triggers；命中后优先遵循对应 SKILL.md，但不要为了使用而使用。',
    ...buildMenuLines(skills),
  ];

  if (matchedSkills.length > 0) {
    lines.push(
      '',
      '## Skill Router 命中',
      `本轮根据用户消息命中 skill: ${matchedSkills.map((skill) => skill.name).join(', ')}`,
      '请先按命中的 SKILL.md 执行；如果 skill 与用户明确要求冲突，以用户要求和安全边界为准。',
      '',
      ...matchedSkills.map(formatSkillContent),
    );
  }

  return {
    promptBlock: lines.join('\n'),
    matchedSkillNames: matchedSkills.map((skill) => skill.name),
    menuSkillCount: skills.length,
  };
}
