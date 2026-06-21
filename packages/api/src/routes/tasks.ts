/**
 * Task CRUD Routes (毛线球)
 *
 * POST   /api/tasks         → 创建任务 (201)
 * GET    /api/tasks?threadId → 列出线程任务
 * GET    /api/tasks/:id     → 获取单个 / 404
 * PATCH  /api/tasks/:id     → 更新状态/标题/owner
 * DELETE /api/tasks/:id     → 删除 (204)
 */

import type { CatId, CreateTaskInput, TaskEvent, TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface TasksRoutesOptions {
  taskStore: ITaskStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

const VALID_STATUSES = ['todo', 'doing', 'in_review', 'blocked', 'done'] as const;

/** createdBy accepts any registered catId OR 'user' */
const createdBySchema = z.union([catIdSchema(), z.literal('user')]);

const evidenceSchema = z
  .object({
    tests: z.string().max(2000).optional(),
    build: z.string().max(2000).optional(),
    screenshot: z.string().max(2000).optional(),
    review: z.string().max(2000).optional(),
    lesson: z.string().max(2000).optional(),
    updatedAt: z.number().optional(),
  })
  .optional();

const createSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1).max(200),
  why: z.string().max(1000).default(''),
  createdBy: createdBySchema,
  ownerCatId: catIdSchema().nullable().optional(),
  sourceMessageId: z.string().optional(),
  sourceSummaryId: z.string().optional(),
  taskThreadId: z.string().optional(),
  evidence: evidenceSchema,
  parentTaskId: z.string().optional(),
  retryOf: z.string().optional(),
  branchOf: z.string().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    ownerCatId: catIdSchema().nullable().optional(),
    status: z.enum(VALID_STATUSES).optional(),
    why: z.string().max(1000).optional(),
    sourceMessageId: z.string().optional(),
    taskThreadId: z.string().optional(),
    evidence: evidenceSchema,
    parentTaskId: z.string().optional(),
    retryOf: z.string().optional(),
    branchOf: z.string().optional(),
    eventCatId: z.string().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Build CreateTaskInput from zod output (bridges string→CatId branded types) */
function toCreateInput(data: z.infer<typeof createSchema>): CreateTaskInput {
  const input: CreateTaskInput = {
    threadId: data.threadId,
    title: data.title,
    why: data.why,
    createdBy: data.createdBy as CatId | 'user',
  };
  if (data.ownerCatId != null) {
    input.ownerCatId = data.ownerCatId as CatId;
  }
  if (data.sourceMessageId) input.sourceMessageId = data.sourceMessageId;
  if (data.sourceSummaryId) input.sourceSummaryId = data.sourceSummaryId;
  if (data.taskThreadId) input.taskThreadId = data.taskThreadId;
  if (data.evidence !== undefined) input.evidence = { ...data.evidence, updatedAt: Date.now() };
  if (data.parentTaskId) input.parentTaskId = data.parentTaskId;
  if (data.retryOf) input.retryOf = data.retryOf;
  if (data.branchOf) input.branchOf = data.branchOf;
  return input;
}

/** Build UpdateTaskInput from zod output (filters undefined, bridges branded types) */
function toUpdateInput(data: z.infer<typeof updateSchema>): UpdateTaskInput {
  const input: UpdateTaskInput = {};
  if (data.title !== undefined) input.title = data.title;
  if (data.status !== undefined) input.status = data.status;
  if (data.why !== undefined) input.why = data.why;
  if (data.sourceMessageId !== undefined) input.sourceMessageId = data.sourceMessageId;
  if (data.taskThreadId !== undefined) input.taskThreadId = data.taskThreadId;
  if (data.ownerCatId !== undefined) input.ownerCatId = data.ownerCatId as CatId | null;
  if (data.evidence !== undefined) input.evidence = { ...data.evidence, updatedAt: Date.now() };
  if (data.parentTaskId !== undefined) input.parentTaskId = data.parentTaskId;
  if (data.retryOf !== undefined) input.retryOf = data.retryOf;
  if (data.branchOf !== undefined) input.branchOf = data.branchOf;
  if (data.eventCatId !== undefined) input.eventCatId = data.eventCatId;
  return input;
}

const taskEventSchema = z.object({
  ts: z.string().datetime().optional(),
  catId: z.string().min(1),
  type: z.enum(['claimed', 'unclaimed', 'status_changed', 'completed', 'failed']),
  data: z.record(z.unknown()).optional(),
});

const taskThreadSchema = z.object({
  userId: z.string().min(1).max(100).optional(),
});

function formatTaskThreadTitle(title: string): string {
  const trimmed = title.trim();
  const shortTitle = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return `${shortTitle || '任务'} (分支)`;
}

function formatTaskSourceContent(task: { title: string; why?: string }): string {
  return [`📌 Task: ${task.title}`, task.why?.trim() ? `\n${task.why.trim()}` : ''].join('\n');
}

function toTaskThreadMessage(message: StoredMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    userId: message.userId,
    catId: message.catId,
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
  };
}

export const tasksRoutes: FastifyPluginAsync<TasksRoutesOptions> = async (app, opts) => {
  const { taskStore, threadStore, messageStore, socketManager } = opts;

  async function getTaskInThread(threadId: string, taskId: string): Promise<TaskItem | null> {
    const task = await taskStore.get(taskId);
    if (!task || task.threadId !== threadId) return null;
    return task;
  }

  async function buildLineage(task: TaskItem): Promise<TaskItem[]> {
    const lineage: TaskItem[] = [];
    const visited = new Set<string>([task.id]);
    let cursor: TaskItem | null = task;
    for (let depth = 0; depth < 20; depth += 1) {
      const nextId = cursor.parentTaskId ?? cursor.retryOf ?? cursor.branchOf;
      if (!nextId || visited.has(nextId)) break;
      visited.add(nextId);
      const next = await taskStore.get(nextId);
      if (!next) break;
      lineage.push(next);
      cursor = next;
    }
    return lineage;
  }

  // POST /api/tasks
  app.post('/api/tasks', async (request, reply) => {
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const task = await taskStore.create(toCreateInput(result.data));
    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);

    reply.status(201);
    return task;
  });

  // GET /api/tasks?threadId=xxx[&kind=work|pr_tracking]
  app.get('/api/tasks', async (request, reply) => {
    const { threadId, kind } = request.query as { threadId?: string; kind?: string };
    if (!threadId) {
      reply.status(400);
      return { error: 'Missing threadId query parameter' };
    }

    let tasks = await taskStore.listByThread(threadId);
    if (kind) tasks = tasks.filter((t) => t.kind === kind);
    return { tasks };
  });

  // GET /api/tasks/:id
  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // GET /api/threads/:threadId/tasks/:taskId — 获取线程内任务详情（含 lineage 字段）
  app.get('/api/threads/:threadId/tasks/:taskId', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // GET /api/threads/:threadId/tasks/:taskId/events — 查询任务事件账本
  app.get('/api/threads/:threadId/tasks/:taskId/events', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return { events: task.events ?? [] };
  });

  // POST /api/threads/:threadId/tasks/:taskId/events — 手动追加事件（审计/迁移兜底）
  app.post('/api/threads/:threadId/tasks/:taskId/events', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const parsed = taskEventSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const event: TaskEvent = {
      ts: parsed.data.ts ?? new Date().toISOString(),
      catId: parsed.data.catId,
      type: parsed.data.type,
      ...(parsed.data.data ? { data: parsed.data.data } : {}),
    };
    const updated = await taskStore.update(task.id, { events: [event] });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to append task event' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    reply.status(201);
    return { events: updated.events ?? [] };
  });

  // GET /api/threads/:threadId/tasks/:taskId/lineage — 返回父链/重试/分支关联
  app.get('/api/threads/:threadId/tasks/:taskId/lineage', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    return {
      task,
      lineage: await buildLineage(task),
    };
  });

  // POST /api/tasks/:id/thread — ensure and return the task discussion thread.
  app.post('/api/tasks/:id/thread', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = taskThreadSchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }

    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    if (task.taskThreadId) {
      const existingThread = await threadStore.get(task.taskThreadId);
      if (existingThread) {
        const messages = await messageStore.getByThread(task.taskThreadId, 100);
        const sourceMessage = messages[0];
        if (sourceMessage) {
          return { threadId: task.taskThreadId, sourceMessage: toTaskThreadMessage(sourceMessage) };
        }
      }
    }

    const parentThread = await threadStore.get(task.threadId);
    const userId = body.data.userId ?? task.userId ?? parentThread?.createdBy ?? 'default-user';
    const taskThread = await threadStore.create(userId, formatTaskThreadTitle(task.title), parentThread?.projectPath);

    if (parentThread?.participants?.length) {
      await threadStore.addParticipants(taskThread.id, parentThread.participants);
    }

    const originalSource = task.sourceMessageId ? await messageStore.getById(task.sourceMessageId) : null;
    const sourceMessage = await messageStore.append({
      userId: originalSource?.userId ?? userId,
      catId: originalSource?.catId ?? null,
      content: originalSource?.content ?? formatTaskSourceContent(task),
      mentions: originalSource?.mentions ? [...originalSource.mentions] : [],
      timestamp: originalSource?.timestamp ?? task.createdAt,
      threadId: taskThread.id,
      ...(originalSource?.contentBlocks ? { contentBlocks: originalSource.contentBlocks } : {}),
      ...(originalSource?.metadata ? { metadata: originalSource.metadata } : {}),
      ...(originalSource?.origin ? { origin: originalSource.origin } : {}),
      ...(originalSource?.source ? { source: originalSource.source } : {}),
    });

    const updated = await taskStore.update(task.id, {
      taskThreadId: taskThread.id,
      ...(task.sourceMessageId ? {} : { sourceMessageId: sourceMessage.id }),
    });
    if (updated) {
      socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', updated);
    }

    return { threadId: taskThread.id, sourceMessage: toTaskThreadMessage(sourceMessage) };
  });

  // PATCH /api/tasks/:id
  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const updated = await taskStore.update(id, toUpdateInput(result.data));
    if (!updated) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);

    return updated;
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await taskStore.delete(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    reply.status(204);
  });
};
