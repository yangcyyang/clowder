/**
 * F-F（批次 3，PRD-memory-upgrade.md）：猫主动写记忆 callback 路由。
 *
 * Letta 的 self-editing 工具调用模式（memory_insert 等，文档来源转述，见
 * docs/research/memory-absorption.md §2 第 5 条）——给猫一个对话中主动沉淀记
 * 忆的入口，而不是只靠 AgentMemoryAutoWriter 在 invocation 完成后自动回写。
 *
 * 硬约束（PRD F-F 验收标准 + 调研文档明确点名的风险）："必须保证新工具与
 * auto-writer 共享同一个 evaluateMemoryPromotion 决策逻辑，否则出现两条路径
 * 两套标准，之前 P1-4 治理的'自动回写零审核'问题会从工具入口复活"——本文件
 * 与 AgentMemoryAutoWriter.ts 一样，只 `import { evaluateMemoryPromotion }`
 * 复用同一个函数，不重新实现判定表。共同锁死的单元测试见
 * packages/api/test/memory/agent-memory-write-tool-shared-gate.test.js。
 *
 * 三种出口（PRD 原文）：
 *  - promote        → 写入 durable memory（既有写路径：AgentMemoryStore.ts 已
 *                      导出的 readAgentMemory/writeAgentMemory——与
 *                      packages/api/src/routes/agent-memory.ts 的人工编辑接口
 *                      复用同一对读写函数，不新建写入器）。
 *  - candidate/hold  → 进候选队列（appendMemoryCandidate，与 AutoWriter 的
 *                      appendLedger 写法/JSONL 结构一致，带批次 2 的
 *                      suggestion 字段）。
 *  - skip            → 不落盘，原样返回 skipReason——工具描述里明确告诉猫
 *                      "hold/skip 不代表失败"。
 *
 * 设计取舍（写进报告，不是缺陷）：本工具的 schema（content/type/why）不接收
 * userMessageText，因此 evaluateMemoryPromotion 的第 4 步（user-stated 快速通
 * 道）在这个入口永远不会命中——猫自己主动调用 ≠ 铲屎官本人说"记住："，两者
 * 语义不同，不应该互相冒充。这不是 bug：意味着这个工具天然只会走
 * candidate/hold/skip 三个出口，`action === 'promote'` 分支仍然实现且被单元
 * 测试覆盖（用手工构造的 evaluation 直接驱动 routeMemoryWriteEvaluation），
 * 为将来 evaluateMemoryPromotion 演进保留防御性完整性。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  appendMemoryCandidate,
  evaluateMemoryPromotion,
  listMemoryCandidates,
  type MemoryCandidateRecord,
  type MemoryFrontmatterType,
  type MemoryPromotionEvaluation,
} from '../domains/cats/services/agents/memory/AgentMemoryPromotionGate.js';
import { readAgentMemory, writeAgentMemory } from '../domains/cats/services/agents/memory/AgentMemoryStore.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const writeMemorySchema = z.object({
  content: z.string().trim().min(1).max(4000),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  why: z.string().trim().min(1).max(500).optional(),
});

let candidateSequence = 0;

export interface WriteMemoryResult {
  status: 'written' | 'queued' | 'held' | 'skipped';
  action: MemoryPromotionEvaluation['action'];
  reason?: string;
  conflict?: MemoryPromotionEvaluation['conflict'];
  suggestion?: MemoryPromotionEvaluation['suggestion'];
}

function summarizeEvaluation(
  evaluation: MemoryPromotionEvaluation,
): Pick<WriteMemoryResult, 'action' | 'conflict' | 'suggestion'> {
  return {
    action: evaluation.action,
    ...(evaluation.conflict ? { conflict: evaluation.conflict } : {}),
    ...(evaluation.suggestion ? { suggestion: evaluation.suggestion } : {}),
  };
}

/**
 * 纯路由函数：给定一个**已经算好的** evaluation（来自 evaluateMemoryPromotion
 * ——与 AutoWriter 共享的同一个函数），执行对应的落盘动作。独立导出 + 把
 * evaluation 作为参数注入，是为了让测试可以直接驱动全部四个 action 分支
 * （包括实际上不会被本工具的公开 schema 触发的 'promote'），而不必依赖
 * evaluateMemoryPromotion 的启发式判定恰好落到某个分支——那是
 * evaluateMemoryPromotion 自己测试文件的职责
 * （test/agent-memory-promotion-gate.test.js /
 * test/memory/hold-suggestion-and-frontmatter-expiry.test.js）。
 */
export async function routeMemoryWriteEvaluation(params: {
  evaluation: MemoryPromotionEvaluation;
  content: string;
  catId: string;
  invocationId: string;
  threadId: string;
  projectRoot: string;
  now: number;
}): Promise<WriteMemoryResult> {
  const { evaluation, content, catId, invocationId, threadId, projectRoot, now } = params;

  if (evaluation.action === 'skip') {
    return {
      status: 'skipped',
      reason: evaluation.skipReason ?? 'low_confidence',
      ...summarizeEvaluation(evaluation),
    };
  }

  const baseRecord: Omit<MemoryCandidateRecord, 'status' | 'reviewer'> = {
    id: `cand-${now}-${candidateSequence++}`,
    catId,
    invocationId,
    threadId,
    content,
    evaluation,
    createdAt: now,
  };

  if (evaluation.action === 'promote') {
    // 既有写路径：readAgentMemory/writeAgentMemory（AgentMemoryStore.ts 已导
    // 出，packages/api/src/routes/agent-memory.ts 的人工编辑接口也是同一对函
    // 数）。不碰 AgentMemoryAutoWriter.ts 内部的 section 解析/渲染逻辑——那是
    // invocation-summary 专用的转换，本工具的内容是猫自己写的一句话陈述，语
    // 义不同，用一个更朴素的"追加一行带日期的记录"即可，不重新实现
    // parseMemory/renderMemory。
    const existing = await readAgentMemory(catId, projectRoot);
    const date = new Date(now).toISOString().slice(0, 10);
    const bulletLine = `- ${date} cat_cafe_write_memory：${content}`;
    const nextContent =
      existing.exists && existing.content.trim()
        ? `${existing.content.replace(/\n+$/, '')}\n${bulletLine}\n`
        : `# ${catId} 记忆\n\n## 手动记录（cat_cafe_write_memory）\n\n${bulletLine}\n`;
    await writeAgentMemory(catId, nextContent, projectRoot);
    await appendMemoryCandidate(
      {
        ...baseRecord,
        status: 'promoted',
        ...(evaluation.reviewer ? { reviewer: evaluation.reviewer } : {}),
      },
      projectRoot,
    );
    return { status: 'written', ...summarizeEvaluation(evaluation) };
  }

  // candidate | hold → 既有候选队列写路径（appendMemoryCandidate），与
  // AutoWriter 的 appendLedger() 写法/JSONL 结构一致，带批次 2 的 suggestion 字段。
  await appendMemoryCandidate({ ...baseRecord, status: 'pending_review' }, projectRoot);
  return {
    status: evaluation.action === 'hold' ? 'held' : 'queued',
    reason: evaluation.action === 'hold' ? 'conflict_hold' : 'pending_review',
    ...summarizeEvaluation(evaluation),
  };
}

/**
 * 共享判定入口：读现有记忆 + 已排队候选，调用 evaluateMemoryPromotion——与
 * AgentMemoryAutoWriter.autoUpdateAgentMemory 完全相同的导入
 * （AgentMemoryPromotionGate.js 的同一个具名导出），然后按 action 路由。
 */
export async function evaluateAndRouteMemoryWrite(params: {
  catId: string;
  invocationId: string;
  threadId: string;
  content: string;
  type?: MemoryFrontmatterType | undefined;
  why?: string | undefined;
  projectRoot?: string;
  now?: number;
}): Promise<WriteMemoryResult> {
  const projectRoot = params.projectRoot ?? findMonorepoRoot();
  const now = params.now ?? Date.now();
  const content = params.content.trim();

  const [existing, queued] = await Promise.all([
    readAgentMemory(params.catId, projectRoot),
    listMemoryCandidates(params.catId, projectRoot),
  ]);

  const frontmatter = params.type
    ? { type: params.type, ...(params.why ? { why: params.why } : {}) }
    : null;

  const evaluation = evaluateMemoryPromotion({
    candidateText: content,
    existingMemory: existing.content,
    queuedContents: queued.map((r) => r.content),
    frontmatter,
    now,
  });

  return routeMemoryWriteEvaluation({
    evaluation,
    content,
    catId: params.catId,
    invocationId: params.invocationId,
    threadId: params.threadId,
    projectRoot,
    now,
  });
}

export interface CallbackAgentMemoryWriteRoutesDeps {
  registry: Pick<InvocationRegistry, 'isLatest'>;
  /** Test seam only — production omits this and falls back to findMonorepoRoot(). */
  projectRoot?: string;
}

export async function registerCallbackAgentMemoryWriteRoutes(
  app: FastifyInstance,
  deps: CallbackAgentMemoryWriteRoutesDeps,
): Promise<void> {
  app.post('/api/callbacks/write-memory', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = writeMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    if (!(await deps.registry.isLatest(record.invocationId))) {
      return { status: 'stale_ignored' };
    }

    const { content, type, why } = parsed.data;
    return evaluateAndRouteMemoryWrite({
      catId: record.catId as string,
      invocationId: record.invocationId,
      threadId: record.threadId,
      content,
      type,
      why,
      ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}),
    });
  });
}
