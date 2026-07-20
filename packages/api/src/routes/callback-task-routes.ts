/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  resolveTaskSurfaceBinding,
  taskIsAccessibleFromExecutionSurface,
} from '../domains/cats/services/tasks/task-surface-resolver.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';
import { deriveCallbackActor, resolveScopedThreadId } from './callback-scope-helpers.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';

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
}
