import type { TaskItem, TaskStatus } from '@cat-cafe/shared';

const ATTENTION_STATUSES: ReadonlySet<TaskStatus> = new Set(['in_review', 'blocked', 'failed']);

export function isTaskAttentionStatus(status: TaskStatus): boolean {
  return ATTENTION_STATUSES.has(status);
}

export function countAttentionTasks(tasks: readonly TaskItem[]): number {
  return tasks.filter((task) => isTaskAttentionStatus(task.status)).length;
}

export function getTaskAttentionToast(task: TaskItem): {
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
} | null {
  if (!isTaskAttentionStatus(task.status)) return null;
  const title = task.title.trim() || '未命名任务';
  if (task.status === 'in_review') {
    return { type: 'success', title: '任务待验收', message: title };
  }
  if (task.status === 'blocked') {
    return { type: 'error', title: '任务阻塞', message: title };
  }
  return { type: 'error', title: '任务失败', message: title };
}
