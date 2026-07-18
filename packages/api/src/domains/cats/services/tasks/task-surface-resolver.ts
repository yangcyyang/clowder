import type { TaskItem } from '@cat-cafe/shared';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';

export type TaskSurfaceBinding =
  | { outcome: 'none' }
  | { outcome: 'ambiguous'; taskIds: readonly string[] }
  | { outcome: 'bound'; task: TaskItem; surface: 'task_thread' | 'source_message' | 'thread' };

export function taskSurfacePromptContext(binding: TaskSurfaceBinding):
  | {
      id: string;
      parentThreadId: string;
      taskThreadId?: string;
      sourceMessageId?: string;
      ownerCatId: string | null;
      status: string;
    }
  | undefined {
  if (binding.outcome !== 'bound') return undefined;
  return {
    id: binding.task.id,
    parentThreadId: binding.task.threadId,
    ...(binding.task.taskThreadId ? { taskThreadId: binding.task.taskThreadId } : {}),
    ...(binding.task.sourceMessageId ? { sourceMessageId: binding.task.sourceMessageId } : {}),
    ownerCatId: binding.task.ownerCatId,
    status: binding.task.status,
  };
}

async function taskBelongsToUser(
  task: TaskItem,
  userId: string,
  threadStore?: Pick<IThreadStore, 'get'>,
): Promise<boolean> {
  if (task.userId && task.userId !== userId) return false;
  if (!threadStore) return task.userId === userId;
  const parentThread = await threadStore.get(task.threadId);
  return parentThread?.createdBy === userId;
}

function uniqueTasks(tasks: readonly TaskItem[]): TaskItem[] {
  return [...new Map(tasks.map((task) => [task.id, task])).values()];
}

/**
 * Resolve the authoritative task attached to an execution surface.
 *
 * F194 keeps the task on its parent thread while the invocation runs in the
 * dedicated task thread. All prompt and callback consumers must use this
 * resolver instead of assuming task.threadId === invocation.threadId.
 */
export async function resolveTaskSurfaceBinding(input: {
  taskStore: ITaskStore;
  threadStore?: Pick<IThreadStore, 'get'>;
  userId: string;
  executionThreadId: string;
  currentUserMessageId?: string;
}): Promise<TaskSurfaceBinding> {
  const direct = uniqueTasks(await Promise.resolve(input.taskStore.listByThread(input.executionThreadId)));
  const workTasks = await Promise.resolve(input.taskStore.listByKind('work'));
  const linked = uniqueTasks(workTasks.filter((task) => task.taskThreadId === input.executionThreadId));
  const scopedLinked = (
    await Promise.all(
      linked.map(async (task) => ((await taskBelongsToUser(task, input.userId, input.threadStore)) ? task : null)),
    )
  ).filter((task): task is TaskItem => task !== null);

  if (scopedLinked.length > 1) {
    return { outcome: 'ambiguous', taskIds: scopedLinked.map((task) => task.id).sort() };
  }
  const linkedTask = scopedLinked[0];
  if (linkedTask) {
    return { outcome: 'bound', task: linkedTask, surface: 'task_thread' };
  }

  const scopedDirect = (
    await Promise.all(
      direct.map(async (task) => ((await taskBelongsToUser(task, input.userId, input.threadStore)) ? task : null)),
    )
  ).filter((task): task is TaskItem => task !== null);
  const sourceMatches = input.currentUserMessageId
    ? scopedDirect.filter((task) => task.sourceMessageId === input.currentUserMessageId)
    : [];
  if (sourceMatches.length > 1) {
    return { outcome: 'ambiguous', taskIds: sourceMatches.map((task) => task.id).sort() };
  }
  const sourceTask = sourceMatches[0];
  if (sourceTask) {
    return { outcome: 'bound', task: sourceTask, surface: 'source_message' };
  }
  // A parent thread may legitimately hold many unrelated tasks. Without an
  // exact source-message match it is not an execution binding, so do not guess
  // merely because one task happens to exist there.
  return { outcome: 'none' };
}

export async function taskIsAccessibleFromExecutionSurface(input: {
  taskStore: ITaskStore;
  task: TaskItem;
  threadStore?: Pick<IThreadStore, 'get'>;
  userId: string;
  executionThreadId: string;
}): Promise<boolean> {
  // Preserve the existing invocation-thread capability for ordinary tasks.
  // The extra user/parent verification is required only for the new reverse
  // taskThreadId alias, which otherwise could be forged by foreign task data.
  if (input.task.threadId === input.executionThreadId) return true;
  if (input.task.taskThreadId !== input.executionThreadId) return false;
  const binding = await resolveTaskSurfaceBinding({
    taskStore: input.taskStore,
    threadStore: input.threadStore,
    userId: input.userId,
    executionThreadId: input.executionThreadId,
  });
  return binding.outcome === 'bound' && binding.surface === 'task_thread' && binding.task.id === input.task.id;
}
