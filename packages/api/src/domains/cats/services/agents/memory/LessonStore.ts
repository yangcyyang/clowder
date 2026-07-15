import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const LESSONS_MAX_CHARS = 12_000;

export interface LessonsRecord {
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
}

export function getLessonsPath(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'LESSONS.md');
}

export async function readLessons(projectRoot = findMonorepoRoot()): Promise<LessonsRecord> {
  const path = getLessonsPath(projectRoot);
  if (!existsSync(path)) {
    return { path, content: '', exists: false, truncated: false };
  }

  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > LESSONS_MAX_CHARS;
  return {
    path,
    content: truncated ? `${raw.slice(0, LESSONS_MAX_CHARS)}\n\n[LESSONS.md 内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

export async function readLessonsForPrompt(projectRoot = findMonorepoRoot()): Promise<string | null> {
  try {
    const record = await readLessons(projectRoot);
    const content = record.content.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}
