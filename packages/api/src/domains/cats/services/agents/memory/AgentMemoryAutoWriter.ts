import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { AGENT_MEMORY_MAX_CHARS, getAgentMemoryDir, getAgentMemoryPath } from './AgentMemoryStore.js';
import {
  appendMemoryCandidate,
  evaluateMemoryPromotion,
  listMemoryCandidates,
  recordPromotionDecision,
  resolveMemoryPromotionMode,
  type MemoryPromotionEvaluation,
} from './AgentMemoryPromotionGate.js';

export const MEMORY_AUTO_WRITE_MIN_INTERVAL_MS = 60_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_RECENT_VALIDATION_ITEMS = 20;

const gateLog = createModuleLogger('agent-memory-auto-writer');

const lastWriteAtByMemoryPath = new Map<string, number>();
const writeLockByMemoryPath = new Map<string, Promise<void>>();
let tempFileSequence = 0;
let candidateSequence = 0;

export interface AgentMemoryInvocationSummary {
  catId: string;
  invocationId: string;
  threadId: string;
  currentUserMessageId?: string | undefined;
  assistantText?: string | undefined;
  error?: string | undefined;
  completedAt?: number | undefined;
  /** Raw user message text (when available) — grounds user-stated source grading. */
  userMessageText?: string | undefined;
}

export interface AgentMemoryAutoWriteResult {
  status: 'updated' | 'skipped' | 'held';
  reason?:
    | 'rate_limited'
    | 'empty_summary'
    | 'write_disabled'
    | 'duplicate'
    | 'low_confidence'
    | 'session_temp'
    | 'pending_review'
    | 'conflict_hold';
  path?: string;
  content?: string;
  /** 票C: attached in shadow/enforce modes — the gate's decision for this write. */
  evaluation?: MemoryPromotionEvaluation;
}

export interface AgentMemoryAutoWriterOptions {
  projectRoot?: string;
  now?: () => number;
  minIntervalMs?: number;
  force?: boolean;
}

interface ParsedMemory {
  title: string;
  sections: { heading: string; body: string }[];
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function trimOneLine(input: string, maxChars: number): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>]/g, '')
    .trim()
    .slice(0, maxChars);
}

function buildInvocationSummary(summary: AgentMemoryInvocationSummary): string {
  const text = trimOneLine(summary.assistantText ?? '', MAX_SUMMARY_CHARS);
  if (!text) return '';
  const taskHint = summary.currentUserMessageId
    ? `message ${summary.currentUserMessageId}`
    : `thread ${summary.threadId}`;
  return `${taskHint} / invocation ${summary.invocationId}: ${text}`;
}

function parseMemory(content: string, catId: string): ParsedMemory {
  const normalized = content.trim();
  if (!normalized) {
    return {
      title: `# ${catId} 记忆`,
      sections: [
        { heading: '当前状态', body: '' },
        { heading: '已关闭决策（别再提了）', body: '' },
        { heading: '行为偏好（用户纠正过的）', body: '' },
        { heading: '环境 gotcha', body: '' },
        { heading: '最近验证', body: '' },
      ],
    };
  }

  const lines = normalized.split(/\r?\n/);
  const title = lines[0]?.startsWith('# ') ? lines[0] : `# ${catId} 记忆`;
  const bodyLines = lines[0]?.startsWith('# ') ? lines.slice(1) : lines;
  const sections: ParsedMemory['sections'] = [];
  let current: { heading: string; bodyLines: string[] } | null = null;

  for (const line of bodyLines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n').trim() });
      current = { heading: headingMatch[1] ?? '', bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n').trim() });

  return { title, sections };
}

function getSection(parsed: ParsedMemory, keyword: string): { heading: string; body: string } | undefined {
  return parsed.sections.find((section) => section.heading.includes(keyword));
}

function setSection(parsed: ParsedMemory, preferredHeading: string, body: string): void {
  const keyword = preferredHeading.replace(/（.*?）/g, '').trim();
  const existing = getSection(parsed, keyword);
  if (existing) {
    existing.body = body.trim();
    return;
  }
  parsed.sections.push({ heading: preferredHeading, body: body.trim() });
}

function updateCurrentStatusBody(existingBody: string, date: string, delivery: string): string {
  const lines = existingBody
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const next: string[] = [];
  let wroteLastActive = false;
  let wroteLastDelivery = false;

  for (const line of lines) {
    if (/^-\s*最后活跃[:：]/.test(line)) {
      next.push(`- 最后活跃：${date}`);
      wroteLastActive = true;
      continue;
    }
    if (/^-\s*上次交付[:：]/.test(line)) {
      next.push(`- 上次交付：${delivery}`);
      wroteLastDelivery = true;
      continue;
    }
    next.push(line);
  }

  if (!wroteLastActive) next.unshift(`- 最后活跃：${date}`);
  if (!next.some((line) => /^-\s*正在处理[:：]/.test(line))) {
    next.splice(1, 0, '- 正在处理：最近一次成功 invocation 后自动回写，等待人工确认具体任务状态。');
  }
  if (!wroteLastDelivery) next.push(`- 上次交付：${delivery}`);

  return next.join('\n');
}

function updateRecentValidationBody(existingBody: string, date: string, summary: AgentMemoryInvocationSummary): string {
  const invocationLine = `- ${date} auto-writer：成功完成 invocation ${summary.invocationId}（thread ${summary.threadId}），已自动刷新当前状态。`;
  const existing = existingBody
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.includes(`invocation ${summary.invocationId}`));
  return [invocationLine, ...existing].slice(0, MAX_RECENT_VALIDATION_ITEMS).join('\n');
}

function renderMemory(parsed: ParsedMemory): string {
  const chunks = [parsed.title.trim()];
  for (const section of parsed.sections) {
    chunks.push(`## ${section.heading.trim()}`);
    chunks.push(section.body.trim());
  }
  const rendered = `${chunks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
  return rendered.length > AGENT_MEMORY_MAX_CHARS
    ? `${rendered.slice(0, AGENT_MEMORY_MAX_CHARS - 40)}\n\n[Agent Memory 内容过长，已截断]\n`
    : rendered;
}

async function withMemoryWriteLock<T>(memoryPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLockByMemoryPath.get(memoryPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLockByMemoryPath.set(memoryPath, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (writeLockByMemoryPath.get(memoryPath) === current) {
      writeLockByMemoryPath.delete(memoryPath);
    }
  }
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${tempFileSequence++}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function updateAgentMemoryContent(oldContent: string, summary: AgentMemoryInvocationSummary): string {
  const completedAt = summary.completedAt ?? Date.now();
  const date = formatDate(completedAt);
  const delivery = buildInvocationSummary(summary);
  if (!delivery) return oldContent;

  const parsed = parseMemory(oldContent, summary.catId);
  const current = getSection(parsed, '当前状态')?.body ?? '';
  const recent = getSection(parsed, '最近验证')?.body ?? '';
  setSection(parsed, '当前状态', updateCurrentStatusBody(current, date, delivery));
  setSection(parsed, '最近验证', updateRecentValidationBody(recent, date, summary));
  return renderMemory(parsed);
}

export async function autoUpdateAgentMemory(
  summary: AgentMemoryInvocationSummary,
  options: AgentMemoryAutoWriterOptions = {},
): Promise<AgentMemoryAutoWriteResult> {
  if (process.env.CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE === '1') {
    return { status: 'skipped', reason: 'write_disabled' };
  }

  const now = options.now?.() ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? MEMORY_AUTO_WRITE_MIN_INTERVAL_MS;

  const delivery = buildInvocationSummary({ ...summary, completedAt: now });
  if (!delivery) {
    return { status: 'skipped', reason: 'empty_summary' };
  }

  const projectRoot = options.projectRoot ?? findMonorepoRoot();
  const memoryDir = getAgentMemoryDir(projectRoot);
  const memoryPath = getAgentMemoryPath(summary.catId, projectRoot);
  const promotionMode = resolveMemoryPromotionMode();
  return withMemoryWriteLock(memoryPath, async () => {
    const lastWriteAt = lastWriteAtByMemoryPath.get(memoryPath) ?? 0;
    if (!options.force && now - lastWriteAt < minIntervalMs) {
      return { status: 'skipped', reason: 'rate_limited' };
    }

    const oldContent = existsSync(memoryPath) ? await readFile(memoryPath, 'utf-8') : '';

    // 票C (P1-4): promotion review gate. off = legacy behavior (zero change);
    // shadow = evaluate + record but write as today; enforce = candidate queue
    // + hold-on-conflict, durable memory only via explicit user fast-track.
    let evaluation: MemoryPromotionEvaluation | undefined;
    if (promotionMode !== 'off') {
      const queued = await listMemoryCandidates(summary.catId, projectRoot);
      evaluation = evaluateMemoryPromotion({
        candidateText: trimOneLine(summary.assistantText ?? '', MAX_SUMMARY_CHARS),
        existingMemory: oldContent,
        userMessageText: summary.userMessageText,
        queuedContents: queued.map((record) => record.content),
      });
      recordPromotionDecision(promotionMode, evaluation);
      writeGateLog({ catId: summary.catId, invocationId: summary.invocationId, mode: promotionMode, evaluation });

      const appendLedger = async (status: 'pending_review' | 'promoted') => {
        await appendMemoryCandidate(
          {
            id: `cand-${now}-${candidateSequence++}`,
            catId: summary.catId,
            invocationId: summary.invocationId,
            threadId: summary.threadId,
            content: delivery,
            evaluation: evaluation!,
            status,
            ...(evaluation!.reviewer ? { reviewer: evaluation!.reviewer } : {}),
            createdAt: now,
          },
          projectRoot,
        );
      };

      if (promotionMode === 'shadow') {
        // Observe-first: decision logged + metric recorded above; write as today.
      } else if (evaluation.action === 'hold') {
        await appendLedger('pending_review');
        return { status: 'held', reason: 'conflict_hold', evaluation };
      } else if (evaluation.action === 'candidate') {
        await appendLedger('pending_review');
        return { status: 'held', reason: 'pending_review', evaluation };
      } else if (evaluation.action === 'skip') {
        return { status: 'skipped', reason: evaluation.skipReason ?? 'low_confidence', evaluation };
      } else {
        // promote (explicit user instruction fast-track): write durable AND ledger.
        await appendLedger('promoted');
      }
    }

    const nextContent = updateAgentMemoryContent(oldContent, { ...summary, completedAt: now });

    await mkdir(memoryDir, { recursive: true });
    await writeFileAtomically(memoryPath, nextContent);
    lastWriteAtByMemoryPath.set(memoryPath, now);

    return {
      status: 'updated',
      path: join(memoryDir, basename(memoryPath)),
      content: nextContent,
      ...(evaluation ? { evaluation } : {}),
    };
  });
}

function writeGateLog(input: {
  catId: string;
  invocationId: string;
  mode: 'shadow' | 'enforce';
  evaluation: MemoryPromotionEvaluation;
}): void {
  gateLog.info(
    {
      catId: input.catId,
      invocationId: input.invocationId,
      mode: input.mode,
      action: input.evaluation.action,
      sourceGrade: input.evaluation.sourceGrade,
      contentClass: input.evaluation.contentClass,
      confidence: input.evaluation.confidence,
      conflict: input.evaluation.conflict,
      rules: input.evaluation.rules,
    },
    input.mode === 'shadow' ? 'memory promotion shadow decision (write proceeds as today)' : 'memory promotion decision',
  );
}

export function resetAgentMemoryAutoWriterForTests(): void {
  lastWriteAtByMemoryPath.clear();
  writeLockByMemoryPath.clear();
  tempFileSequence = 0;
  candidateSequence = 0;
}
