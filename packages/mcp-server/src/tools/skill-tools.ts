/**
 * Skill Tools — 按需查询 skill 菜单和内容
 *
 * MCP server 不能静态 import API package 源码，否则会越过本包 rootDir。
 * 这里保留一份只读 catalog loader，读取同一份 skills-manifest.json。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const DEFAULT_SKILL_MANAGEMENT_DIR = resolve(homedir(), 'Documents/03 life/AI design/产品项目/skill管理');
const DEFAULT_SKILL_MANIFEST_PATH = `${DEFAULT_SKILL_MANAGEMENT_DIR}/skills-manifest.json`;
const MAX_MENU_SKILLS = 35;
const MAX_MENU_DESCRIPTION_CHARS = 100;
const MAX_TRIGGERS_PER_SKILL = 5;
const MAX_SKILL_CONTENT_CHARS = 10_000;
const DEFAULT_PERSONAL_SKILL_ROOTS = ['~/.claude/skills'];
const DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES = [
  'create-prd',
  'product-strategy',
  'business-model',
  'competitor-analysis',
  'competitive-battlecard',
  'customer-journey-map',
  'market-sizing',
  'pricing-strategy',
  'user-personas',
  'value-proposition',
  'design-review',
  'high-end-visual-design',
  'image-to-code',
  'opencli-usage',
  'opencli-browser',
  'gstack',
  'investigate',
  'qa',
  'review',
  'make-pdf',
];
const DEFAULT_PERSONAL_SKILL_INDEX_PATH = '.cat-cafe/personal-skills-index.json';

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

type RepoSkillManifest = {
  skills?: Record<string, RepoSkillManifestEntry>;
};

type RepoSkillManifestEntry = {
  description?: unknown;
  triggers?: unknown;
};

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
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
  source: 'cat-cafe' | 'personal';
  menuVisible: boolean;
};

type PersonalSkillIndex = {
  version?: unknown;
  skills?: PersonalSkillIndexEntry[];
};

type PersonalSkillIndexEntry = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  category?: unknown;
  sourcePath?: unknown;
  relativePath?: unknown;
  visible?: unknown;
};

let catalogCache: {
  cacheKey: string;
  entries: SkillRouterCatalogEntry[];
} | null = null;

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

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return [...fallback];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandTildePath(value: string, homeDir = homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return resolve(homeDir, value.slice(2));
  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function safeReadJson(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SkillManifest) : null;
  } catch {
    return null;
  }
}

function safeReadPersonalIndex(path: string): PersonalSkillIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const index = parsed as PersonalSkillIndex;
    if (index.version !== 1 || !Array.isArray(index.skills)) return null;
    return index;
  } catch {
    return null;
  }
}

function safeReadRepoManifest(path: string): RepoSkillManifest | null {
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RepoSkillManifest) : null;
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

function readSkillContent(sourcePath: string): string | null {
  if (!isSafeCatCafeSkillPath(sourcePath) || !existsSync(sourcePath)) return null;
  try {
    return readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }
}

function makeCatalogEntry(params: {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  riskLevel: string;
  sourcePath: string;
  content: string;
  source?: 'cat-cafe' | 'personal';
  menuVisible?: boolean;
}): SkillRouterCatalogEntry {
  return {
    ...params,
    relativePath: toRelativeRepoPath(params.sourcePath),
    source: params.source ?? 'cat-cafe',
    menuVisible: params.menuVisible ?? true,
  };
}

function skillTriggers(manifestTriggers: unknown, name: string): string[] {
  return Array.from(new Set([...toStringList(manifestTriggers), name].map((value) => value.trim()))).filter(Boolean);
}

function normalizeCatalogEntry(entry: SkillManifestEntry): SkillRouterCatalogEntry | null {
  if (entry.source !== 'cat-cafe' || entry.clowder_available === false) return null;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  if (typeof entry.source_path !== 'string' || !entry.source_path.trim()) return null;

  const sourcePath = resolve(entry.source_path);
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const name = entry.name.trim();
  const description = typeof entry.description === 'string' ? flattenText(entry.description) : name;

  return makeCatalogEntry({
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `cat-cafe:${name}`,
    name,
    description,
    triggers: skillTriggers(entry.triggers, name),
    riskLevel: typeof entry.risk_level === 'string' && entry.risk_level.trim() ? entry.risk_level.trim() : 'unknown',
    sourcePath,
    content,
  });
}

function normalizeRepoManifestEntry(name: string, entry: RepoSkillManifestEntry): SkillRouterCatalogEntry | null {
  if (!name.trim()) return null;

  const sourcePath = resolve(resolveRepoSkillRoot(), name, 'SKILL.md');
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const description = typeof entry.description === 'string' ? flattenText(entry.description) : name.trim();

  return makeCatalogEntry({
    id: `cat-cafe:${name.trim()}`,
    name: name.trim(),
    description,
    triggers: skillTriggers(entry.triggers, name),
    riskLevel: 'repo',
    sourcePath,
    content,
  });
}

function loadExternalManifestEntries(manifestPath: string): SkillRouterCatalogEntry[] {
  const manifest = safeReadJson(manifestPath);
  return (manifest?.skills ?? [])
    .map(normalizeCatalogEntry)
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function loadRepoManifestEntries(): SkillRouterCatalogEntry[] {
  const manifestPath = resolve(resolveRepoSkillRoot(), 'manifest.yaml');
  const manifest = safeReadRepoManifest(manifestPath);
  return Object.entries(manifest?.skills ?? {})
    .map(([name, entry]) => normalizeRepoManifestEntry(name, entry))
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function listExternalSkillDirs(): string[] {
  const externalRoot = resolve(resolveRepoSkillRoot(), 'external');
  try {
    return readdirSync(externalRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => resolve(externalRoot, entry.name))
      .filter((dirPath) => existsSync(resolve(dirPath, 'SKILL.md')));
  } catch {
    return [];
  }
}

function normalizeExternalSkillEntry(sourcePath: string): SkillRouterCatalogEntry | null {
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const frontmatter = parseSkillFrontmatter(content);
  const dirName = dirname(sourcePath).split('/').pop() ?? '';
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : dirName;

  return makeCatalogEntry({
    id: `external:${name}`,
    name,
    description: typeof frontmatter.description === 'string' ? flattenText(frontmatter.description) : name,
    triggers: skillTriggers(frontmatter.triggers, name),
    riskLevel: 'external',
    sourcePath,
    content,
    // External skills remain discoverable by name/trigger, without flooding the default menu.
    menuVisible: false,
  });
}

function loadExternalSkillDirectoryEntries(): SkillRouterCatalogEntry[] {
  return listExternalSkillDirs()
    .map((dirPath) => normalizeExternalSkillEntry(resolve(dirPath, 'SKILL.md')))
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function resolvePersonalIndexPath(): string {
  const raw = process.env['CAT_CAFE_PERSONAL_SKILL_INDEX_PATH']?.trim() || DEFAULT_PERSONAL_SKILL_INDEX_PATH;
  const expanded = expandTildePath(raw, process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(findMonorepoRoot(), expanded);
}

function resolvePersonalRoots(): string[] {
  const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir();
  return splitCsv(process.env['CAT_CAFE_PERSONAL_SKILL_ROOTS'], DEFAULT_PERSONAL_SKILL_ROOTS).map((root) =>
    resolve(expandTildePath(root, homeDir)),
  );
}

function fileFingerprint(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.mtimeNs.toString()}:${stats.size.toString()}`;
  } catch {
    return '0:0';
  }
}

function externalSkillDirFingerprint(): string {
  return listExternalSkillDirs()
    .map((dirPath) => `${dirPath}:${fileFingerprint(resolve(dirPath, 'SKILL.md'))}`)
    .sort()
    .join('|');
}

function skillCatalogCacheKey(manifestPath: string, repoManifestPath: string): string {
  const personalEnabled = isTruthyEnv(process.env['CAT_CAFE_PERSONAL_SKILLS_ENABLED']);
  const personalIndexPath = resolvePersonalIndexPath();
  return JSON.stringify({
    manifestPath,
    manifest: fileFingerprint(manifestPath),
    repoManifestPath,
    repoManifest: fileFingerprint(repoManifestPath),
    personalEnabled,
    personalIndexPath,
    personalIndex: personalEnabled ? fileFingerprint(personalIndexPath) : 'disabled',
    personalRoots: resolvePersonalRoots(),
    personalVisibleNames: splitCsv(
      process.env['CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES'],
      DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES,
    ).sort(),
    externalSkillDir: externalSkillDirFingerprint(),
  });
}

function normalizePersonalIndexEntry(entry: PersonalSkillIndexEntry): SkillRouterCatalogEntry | null {
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  const name = entry.name.trim();
  const sourcePath = typeof entry.sourcePath === 'string' && entry.sourcePath.trim() ? resolve(entry.sourcePath) : '';
  const relativePath =
    typeof entry.relativePath === 'string' && entry.relativePath.trim() ? entry.relativePath.trim() : sourcePath;
  const description = typeof entry.description === 'string' ? flattenText(entry.description) : name;
  const category = typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim() : 'personal';

  return {
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `personal:${name}`,
    name,
    description,
    triggers: skillTriggers(entry.triggers, name),
    riskLevel: category,
    sourcePath,
    relativePath,
    content: '',
    source: 'personal',
    menuVisible: entry.visible === true,
  };
}

function loadPersonalIndexEntries(): SkillRouterCatalogEntry[] {
  if (!isTruthyEnv(process.env['CAT_CAFE_PERSONAL_SKILLS_ENABLED'])) return [];
  const index = safeReadPersonalIndex(resolvePersonalIndexPath());
  return (index?.skills ?? [])
    .map(normalizePersonalIndexEntry)
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function mergeSkillEntries(entries: SkillRouterCatalogEntry[]): SkillRouterCatalogEntry[] {
  const byName = new Map<string, SkillRouterCatalogEntry>();
  for (const entry of entries) {
    byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function loadSkillCatalog(): SkillRouterCatalogEntry[] {
  const manifestPath = resolveSkillManifestPath();
  const repoManifestPath = resolve(resolveRepoSkillRoot(), 'manifest.yaml');
  const cacheKey = skillCatalogCacheKey(manifestPath, repoManifestPath);

  if (catalogCache?.cacheKey === cacheKey) {
    return catalogCache.entries;
  }

  const entries = mergeSkillEntries([
    // External links are lowest priority: they must not shadow personal or native skills.
    ...loadExternalSkillDirectoryEntries(),
    ...loadPersonalIndexEntries(),
    ...loadExternalManifestEntries(manifestPath),
    ...loadRepoManifestEntries(),
  ]);
  catalogCache = { cacheKey, entries };
  return entries;
}

function matchesQuery(entry: SkillRouterCatalogEntry, query: string): boolean {
  return (
    entry.name.toLowerCase().includes(query) ||
    entry.description.toLowerCase().includes(query) ||
    entry.triggers.some((trigger) => trigger.toLowerCase().includes(query))
  );
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readPersonalSkillContent(entry: SkillRouterCatalogEntry): string | null {
  if (!entry.sourcePath || !entry.sourcePath.endsWith('/SKILL.md')) return null;
  try {
    const sourceRealPath = realpathSync(entry.sourcePath);
    const roots = resolvePersonalRoots().map((root) => realpathSync(root));
    if (!roots.some((root) => isInsideRoot(root, sourceRealPath))) return null;
    return readFileSync(sourceRealPath, 'utf8');
  } catch {
    return null;
  }
}

export async function handleListSkills(input: { query?: string | undefined }): Promise<{
  content: { type: 'text'; text: string }[];
}> {
  const catalog = loadSkillCatalog();
  const query = input.query?.toLowerCase().trim();

  let filtered = query ? catalog : catalog.filter((entry) => entry.menuVisible);
  if (query) {
    filtered = catalog.filter((entry) => matchesQuery(entry, query));
  }
  filtered = filtered.slice(0, MAX_MENU_SKILLS);

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
    const source = entry.source === 'personal' ? 'personal；' : '';
    return `- **${entry.name}**: ${source}${description}；triggers: ${triggers}`;
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

  const entry = catalog.find(
    (candidate) => candidate.name.toLowerCase() === name || candidate.id.toLowerCase() === name,
  );

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

  const content = entry.source === 'personal' ? readPersonalSkillContent(entry) : entry.content;
  if (!content) {
    return {
      content: [
        {
          type: 'text',
          text:
            entry.source === 'personal'
              ? `找不到 skill "${input.name}"，或其路径不在 configured personal skill roots 内。`
              : `找不到 skill "${input.name}" 的内容。`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: formatSkillForAgent({ ...entry, content }),
      },
    ],
  };
}

function formatSkillForAgent(entry: SkillRouterCatalogEntry): string {
  const content =
    entry.content.length <= MAX_SKILL_CONTENT_CHARS
      ? entry.content.trim()
      : `${entry.content.slice(0, MAX_SKILL_CONTENT_CHARS).trimEnd()}\n\n<!-- SKILL.md 已截断 -->`;

  return [`### SKILL: ${entry.name}`, `Source: ${entry.relativePath}`, '', '```markdown', content, '```'].join('\n');
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
