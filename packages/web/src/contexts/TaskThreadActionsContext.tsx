'use client';

import { createContext, useContext } from 'react';
import type { TaskItem } from '@/stores/taskStore';

export interface TaskThreadActions {
  openTaskThread: (task: TaskItem) => void;
}

export const TaskThreadActionsContext = createContext<TaskThreadActions | null>(null);

export function useTaskThreadActions(): TaskThreadActions | null {
  return useContext(TaskThreadActionsContext);
}
