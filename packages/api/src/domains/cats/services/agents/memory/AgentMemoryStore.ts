import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

/**
 * 批次 2-D：猫记忆两层化约定（docs/research/clowder-raft-thread-task-design.md §5B.1）。
 *
 * 两层：
 *  - 索引层（本文件管理的 `.cat-cafe/memory/{catId}.md`，即 Raft 术语里的
 *    MEMORY.md）：Role / Key Knowledge 指针 / Active Context / Memories 链接。
 *    每次开工**全文注入**（SystemPromptBuilder.buildAgentMemoryLines 的 v2/index
 *    分支），预算 ≤4k tokens——超预算截断并提示猫自行整理，不做破坏性迁移。
 *  - notes 层（`.cat-cafe/memory/notes/{catId}/`）：专题速查细节文件，一条反馈/
 *    一次踩坑一个文件（建议带四分类 frontmatter，见 AgentMemoryPromotionGate.ts）。
 *    **不新增读取机制**——猫用已有的文件读取工具按需展开，不在 prompt 里全量注入。
 *
 * 存量迁移：现有单文件记忆自动视为"索引"。v1 注入路径（≤200 字摘要）字节冻结不动；
 * 只有 v2 路径（ADR-024 cacheLayout=v2 的 meta 槽）走全文索引注入。
 */
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

/**
 * notes/ 层目录：`.cat-cafe/memory/notes/{catId}/`.
 * Path convention only — no dedicated read API. Cats read notes files with
 * their existing file-read tool (no new mechanism per 批次 2-D 任务书).
 */
export function getAgentMemoryNotesDir(catId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeCatId(catId);
  return join(getAgentMemoryDir(projectRoot), 'notes', catId);
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
