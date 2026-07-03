import { existsSync } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const PROJECT_PROGRESS_MAX_CHARS = 12_000;
export const PROJECT_BRIEF_MAX_CHARS = 8_000;
export const PROJECT_DECISIONS_MAX_CHARS = 8_000;
export const PROJECT_HANDOFF_INDEX_MAX_CHARS = 6_000;

export interface ProjectProgressRecord {
  id: string;
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
}

function assertSafeProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid projectId "${projectId}"`);
  }
}

export function getProjectProgressDir(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'projects');
}

export function getProjectProgressPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'progress.md');
}

export function getProjectBriefPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'brief.md');
}

export function getProjectHandoffLogPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'handoff-log.md');
}

export function getProjectDecisionsPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'decisions.md');
}

export function getProjectHandoffIndexPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'handoff-index.md');
}

async function readProjectFile(
  projectId: string,
  path: string,
  maxChars: number,
  overflowLabel: string,
): Promise<ProjectProgressRecord> {
  if (!existsSync(path)) {
    return { id: projectId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > maxChars;
  return {
    id: projectId,
    path,
    content: truncated ? `${raw.slice(0, maxChars)}\n\n[${overflowLabel}内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

export async function readProjectBrief(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectBriefPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_BRIEF_MAX_CHARS, '项目简介');
}

export async function readProjectProgress(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectProgressPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_PROGRESS_MAX_CHARS, '项目进度');
}

export async function readProjectDecisions(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectDecisionsPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_DECISIONS_MAX_CHARS, '项目决策');
}

export async function readProjectHandoffIndex(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectHandoffIndexPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_HANDOFF_INDEX_MAX_CHARS, '交接索引');
}

export async function listProjectProgressIds(projectRoot = findMonorepoRoot()): Promise<string[]> {
  const dir = getProjectProgressDir(projectRoot);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function getConfiguredProjectProgressIds(): string[] {
  return (process.env.CAT_CAFE_PROJECT_CONTEXT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function readProjectProgressForPrompt(
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<string | null> {
  if (projectIds.length === 0) return null;

  try {
    const records = await Promise.all(
      projectIds.map(async (id) => ({
        id,
        brief: await readProjectBrief(id, projectRoot),
        progress: await readProjectProgress(id, projectRoot),
        decisions: await readProjectDecisions(id, projectRoot),
        handoffIndex: await readProjectHandoffIndex(id, projectRoot),
      })),
    );
    const blocks = records
      .filter(
        ({ brief, progress, decisions, handoffIndex }) =>
          (brief.exists && brief.content.trim()) ||
          (progress.exists && progress.content.trim()) ||
          (decisions.exists && decisions.content.trim()) ||
          (handoffIndex.exists && handoffIndex.content.trim()),
      )
      .map(({ id, brief, progress, decisions, handoffIndex }) => {
        const parts = [
          `<!-- project:${id} brief_path:${brief.path} progress_path:${progress.path} decisions_path:${decisions.path} handoff_index_path:${handoffIndex.path} -->`,
        ];
        if (brief.exists && brief.content.trim()) {
          parts.push('## 项目简介（brief.md）', brief.content.trim());
        }
        if (progress.exists && progress.content.trim()) {
          if (!brief.exists) {
            parts.push('⚠️ 项目状态：needs_brief（未找到 brief.md）');
          }
          parts.push('## 项目进度（progress.md）', progress.content.trim());
        }
        if (decisions.exists && decisions.content.trim()) {
          parts.push('## 项目决策（decisions.md）', decisions.content.trim());
        }
        if (handoffIndex.exists && handoffIndex.content.trim()) {
          parts.push(
            '## 交接索引（handoff-index.md）',
            '先读索引，只在当前任务命中模块、日期、关键词或风险点时再打开具体 handoff。',
            handoffIndex.content.trim(),
          );
        }
        return parts.join('\n');
      });

    return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null;
  } catch {
    return null;
  }
}

export interface ProjectHandoffLogEntry {
  timestamp: string;
  fromCatId: string;
  toCatId: string;
  status: string;
  summary?: string;
}

function singleLine(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function appendProjectHandoffLogForPromptProjects(
  entry: ProjectHandoffLogEntry,
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<number> {
  if (projectIds.length === 0) return 0;
  let appended = 0;
  for (const projectId of projectIds) {
    try {
      const path = getProjectHandoffLogPath(projectId, projectRoot);
      if (!existsSync(path)) continue;
      const summary = singleLine(entry.summary) || '未提供摘要';
      await appendFile(
        path,
        [
          '',
          '---',
          '',
          `## ${entry.timestamp}`,
          `- **from**: ${singleLine(entry.fromCatId) || 'unknown'}`,
          `- **to**: ${singleLine(entry.toCatId) || 'unknown'}`,
          `- **状态**: ${singleLine(entry.status) || 'unknown'}`,
          `- **摘要**: ${summary}`,
          '',
        ].join('\n'),
        'utf-8',
      );
      appended += 1;
    } catch {
      // Handoff log write is best-effort; invalid/missing project config must not break A2A.
    }
  }
  return appended;
}
