import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const PROJECT_PROGRESS_MAX_CHARS = 12_000;
export const PROJECT_BRIEF_MAX_CHARS = 8_000;

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

export async function readProjectBrief(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectBriefPath(projectId, projectRoot);
  if (!existsSync(path)) {
    return { id: projectId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > PROJECT_BRIEF_MAX_CHARS;
  return {
    id: projectId,
    path,
    content: truncated ? `${raw.slice(0, PROJECT_BRIEF_MAX_CHARS)}\n\n[项目简介内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

export async function readProjectProgress(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectProgressPath(projectId, projectRoot);
  if (!existsSync(path)) {
    return { id: projectId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > PROJECT_PROGRESS_MAX_CHARS;
  return {
    id: projectId,
    path,
    content: truncated ? `${raw.slice(0, PROJECT_PROGRESS_MAX_CHARS)}\n\n[项目进度内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
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
      })),
    );
    const blocks = records
      .filter(
        ({ brief, progress }) => (brief.exists && brief.content.trim()) || (progress.exists && progress.content.trim()),
      )
      .map(({ id, brief, progress }) => {
        const parts = [`<!-- project:${id} brief_path:${brief.path} progress_path:${progress.path} -->`];
        if (brief.exists && brief.content.trim()) {
          parts.push('## 项目简介（brief.md）', brief.content.trim());
        }
        if (progress.exists && progress.content.trim()) {
          if (!brief.exists) {
            parts.push('⚠️ 项目状态：needs_brief（未找到 brief.md）');
          }
          parts.push('## 项目进度（progress.md）', progress.content.trim());
        }
        return parts.join('\n');
      });

    return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null;
  } catch {
    return null;
  }
}
