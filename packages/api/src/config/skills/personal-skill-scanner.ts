import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const DEFAULT_PERSONAL_SKILL_ROOTS = ['~/.claude/skills'];

export const DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES = [
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

export const DEFAULT_PERSONAL_SKILL_INDEX_PATH = '.cat-cafe/personal-skills-index.json';

export const DEFAULT_IGNORED_SEGMENTS = new Set([
  '.agents',
  '.cursor',
  '.factory',
  '.gbrain',
  '.hermes',
  '.kiro',
  '.openclaw',
  '.opencode',
  '.slate',
]);

export interface PersonalSkillIndex {
  version: 1;
  generatedAt: string;
  roots: string[];
  ignoredGlobs: string[];
  visibleNames: string[];
  skills: PersonalSkillIndexEntry[];
  duplicates: PersonalSkillDuplicate[];
  ignoredPaths: string[];
}

export interface PersonalSkillIndexEntry {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  category: string;
  source: 'personal';
  sourcePath: string;
  relativePath: string;
  visible: boolean;
  contentHash: string;
}

export interface PersonalSkillDuplicate {
  name: string;
  keptPath: string;
  skippedPaths: string[];
}

export interface BuildPersonalSkillIndexOptions {
  roots: string[];
  visibleNames?: string[];
  visibleAll?: boolean;
  homeDir?: string;
  ignoredSegments?: Set<string>;
  now?: Date;
}

export interface RebuildPersonalSkillIndexResult {
  enabled: boolean;
  total: number;
  visible: number;
  duplicates: number;
  ignoredHiddenDirs: number;
  indexPath: string;
}

interface CandidateSkill {
  rootRealPath: string;
  sourcePath: string;
  relativePath: string;
  priority: number;
  rootOrder: number;
}

interface ParsedSkillMeta {
  name: string;
  description: string;
  triggers: string[];
  category: string;
}

export function expandTildePath(value: string, homeDir = homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return [...fallback];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPersonalSkillsEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function isPersonalSkillVisibleAllEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isInsideRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosixPath(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

function isIgnoredSegment(name: string, ignoredSegments: Set<string>): boolean {
  return name.startsWith('.') || ignoredSegments.has(name);
}

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function maybePushSkillCandidate(
  candidates: CandidateSkill[],
  rootRealPath: string,
  relativePath: string,
  rootOrder: number,
  priority: number,
): Promise<void> {
  const sourcePath = join(rootRealPath, relativePath);
  const sourceRealPath = await safeRealpath(sourcePath);
  if (!sourceRealPath || !isInsideRoot(rootRealPath, sourceRealPath)) return;
  candidates.push({
    rootRealPath,
    sourcePath: sourceRealPath,
    relativePath: toPosixPath(relativePath),
    priority,
    rootOrder,
  });
}

async function listEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectSkillEntryCandidates(params: {
  candidates: CandidateSkill[];
  entries: Awaited<ReturnType<typeof listEntries>>;
  rootRealPath: string;
  rootOrder: number;
  ignoredSegments: Set<string>;
  ignoredPaths: string[];
  baseRelativePath?: string;
  priority: number;
}): Promise<void> {
  const sortedEntries = [...params.entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sortedEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === 'gstack' && !params.baseRelativePath) continue;

    const relativeDir = params.baseRelativePath ? `${params.baseRelativePath}/${entry.name}` : entry.name;
    if (isIgnoredSegment(entry.name, params.ignoredSegments)) {
      params.ignoredPaths.push(relativeDir);
      continue;
    }

    await maybePushSkillCandidate(
      params.candidates,
      params.rootRealPath,
      join(relativeDir, 'SKILL.md'),
      params.rootOrder,
      params.priority,
    );
  }
}

async function collectCandidates(
  rootRealPath: string,
  rootOrder: number,
  ignoredSegments: Set<string>,
  ignoredPaths: string[],
): Promise<CandidateSkill[]> {
  const candidates: CandidateSkill[] = [];
  await collectSkillEntryCandidates({
    candidates,
    entries: await listEntries(rootRealPath),
    rootRealPath,
    rootOrder,
    ignoredSegments,
    ignoredPaths,
    priority: 0,
  });

  const gstackPath = join(rootRealPath, 'gstack');
  const gstackRealPath = await safeRealpath(gstackPath);
  if (!gstackRealPath || !isInsideRoot(rootRealPath, gstackRealPath)) return candidates;

  await collectSkillEntryCandidates({
    candidates,
    entries: await listEntries(gstackRealPath),
    rootRealPath,
    rootOrder,
    ignoredSegments,
    ignoredPaths,
    baseRelativePath: 'gstack',
    priority: 1,
  });

  return candidates;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseSkillMeta(content: string, relativePath: string): ParsedSkillMeta {
  const frontmatter = parseFrontmatter(content);
  const fallbackName = relativePath.split('/').at(-2) ?? relativePath.replace(/\/SKILL\.md$/, '');
  const rawName = frontmatter.name;
  const rawDescription = frontmatter.description;
  const rawCategory = frontmatter.category;
  const rawTriggers = frontmatter.triggers;

  const triggers = Array.isArray(rawTriggers)
    ? rawTriggers
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : typeof rawTriggers === 'string' && rawTriggers.trim()
      ? [rawTriggers.trim()]
      : [];

  return {
    name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallbackName,
    description: typeof rawDescription === 'string' ? rawDescription.trim() : '',
    triggers,
    category: typeof rawCategory === 'string' && rawCategory.trim() ? rawCategory.trim() : 'personal',
  };
}

function toContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function readCandidate(
  candidate: CandidateSkill,
  visibleNames: Set<string>,
  visibleAll: boolean,
): Promise<PersonalSkillIndexEntry | null> {
  const sourceRealPath = await safeRealpath(candidate.sourcePath);
  if (!sourceRealPath || !isInsideRoot(candidate.rootRealPath, sourceRealPath)) return null;

  try {
    const content = await readFile(sourceRealPath, 'utf-8');
    const meta = parseSkillMeta(content, candidate.relativePath);
    return {
      id: `personal:${meta.name}`,
      name: meta.name,
      description: meta.description,
      triggers: meta.triggers,
      category: meta.category,
      source: 'personal',
      sourcePath: sourceRealPath,
      relativePath: candidate.relativePath,
      visible: visibleAll || visibleNames.has(meta.name),
      contentHash: toContentHash(content),
    };
  } catch {
    return null;
  }
}

export async function buildPersonalSkillIndex(options: BuildPersonalSkillIndexOptions): Promise<PersonalSkillIndex> {
  const homeDir = options.homeDir ?? homedir();
  const ignoredSegments = options.ignoredSegments ?? DEFAULT_IGNORED_SEGMENTS;
  const visibleNames = new Set(options.visibleNames ?? DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES);
  const visibleAll = options.visibleAll ?? false;
  const roots: string[] = [];
  const ignoredPaths: string[] = [];
  const candidates: CandidateSkill[] = [];

  for (const [rootOrder, rawRoot] of options.roots.entries()) {
    const rootPath = resolve(expandTildePath(rawRoot, homeDir));
    const rootRealPath = await safeRealpath(rootPath);
    if (!rootRealPath) continue;
    roots.push(rootRealPath);
    candidates.push(...(await collectCandidates(rootRealPath, rootOrder, ignoredSegments, ignoredPaths)));
  }

  candidates.sort((a, b) => {
    if (a.rootOrder !== b.rootOrder) return a.rootOrder - b.rootOrder;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.relativePath.localeCompare(b.relativePath);
  });

  const byName = new Map<string, PersonalSkillIndexEntry>();
  const duplicatesByName = new Map<string, PersonalSkillDuplicate>();

  for (const candidate of candidates) {
    const entry = await readCandidate(candidate, visibleNames, visibleAll);
    if (!entry) continue;

    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }

    const duplicate = duplicatesByName.get(entry.name) ?? {
      name: entry.name,
      keptPath: existing.relativePath,
      skippedPaths: [],
    };
    duplicate.skippedPaths.push(entry.relativePath);
    duplicatesByName.set(entry.name, duplicate);
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const duplicates = [...duplicatesByName.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    roots,
    ignoredGlobs: [...ignoredSegments].sort(),
    visibleNames: [...visibleNames].sort(),
    skills,
    duplicates,
    ignoredPaths: [...new Set(ignoredPaths.map(toPosixPath))].sort(),
  };
}

export function resolvePersonalSkillIndexPath(
  projectRoot: string,
  rawIndexPath: string | undefined,
  homeDir: string,
): string {
  const indexPath = expandTildePath(rawIndexPath?.trim() || DEFAULT_PERSONAL_SKILL_INDEX_PATH, homeDir);
  return isAbsolute(indexPath) ? resolve(indexPath) : resolve(projectRoot, indexPath);
}

export async function readPersonalSkillIndexFromEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ enabled: boolean; indexPath: string; index: PersonalSkillIndex | null }> {
  const homeDir = env.HOME ?? env.USERPROFILE ?? homedir();
  const indexPath = resolvePersonalSkillIndexPath(projectRoot, env.CAT_CAFE_PERSONAL_SKILL_INDEX_PATH, homeDir);
  const enabled = isPersonalSkillsEnabled(env.CAT_CAFE_PERSONAL_SKILLS_ENABLED);
  if (!enabled) return { enabled, indexPath, index: null };

  try {
    const raw = await readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersonalSkillIndex> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
      return { enabled, indexPath, index: null };
    }
    return { enabled, indexPath, index: parsed as PersonalSkillIndex };
  } catch {
    return { enabled, indexPath, index: null };
  }
}

export async function rebuildPersonalSkillIndexFromEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RebuildPersonalSkillIndexResult> {
  const homeDir = env.HOME ?? env.USERPROFILE ?? homedir();
  const indexPath = resolvePersonalSkillIndexPath(projectRoot, env.CAT_CAFE_PERSONAL_SKILL_INDEX_PATH, homeDir);
  const enabled = isPersonalSkillsEnabled(env.CAT_CAFE_PERSONAL_SKILLS_ENABLED);

  if (!enabled) {
    return {
      enabled: false,
      total: 0,
      visible: 0,
      duplicates: 0,
      ignoredHiddenDirs: 0,
      indexPath,
    };
  }

  const roots = splitCsv(env.CAT_CAFE_PERSONAL_SKILL_ROOTS, DEFAULT_PERSONAL_SKILL_ROOTS);
  const visibleNames = splitCsv(env.CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES, DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES);
  const visibleAll = isPersonalSkillVisibleAllEnabled(env.CAT_CAFE_PERSONAL_SKILL_VISIBLE_ALL);
  const index = await buildPersonalSkillIndex({ roots, visibleNames, visibleAll, homeDir });

  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');

  return {
    enabled: true,
    total: index.skills.length,
    visible: index.skills.filter((skill) => skill.visible).length,
    duplicates: index.duplicates.length,
    ignoredHiddenDirs: index.ignoredPaths.length,
    indexPath,
  };
}
