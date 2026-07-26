/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBoolean } from '../config/parse-utils.js';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isSubjectOwnershipConflictError, type ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isLegalTaskStatusTransition } from '../domains/cats/services/tasks/task-status-transitions.js';
import {
  resolveTaskSurfaceBinding,
  taskIsAccessibleFromExecutionSurface,
} from '../domains/cats/services/tasks/task-surface-resolver.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { redactSecretsInText } from '../utils/env-var-secret-guard.js';
import { requireCallbackAuth, requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';
import { appendTaskLifecycleNotice, TASK_STATUS_LABEL_ZH, taskLifecycleLabel } from './task-event-notices.js';
import { deriveCallbackActor, resolvePrincipalThread, resolveScopedThreadId } from './callback-scope-helpers.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';
import {
  admitWorkMessage,
  downgradeMessageToActiveTaskProgress,
  findActiveOwnedTaskInThread,
  isTicketHygieneActiveTaskDowngradeEnabled,
} from './work-admission-service.js';

// ============================================================================
// 批次4-B5 票面卫生四规则 (docs/research/raft-r9-ticket-hygiene.md /
// docs/prd/batch4-codex-execution.md §3 B5): task-claim 的 message-id 转票路径
// 曾被执行猫当每轮记账动作使用，一晚产出 8+ 张标题为对话原文的垃圾票。四条规则各带
// 独立 env 开关（默认开，见 env-registry.ts CLOWDER_TICKET_HYGIENE_*）。
// B5.3（活跃票降级）的开关 + 落地动作在 work-admission-service.ts（导入见上）。
// ============================================================================

/** B5.1 层级规则: 分支/讨论 thread 内的消息不可经 message-id 转票。默认开，'false' 关闭。 */
function isTicketHygieneThreadHierarchyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.CLOWDER_TICKET_HYGIENE_THREAD_HIERARCHY, true);
}

/** B5.2 自噬禁止: 猫发的消息不可经 message-id 转票，仅人类消息可以。默认开，'false' 关闭。 */
function isTicketHygieneCatAuthorBlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.CLOWDER_TICKET_HYGIENE_CAT_AUTHOR_BLOCK, true);
}

/**
 * B5.4 标题强制: message-id 转票必须随附猫自拟标题。默认开；关闭时回退旧行为
 * （用消息原文截断当标题，见下方 titleFromMessageContent）。'false' 关闭。
 */
function isTicketHygieneRequireTitleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.CLOWDER_TICKET_HYGIENE_REQUIRE_TITLE, true);
}

/** B5.4: max title length (chars, after trim) — Raft r9 明确反对截断，超长直接拒绝。 */
const TASK_CLAIM_TITLE_MAX_LEN = 60;

const updateTaskSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
  failureClass: z
    .enum(['agent_error', 'build_failed', 'test_failed', 'timeout', 'budget_exhausted', 'infra_error', 'manual_fail'])
    .optional(),
  failureReason: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
});

const claimTaskSchema = z.object({
  taskId: z.string().min(1),
  why: z.string().max(1000).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  why: z.string().max(1000).optional().default(''),
  ownerCatId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
});

const listTasksQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
  status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
  kind: z.enum(['work', 'pr_tracking']).optional(),
});

export function registerCallbackTaskRoutes(
  app: FastifyInstance,
  deps: {
    taskStore: ITaskStore;
    socketManager: SocketManager;
    messageStore?: IMessageStore;
    threadStore?: IThreadStore;
    freshnessGate?: FreshnessEgressGate;
    registry: Pick<InvocationRegistry, 'isLatest'>;
  },
): void {
  const { taskStore, socketManager, messageStore, threadStore } = deps;

  function emitTaskAttention(
    previousStatus: string | undefined,
    task: { kind?: string; status: string; userId?: string },
  ): void {
    if (task.kind === 'pr_tracking') return;
    if (!task.userId) return;
    if (previousStatus === task.status) return;
    if (task.status !== 'in_review' && task.status !== 'blocked' && task.status !== 'failed') return;
    socketManager.emitToUser(task.userId, 'task_attention', task);
  }

  app.post('/api/callbacks/update-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { taskId, status, failureClass, failureReason, why } = parsed.data;

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (
      !(await taskIsAccessibleFromExecutionSurface({
        taskStore,
        task: existing,
        threadStore,
        userId: actor.userId,
        executionThreadId: actor.threadId,
      }))
    ) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }
    if (existing.ownerCatId && existing.ownerCatId !== actor.catId) {
      reply.status(403);
      return { error: 'Task is owned by another cat' };
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'update-task',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (failureClass) updateData.failureClass = failureClass;
    if (failureReason) updateData.failureReason = failureReason;
    if (why) updateData.why = why;
    updateData.eventCatId = actor.catId;

    const updated = await taskStore.update(taskId, updateData);
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to update task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    emitTaskAttention(existing.status, updated);
    return { status: 'ok', task: updated };
  });

  app.post('/api/callbacks/claim-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = claimTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { taskId, why } = parsed.data;
    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (
      !(await taskIsAccessibleFromExecutionSurface({
        taskStore,
        task: existing,
        threadStore,
        userId: actor.userId,
        executionThreadId: actor.threadId,
      }))
    ) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }
    // Cheap pre-check keeps 409-before-freshness ordering (a retry on an
    // already-claimed task must not consume the invocation side-effect claim).
    // The authoritative atomic check is claimIfUnowned below.
    if (existing.ownerCatId && existing.ownerCatId !== actor.catId) {
      reply.status(409);
      return { error: 'Task is already claimed by another cat', ownerCatId: existing.ownerCatId };
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'claim-task',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    // 票B B3: single atomic CAS — read-then-update allowed two racing cats to both win.
    const claim = await taskStore.claimIfUnowned(taskId, actor.catId, {
      ...(why ? { why } : {}),
    });
    if (claim.outcome === 'not_found') {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (claim.outcome === 'already_claimed') {
      reply.status(409);
      return { error: 'Task is already claimed by another cat', ownerCatId: claim.task.ownerCatId };
    }
    const updated = claim.task;

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'ok', task: updated };
  });

  // F160: create-task — kind forced to 'work' (KD-4)
  app.post('/api/callbacks/create-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { title, why, ownerCatId, parentTaskId } = parsed.data;

    // F182 AC-C2: B class — validate ownerCatId is available (contract 400 on disabled)
    let resolvedOwnerCatId: CatId | null = null;
    if (ownerCatId) {
      const resolved = resolveCatTarget(ownerCatId);
      if ('error' in resolved) {
        reply.status(400);
        return resolved.error;
      }
      resolvedOwnerCatId = createCatId(resolved.ok);
    }

    // Pure surface validation runs before freshness authorization so a
    // retryable business 409 does not consume the invocation side-effect
    // claim. The successful existing-task reuse remains freshness-protected.
    const binding = await resolveTaskSurfaceBinding({
      taskStore,
      threadStore,
      userId: actor.userId,
      executionThreadId: actor.threadId,
    });
    if (binding.outcome === 'ambiguous') {
      reply.status(409);
      return { error: 'Task thread has multiple owning tasks', taskIds: binding.taskIds };
    }
    if (parentTaskId) {
      if (binding.outcome !== 'bound' || binding.surface !== 'task_thread' || binding.task.id !== parentTaskId) {
        reply.status(409);
        return { error: 'parentTaskId is not the task bound to this thread' };
      }
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'create-task',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    if (
      !parentTaskId &&
      binding.outcome === 'bound' &&
      binding.surface === 'task_thread' &&
      binding.task.subjectKey?.startsWith('work-intake:')
    ) {
      return { status: 'existing_task', code: 'TASK_ALREADY_ACTIVE', task: binding.task };
    }

    const created = await taskStore.create({
      threadId: actor.threadId,
      title,
      why: why ?? '',
      createdBy: actor.catId,
      kind: 'work',
      subjectKey: null,
      ownerCatId: resolvedOwnerCatId,
      userId: actor.userId,
      ...(parentTaskId ? { parentTaskId } : {}),
    });
    const task =
      threadStore && messageStore
        ? (
            await ensureTaskDiscussionThread(
              created,
              { taskStore, threadStore, messageStore, socketManager },
              { userId: actor.userId, broadcastUpdate: false },
            )
          ).task
        : created;

    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
    reply.status(201);
    return { status: 'ok', task };
  });

  app.get('/api/callbacks/list-tasks', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { threadId, catId, status, kind } = parsed.data;

    if (catId && !catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Unknown catId: ${catId}` };
    }

    let scopedThreadIds: string[] = [];
    if (threadId) {
      const scoped = await resolveScopedThreadId(actor, threadId, {
        threadStore,
        threadStoreMissingError: 'Thread store not configured for cross-thread task query',
        accessDeniedError: 'Thread access denied',
      });
      if (!scoped.ok) {
        reply.status(scoped.statusCode);
        return { error: scoped.error };
      }
      scopedThreadIds = [scoped.threadId];
    } else if (threadStore) {
      const userThreads = await threadStore.list(actor.userId);
      scopedThreadIds = userThreads.map((item) => item.id);
    } else {
      app.log.warn(
        { userId: actor.userId, invocationId: actor.invocationId },
        '[callbacks/list-tasks] threadStore unavailable, falling back to current thread only',
      );
      scopedThreadIds = [actor.threadId];
    }

    const perThreadTasks = await Promise.all(scopedThreadIds.map((id) => taskStore.listByThread(id)));
    let tasks = perThreadTasks.flat();
    if (threadId) {
      const executionThreadId = scopedThreadIds[0];
      if (!executionThreadId) {
        reply.status(500);
        return { error: 'Resolved task thread scope is empty' };
      }
      const binding = await resolveTaskSurfaceBinding({
        taskStore,
        threadStore,
        userId: actor.userId,
        executionThreadId,
      });
      if (binding.outcome === 'ambiguous') {
        reply.status(409);
        return { error: 'Task thread has multiple owning tasks', taskIds: binding.taskIds };
      }
      if (binding.outcome === 'bound' && binding.surface === 'task_thread') tasks.push(binding.task);
    }
    tasks = [...new Map(tasks.map((task) => [task.id, task])).values()];
    if (catId) tasks = tasks.filter((item) => item.ownerCatId === catId);
    if (status) tasks = tasks.filter((item) => item.status === status);
    if (kind) tasks = tasks.filter((item) => item.kind === kind);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    return { tasks };
  });

  // ============================================================================
  // 批次 2-C: task-* dual-auth endpoints (Raft CLI parity, docs/research/
  // clowder-raft-thread-task-design.md §5.1/§5B.5). These mirror the routes
  // above but use requireCallbackPrincipal so agent-key (non-Claude, e.g.
  // Antigravity) callers work too — the legacy create-task/claim-task/
  // update-task/list-tasks routes above stay invocation-only and untouched.
  // ============================================================================

  const taskClaimSchema = z
    .object({
      taskId: z.string().min(1).optional(),
      messageId: z.string().min(1).optional(),
      // B5.4: real requiredness (1-60 chars after trim) is enforced in the messageId
      // branch below with a friendly Chinese hint — kept loose here (just a defensive
      // upper bound) so a too-long value reaches that hint instead of a generic zod 400.
      title: z.string().max(1000).optional(),
      why: z.string().max(1000).optional(),
    })
    .refine((data) => Boolean(data.taskId) !== Boolean(data.messageId), {
      message: 'Exactly one of taskId or messageId is required',
    });

  const taskCreateSchema = z.object({
    title: z.string().min(1).max(200),
    why: z.string().max(1000).optional().default(''),
    ownerCatId: z.string().min(1).optional(),
    subjectKey: z.string().min(1).max(300).optional(),
    parentTaskId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  });

  const taskUpdateSchema = z
    .object({
      taskId: z.string().min(1),
      status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
      failureClass: z
        .enum(['agent_error', 'build_failed', 'test_failed', 'timeout', 'budget_exhausted', 'infra_error', 'manual_fail'])
        .optional(),
      failureReason: z.string().max(2000).optional(),
      why: z.string().max(1000).optional(),
    })
    .refine((data) => data.status || data.failureClass || data.failureReason || data.why, {
      message: 'At least one of status/failureClass/failureReason/why must be provided',
    });

  const taskUnclaimSchema = z.object({
    taskId: z.string().min(1),
    why: z.string().max(1000).optional(),
  });

  const taskListQuerySchema = z.object({
    threadId: z.string().min(1).optional(),
    status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
    kind: z.enum(['work', 'pr_tracking']).optional(),
  });

  const resolveMessageThreadQuerySchema = z.object({
    messageId: z.string().min(1),
  });

  /** Trimmed, secret-redacted, length-capped title derived from a raw message body. */
  function titleFromMessageContent(content: string): string {
    const redacted = redactSecretsInText(content).replace(/\s+/g, ' ').trim();
    if (!redacted) return '待认领任务';
    return redacted.length > 80 ? `${redacted.slice(0, 79)}…` : redacted;
  }

  // POST /api/callbacks/task-claim — claim by taskId, or convert-and-claim by messageId.
  app.post('/api/callbacks/task-claim', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = taskClaimSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const catId = createCatId(principal.catId);

    if (parsed.data.taskId) {
      const taskId = parsed.data.taskId;
      const existing = await taskStore.get(taskId);
      if (!existing) {
        reply.status(404);
        return { error: 'Task not found' };
      }
      const threadResult = await resolvePrincipalThread(principal, existing.threadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      if (existing.ownerCatId && existing.ownerCatId !== catId) {
        reply.status(409);
        return { error: 'Task is already claimed by another cat', ownerCatId: existing.ownerCatId };
      }
      const claim = await taskStore.claimIfUnowned(taskId, catId, parsed.data.why ? { why: parsed.data.why } : {});
      if (claim.outcome === 'not_found') {
        reply.status(404);
        return { error: 'Task not found' };
      }
      if (claim.outcome === 'already_claimed') {
        reply.status(409);
        return { error: 'Task is already claimed by another cat', ownerCatId: claim.task.ownerCatId };
      }
      socketManager.broadcastToRoom(`thread:${claim.task.threadId}`, 'task_updated', claim.task);
      return { status: 'ok', task: claim.task };
    }

    // message-id form: convert the message into a task (if needed) and claim it.
    // Mirrors `raft task claim --message-id X` (design doc §5.1). ensureMessageAnchoredThread
    // (2-A) is not ready yet, so this reuses admitWorkMessage/ensureTaskDiscussionThread
    // directly — no new task business logic invented here.
    if (!messageStore || !threadStore) {
      reply.status(501);
      return { error: 'Message/thread store unavailable — cannot claim by messageId' };
    }
    const messageId = parsed.data.messageId as string;
    const sourceMessage = await messageStore.getById(messageId);
    if (!sourceMessage) {
      reply.status(404);
      return { error: 'Message not found' };
    }
    const threadResult = await resolvePrincipalThread(principal, sourceMessage.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }

    // B5.1 层级规则: 分支/讨论 thread（有 relation，见 ThreadStore.ts computeThreadKind）内的
    // 消息是工作流中间产物（裁定/回述/进度），物理上没有可 claim 的对象——只有频道顶层
    // 消息（channel/lobby/dm，均无 relation）可以转票。
    if (isTicketHygieneThreadHierarchyEnabled()) {
      const sourceThread = await threadStore.get(sourceMessage.threadId);
      if (sourceThread?.relation) {
        reply.status(403);
        return {
          error: 'Messages inside a branch/discussion thread cannot become a task via message-id',
          code: 'TASK_CLAIM_THREAD_NOT_TOP_LEVEL',
          hint: '讨论上下文不入票；这是新工作请用 task_create 并自拟标题',
        };
      }
    }

    // B5.2 自噬禁止: 猫发的消息一律不可经 message-id 转票（人类消息可）——猫自己的工作
    // 必须显式 task_create + 自拟标题，防止"把同伴裁定/自己的换班回述当记账动作认领"。
    if (isTicketHygieneCatAuthorBlockEnabled() && sourceMessage.catId) {
      reply.status(403);
      return {
        error: 'A cat-authored message cannot become a task via message-id',
        code: 'TASK_CLAIM_CAT_AUTHORED_MESSAGE',
        hint: '猫发的消息不入票；这是你自己的工作请用 task_create 并自拟标题',
      };
    }

    // B5.4 标题强制（参数校验，见批次4-B5 建议顺序 B5.1→B5.2→B5.4→B5.3）: message-id 转票
    // 必须随附猫自拟的短标题——Raft r9 明确反对用消息原文截断当标题（截出半句话、真带出
    // 过密钥）。原消息全文不受影响，仍会整理进票的讨论 thread 首条（见下方 existingTask /
    // admitWorkMessage 路径）。关闭时完整回退旧行为（titleFromMessageContent 派生标题）。
    const titleRequired = isTicketHygieneRequireTitleEnabled();
    let resolvedTaskTitle: string;
    if (titleRequired) {
      const trimmedTitle = (parsed.data.title ?? '').trim();
      if (!trimmedTitle) {
        reply.status(400);
        return {
          error: 'title is required (1-60 chars, trimmed) when claiming by messageId',
          code: 'TASK_CLAIM_TITLE_REQUIRED',
          hint: '请自拟一个 1-60 字的标题（不要留空）；原文会自动整理进票的讨论 thread 首条，标题不用照抄原文',
        };
      }
      if (trimmedTitle.length > TASK_CLAIM_TITLE_MAX_LEN) {
        reply.status(400);
        return {
          error: `title must be at most ${TASK_CLAIM_TITLE_MAX_LEN} chars after trimming`,
          code: 'TASK_CLAIM_TITLE_TOO_LONG',
          hint: '标题超过 60 字；请自拟一个更短的标题，不要把原文截断当标题——原文本身会自动整理进票的讨论 thread 首条',
        };
      }
      resolvedTaskTitle = redactSecretsInText(trimmedTitle);
    } else {
      resolvedTaskTitle = titleFromMessageContent(sourceMessage.content);
    }

    const subjectKey = `work-intake:${sourceMessage.threadId}:${sourceMessage.id}`;
    const existingTask = await taskStore.getBySubject(subjectKey);
    if (existingTask) {
      if (existingTask.ownerCatId && existingTask.ownerCatId !== catId) {
        reply.status(409);
        return {
          error: 'Task for this message is already claimed by another cat',
          ownerCatId: existingTask.ownerCatId,
          taskId: existingTask.id,
        };
      }
      const claim = await taskStore.claimIfUnowned(
        existingTask.id,
        catId,
        parsed.data.why ? { why: parsed.data.why } : {},
      );
      if (claim.outcome === 'not_found') {
        reply.status(404);
        return { error: 'Task not found' };
      }
      if (claim.outcome === 'already_claimed') {
        reply.status(409);
        return { error: 'Task is already claimed by another cat', ownerCatId: claim.task.ownerCatId };
      }
      const discussion = await ensureTaskDiscussionThread(
        claim.task,
        { taskStore, threadStore, messageStore, socketManager },
        { userId: principal.userId, broadcastUpdate: false },
      );
      socketManager.broadcastToRoom(`thread:${discussion.task.threadId}`, 'task_updated', discussion.task);
      return { status: 'ok', task: discussion.task, created: false };
    }

    // B5.3 活跃票降级: claim 者在同 thread 已有自己 owned 的活跃票（todo/doing/in_review）
    // 时，不新建票——把这条消息挂到活跃票当进度事件，频道内留可见提示卡，显式逃生门
    // （task_create 仍可建新票）。只在真正要"转票"之前判——existingTask 复用（上面）代表
    // 这条消息本来就已经有自己的票，不属于本规则要拦的"记账式误认领"。
    if (isTicketHygieneActiveTaskDowngradeEnabled()) {
      const activeTask = await findActiveOwnedTaskInThread(taskStore, sourceMessage.threadId, catId);
      if (activeTask) {
        const downgraded = await downgradeMessageToActiveTaskProgress({
          task: activeTask,
          sourceMessage,
          catId,
          userId: principal.userId,
          deps: { taskStore, threadStore, messageStore, socketManager },
        });
        const hint = `已挂到 ${downgraded.label} 作为进度；若这是新的独立工作，请用 task_create 显式建票`;
        await appendTaskLifecycleNotice({
          task: downgraded.task,
          content: hint,
          systemKind: 'task_progress_attached',
          eventType: 'task_progress_attached',
          tone: 'info',
          dedupeKey: sourceMessage.id,
          deps: { messageStore, socketManager },
        }).catch(() => {});
        return { status: 'ok', task: downgraded.task, created: false, downgraded: true, hint };
      }
    }

    try {
      const admitted = await admitWorkMessage({
        decision: {
          kind: 'create_from_message',
          taskTitle: resolvedTaskTitle,
          ownerCatId: catId,
          reason: 'explicit_action',
        },
        sourceMessage,
        userId: principal.userId,
        deps: { taskStore, threadStore, messageStore, socketManager },
      });
      reply.status(201);
      return { status: 'ok', task: admitted.task, created: admitted.created };
    } catch (err) {
      if (isSubjectOwnershipConflictError(err)) {
        reply.status(409);
        return { error: 'Message belongs to another user' };
      }
      throw err;
    }
  });

  // POST /api/callbacks/task-create — subjectKey dedup: if a task already exists for the
  // subject, return it (status:'existing_task') instead of creating a duplicate — the
  // caller should task-claim it instead (design doc §5.2 rule 3: "已有消息就 claim，别新建").
  app.post('/api/callbacks/task-create', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = taskCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const threadResult = await resolvePrincipalThread(principal, parsed.data.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }
    const threadId = threadResult.threadId;

    let resolvedOwnerCatId: CatId | null = null;
    if (parsed.data.ownerCatId) {
      const resolved = resolveCatTarget(parsed.data.ownerCatId);
      if ('error' in resolved) {
        reply.status(400);
        return resolved.error;
      }
      resolvedOwnerCatId = createCatId(resolved.ok);
    }

    if (parsed.data.parentTaskId) {
      const parent = await taskStore.get(parsed.data.parentTaskId);
      if (!parent) {
        reply.status(400);
        return { error: 'parentTaskId does not exist' };
      }
    }

    if (parsed.data.subjectKey) {
      const existing = await taskStore.getBySubject(parsed.data.subjectKey);
      if (existing) {
        return {
          status: 'existing_task',
          code: 'TASK_ALREADY_EXISTS',
          task: existing,
          hint: `A task already exists for this subject (taskId=${existing.id}) — use task_claim instead of creating a duplicate.`,
        };
      }
    }

    const createInput = {
      threadId,
      title: parsed.data.title,
      why: parsed.data.why ?? '',
      createdBy: createCatId(principal.catId),
      kind: 'work' as const,
      subjectKey: parsed.data.subjectKey ?? null,
      userId: principal.userId,
      ...(resolvedOwnerCatId ? { ownerCatId: resolvedOwnerCatId, status: 'doing' as const } : {}),
      ...(parsed.data.parentTaskId ? { parentTaskId: parsed.data.parentTaskId } : {}),
    };

    let created;
    try {
      created = parsed.data.subjectKey ? await taskStore.upsertBySubject(createInput) : await taskStore.create(createInput);
    } catch (err) {
      if (isSubjectOwnershipConflictError(err)) {
        reply.status(409);
        return { error: 'Subject is already owned by another user' };
      }
      throw err;
    }

    const task =
      threadStore && messageStore
        ? (
            await ensureTaskDiscussionThread(
              created,
              { taskStore, threadStore, messageStore, socketManager },
              { userId: principal.userId, broadcastUpdate: false },
            )
          ).task
        : created;

    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
    reply.status(201);
    return { status: 'ok', task };
  });

  // POST /api/callbacks/task-update — status transitions validated (design doc §5.2 rule 6).
  app.post('/api/callbacks/task-update', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = taskUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { taskId, status, failureClass, failureReason, why } = parsed.data;

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    const threadResult = await resolvePrincipalThread(principal, existing.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }
    if (existing.ownerCatId && existing.ownerCatId !== principal.catId) {
      reply.status(403);
      return { error: 'Task is owned by another cat' };
    }

    if (status && status !== existing.status) {
      const legality = isLegalTaskStatusTransition(existing.status, status);
      if (!legality.ok) {
        reply.status(409);
        return { error: legality.reason, code: 'ILLEGAL_STATUS_TRANSITION', from: existing.status, to: status };
      }
    }

    const updateData: Record<string, unknown> = { eventCatId: principal.catId };
    if (status) updateData.status = status;
    if (failureClass) updateData.failureClass = failureClass;
    if (failureReason) updateData.failureReason = failureReason;
    if (why) updateData.why = why;

    const updated = await taskStore.update(taskId, updateData);
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to update task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    emitTaskAttention(existing.status, updated);
    // 批次2 集成：状态流转在主 thread 发系统通知（appendTaskLifecycleNotice 自带
    // 同任务同状态 5 分钟去重；messageStore 未注入时静默跳过——通知是尽力而为）。
    if (messageStore && status && status !== existing.status) {
      const label = await taskLifecycleLabel(taskStore, updated).catch(() => `#${updated.id}`);
      void appendTaskLifecycleNotice({
        task: updated,
        content: `任务 ${label} 状态变更：${TASK_STATUS_LABEL_ZH[existing.status]} → ${TASK_STATUS_LABEL_ZH[status]}（${principal.catId}）`,
        systemKind: 'task_status_changed',
        eventType: 'task_status_changed',
        tone: status === 'done' ? 'success' : 'info',
        dedupeKey: status,
        deps: { messageStore, socketManager },
      }).catch(() => {});
    }
    return { status: 'ok', task: updated };
  });

  // POST /api/callbacks/task-unclaim
  app.post('/api/callbacks/task-unclaim', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = taskUnclaimSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { taskId, why } = parsed.data;

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    const threadResult = await resolvePrincipalThread(principal, existing.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }
    if (!existing.ownerCatId) {
      reply.status(409);
      return { error: 'Task has no owner to unclaim' };
    }
    if (existing.ownerCatId !== principal.catId) {
      reply.status(403);
      return { error: 'Task is claimed by another cat', ownerCatId: existing.ownerCatId };
    }
    if (existing.status === 'done') {
      reply.status(409);
      return { error: 'Cannot unclaim a completed task' };
    }

    const updated = await taskStore.update(taskId, {
      ownerCatId: null,
      status: 'todo',
      eventCatId: principal.catId,
      ...(why ? { why } : {}),
    });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to unclaim task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'ok', task: updated };
  });

  // GET /api/callbacks/task-list?threadId=&status=&kind=
  app.get('/api/callbacks/task-list', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = taskListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }
    const { threadId: requestedThreadId, status, kind } = parsed.data;

    let scopedThreadIds: string[];
    if (requestedThreadId) {
      const threadResult = await resolvePrincipalThread(principal, requestedThreadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      scopedThreadIds = [threadResult.threadId];
    } else if (threadStore) {
      const userThreads = await threadStore.list(principal.userId);
      scopedThreadIds = userThreads.map((item) => item.id);
    } else {
      reply.status(400);
      return { error: 'threadId is required (no thread store configured for cross-thread listing)' };
    }

    const perThreadTasks = await Promise.all(scopedThreadIds.map((id) => taskStore.listByThread(id)));
    let tasks = [...new Map(perThreadTasks.flat().map((task) => [task.id, task])).values()];
    if (status) tasks = tasks.filter((item) => item.status === status);
    if (kind) tasks = tasks.filter((item) => item.kind === kind);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    return { tasks };
  });

  // GET /api/callbacks/resolve-message-thread?messageId= — reverse lookup: which task
  // (and its taskThreadId) is anchored to this message. Backs cat_cafe_reply_in_thread.
  // Only the "task.taskThreadId already exists" scenario is supported (design doc §5.1:
  // ensureMessageAnchoredThread is 2-A's not-yet-landed work) — anything else is a clear
  // 404 telling the caller to use post_message/cross_post_message instead.
  app.get('/api/callbacks/resolve-message-thread', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = resolveMessageThreadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }
    if (!messageStore) {
      reply.status(501);
      return { error: 'Message store unavailable' };
    }

    const message = await messageStore.getById(parsed.data.messageId);
    if (!message) {
      reply.status(404);
      return { error: 'Message not found' };
    }
    const threadResult = await resolvePrincipalThread(principal, message.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }

    const candidates = await taskStore.listByThread(message.threadId);
    const task = candidates.find((item) => item.sourceMessageId === message.id && item.taskThreadId);
    if (!task?.taskThreadId) {
      reply.status(404);
      return {
        error:
          'No thread is anchored to this message. Only messages already converted into a task with an existing ' +
          'discussion thread can be replied-in-thread. Use task_claim with messageId to convert it first, or use ' +
          'post_message/cross_post_message to reply in the current thread.',
        code: 'NO_ANCHORED_THREAD',
      };
    }
    return { threadId: task.taskThreadId, taskId: task.id };
  });
}
