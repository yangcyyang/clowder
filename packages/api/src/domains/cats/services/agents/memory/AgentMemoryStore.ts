import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import {
  isMemoryFrontmatterExpired,
  parseMemoryFrontmatter,
  type MemoryFrontmatterType,
} from './AgentMemoryPromotionGate.js';

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

// ---------------------------------------------------------------------------
// F-D（批次 3，PRD-memory-upgrade.md）：notes/ 召回排序——最小版
// ---------------------------------------------------------------------------

/**
 * 一条 notes/ 文件的摘要——文件名 + frontmatter 摘要，不是全文。
 * 用于让猫知道"自己有哪些笔记可以用文件读取工具展开"，而不是把 notes/ 全量
 * 注入 prompt（absorption doc 明确警告小语料别过度设计，见
 * docs/research/memory-absorption.md §2 第 2 条）。
 */
export interface AgentMemoryNoteSummary {
  /** File name only (relative to the notes/{catId}/ dir), e.g. "port-gotcha.md". */
  readonly fileName: string;
  readonly type?: MemoryFrontmatterType;
  readonly why?: string;
  /** File mtime (ms since epoch) — drives the "most-recently-modified first" order. */
  readonly mtimeMs: number;
}

/** 清单上限（PRD F-D 原文："清单上限 10 条"）。 */
export const AGENT_MEMORY_NOTES_LIST_MAX_ITEMS = 10;

/**
 * 列举某只猫 notes/ 目录下的文件名 + frontmatter 摘要（type/why/最近修改时
 * 间），过滤已过期条目，按最近修改时间倒序，最多 AGENT_MEMORY_NOTES_LIST_MAX_ITEMS
 * 条。**不做向量化/相似度排序**——本期明确不做（PRD F-D："本期只做...评测尺
 * 显示需要时再说"）。
 *
 * 复用批次 2 已验证的 parseMemoryFrontmatter/isMemoryFrontmatterExpired
 * （AgentMemoryPromotionGate.ts），不新写 frontmatter 解析或过期判定逻辑。
 * 同步实现（readdirSync/statSync/readFileSync）：唯一的生产调用点
 * （SystemPromptBuilder.buildAgentMemoryIndexLines）本身是同步函数，这里保持
 * 一致，避免为了这一个轻量列举函数把 buildTurnMetaBlock 整条调用链改成异步。
 *
 * notes/ 目录不存在（当前生产现状——批次 2-D 之前从未有过写入机制）时返回
 * `[]`，不抛错——这是本函数唯一的"零机制"降级路径。
 */
export function listAgentMemoryNotes(
  catId: string,
  projectRoot = findMonorepoRoot(),
  referenceMs: number = Date.now(),
): AgentMemoryNoteSummary[] {
  const dir = getAgentMemoryNotesDir(catId, projectRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const summaries: AgentMemoryNoteSummary[] = [];
  for (const fileName of entries) {
    const filePath = join(dir, fileName);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter } = parseMemoryFrontmatter(raw);
    if (isMemoryFrontmatterExpired(frontmatter, referenceMs)) continue;

    summaries.push({
      fileName,
      ...(frontmatter?.type ? { type: frontmatter.type } : {}),
      ...(frontmatter?.why ? { why: frontmatter.why } : {}),
      mtimeMs: stat.mtimeMs,
    });
  }

  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return summaries.slice(0, AGENT_MEMORY_NOTES_LIST_MAX_ITEMS);
}
