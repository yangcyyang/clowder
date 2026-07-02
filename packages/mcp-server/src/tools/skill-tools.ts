/**
 * Skill Tools — 按需查询 skill 菜单和内容
 *
 * MCP server 不能静态 import API package 源码，否则会越过本包 rootDir。
 * 这里保留一份只读 catalog loader，读取同一份 skills-manifest.json。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const DEFAULT_SKILL_MANAGEMENT_DIR = '/Users/cy/Documents/03 life/AI design/产品项目/skill管理';
const DEFAULT_SKILL_MANIFEST_PATH = `${DEFAULT_SKILL_MANAGEMENT_DIR}/skills-manifest.json`;
const MAX_MENU_SKILLS = 35;
const MAX_MENU_DESCRIPTION_CHARS = 100;
const MAX_TRIGGERS_PER_SKILL = 5;
const MAX_SKILL_CONTENT_CHARS = 10_000;

type SkillManifest = {
  skills?: SkillManifestEntry[];
};

type SkillManifestEntry = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  source?: unknown;
  risk_level?: unknown;
  source_path?: unknown;
  clowder_available?: unknown;
};

type SkillRouterCatalogEntry = {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  riskLevel: string;
  sourcePath: string;
  relativePath: string;
  content: string;
};

let catalogCache:
  | {
      manifestPath: string;
      manifestMtimeMs: number;
      entries: SkillRouterCatalogEntry[];
    }
  | null = null;

export const listSkillsInputSchema = {
  query: z.string().optional().describe('可选的搜索关键词，过滤 skill 名称、描述或触发词'),
};

export const readSkillInputSchema = {
  name: z.string().describe('要查看的 skill 名称或 id'),
};

function resolveSkillManifestPath(): string {
  return process.env['CAT_CAFE_SKILL_MANIFEST_PATH'] || DEFAULT_SKILL_MANIFEST_PATH;
}

function findMonorepoRoot(): string {
  let dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'cat-cafe-skills'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return process.cwd();
}

function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

  const name = entry.name.trim();
  const description = typeof entry.description === 'string' ? flattenText(entry.description) : name;
  const triggers = Array.from(new Set([...toStringList(entry.triggers), name]))
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

function loadSkillCatalog(): SkillRouterCatalogEntry[] {
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

export async function handleListSkills(input: { query?: string | undefined }): Promise<{
  content: { type: 'text'; text: string }[];
}> {
  const catalog = loadSkillCatalog();
  const query = input.query?.toLowerCase().trim();

  let filtered = catalog;
  if (query) {
    filtered = catalog.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        entry.triggers.some((trigger) => trigger.toLowerCase().includes(query)),
    );
  }

  if (filtered.length === 0) {
    return {
      content: [{ type: 'text', text: query ? `没有匹配 "${query}" 的 skill` : '当前没有可用的 skill' }],
    };
  }

  const lines = filtered.map((entry) => {
    const triggers = entry.triggers.slice(0, 3).join(' / ');
    const description =
      entry.description.length > MAX_MENU_DESCRIPTION_CHARS
        ? `${entry.description.slice(0, MAX_MENU_DESCRIPTION_CHARS).trimEnd()}…`
        : entry.description;
    return `- **${entry.name}**: ${description}；triggers: ${triggers}`;
  });

  return {
    content: [
      {
        type: 'text',
        text: `## 可用 Skills（${filtered.length} 个）\n\n${lines.join('\n')}\n\n使用 \`cat_cafe_read_skill\` 查看具体 skill 内容。`,
      },
    ],
  };
}

export async function handleReadSkill(input: { name: string }): Promise<{
  content: { type: 'text'; text: string }[];
}> {
  const catalog = loadSkillCatalog();
  const name = input.name.trim().toLowerCase();

  const entry = catalog.find((candidate) => candidate.name.toLowerCase() === name || candidate.id.toLowerCase() === name);

  if (!entry) {
    const available = catalog.map((candidate) => candidate.name).join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `找不到 skill "${input.name}"。可用 skills: ${available}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: formatSkillForAgent(entry),
      },
    ],
  };
}

function formatSkillForAgent(entry: SkillRouterCatalogEntry): string {
  const content =
    entry.content.length <= MAX_SKILL_CONTENT_CHARS
      ? entry.content.trim()
      : `${entry.content.slice(0, MAX_SKILL_CONTENT_CHARS).trimEnd()}\n\n<!-- SKILL.md 已截断 -->`;

  return [
    `### SKILL: ${entry.name}`,
    `Source: ${entry.relativePath}`,
    '',
    '```markdown',
    content,
    '```',
  ].join('\n');
}

export const skillTools = [
  {
    name: 'cat_cafe_list_skills',
    description: '列出可用的 cat-cafe skills。可选关键词过滤。返回 skill 名称、描述和触发词。',
    inputSchema: listSkillsInputSchema,
    handler: handleListSkills,
  },
  {
    name: 'cat_cafe_read_skill',
    description: '查看指定 skill 的完整 SKILL.md 内容。传入 skill 名称。',
    inputSchema: readSkillInputSchema,
    handler: handleReadSkill,
  },
];
