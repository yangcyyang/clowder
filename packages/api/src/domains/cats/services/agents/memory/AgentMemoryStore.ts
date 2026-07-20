import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const AGENT_MEMORY_MAX_CHARS = 24_000;

export interface AgentMemoryRecord {
  catId: string;
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
}

function assertSafeCatId(catId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(catId)) {
    throw new Error(`Invalid catId "${catId}"`);
  }
}

export function getAgentMemoryDir(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'memory');
}

export function getAgentMemoryPath(catId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeCatId(catId);
  return join(getAgentMemoryDir(projectRoot), `${catId}.md`);
}

export async function readAgentMemory(catId: string, projectRoot = findMonorepoRoot()): Promise<AgentMemoryRecord> {
  const path = getAgentMemoryPath(catId, projectRoot);
  if (!existsSync(path)) {
    return { catId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > AGENT_MEMORY_MAX_CHARS;
  return {
    catId,
    path,
    content: truncated ? `${raw.slice(0, AGENT_MEMORY_MAX_CHARS)}\n\n[Agent Memory 内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

export async function readAgentMemoryForPrompt(
  catId: string,
  projectRoot = findMonorepoRoot(),
): Promise<string | null> {
  try {
    const record = await readAgentMemory(catId, projectRoot);
    const content = record.content.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

export async function writeAgentMemory(
  catId: string,
  content: string,
  projectRoot = findMonorepoRoot(),
): Promise<AgentMemoryRecord> {
  const path = getAgentMemoryPath(catId, projectRoot);
  await mkdir(getAgentMemoryDir(projectRoot), { recursive: true });
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return readAgentMemory(catId, projectRoot);
}
