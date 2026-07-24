'use client';

import type { ConnectorSourceData, RuntimeWarning } from '@/stores/chat-types';

export interface RuntimeSystemEvent {
  id: string;
  kind: 'startup_recovery' | 'task_system_notice';
  title: string;
  message: string;
  threadId?: string;
  timestamp: number;
}

const SKILL_BUDGET_RE = /Exceeded\s+skills\s+context\s+budget|model-visible\s+skills\s+list/i;
const CONTEXT_TRUNCATION_RE = /上下文.*截断|context.*truncat|context.*clip|prompt.*truncat/i;
const STARTUP_RECOVERY_RE = /运行服务已恢复|已自动接续|process_restart|服务刚重启/i;

function shortMessage(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function classifyRuntimeWarning(input: unknown): Omit<RuntimeWarning, 'id' | 'timestamp'> | null {
  const content = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (SKILL_BUDGET_RE.test(content)) {
    return {
      title: 'Skill 目录已裁剪',
      message: shortMessage(content),
      severity: 'warning',
    };
  }
  if (CONTEXT_TRUNCATION_RE.test(content)) {
    return {
      title: '上下文已截断',
      message: shortMessage(content),
      severity: 'warning',
    };
  }
  return null;
}

export function isStartupRecoverySource(source?: ConnectorSourceData): boolean {
  return source?.connector === 'startup-reconciler';
}

export function isTaskSystemNoticeSource(source?: ConnectorSourceData): boolean {
  return source?.connector === 'task-system' && source.meta?.presentation === 'system_notice';
}

export function classifyRuntimeSystemEvent(input: {
  id?: string;
  content?: string;
  source?: ConnectorSourceData;
  threadId?: string;
  timestamp?: number;
  /**
   * [thread-task-design §2 root cause 4 / §3 step 1.2] task_created_unclaimed
   * shares the exact same source shape (connector:'task-system' +
   * meta.presentation:'system_notice') as routine task-system chatter (status
   * flips etc.), which this classifier deliberately reroutes to the buried Ops
   * runtime-events panel so the main feed stays quiet. But "nobody has claimed
   * this task yet" is meant to be seen — diverting it silently is exactly the
   * "existing renderer doesn't recognize this systemKind" failure mode. Callers
   * pass the message's extra.systemKind through so this one kind can opt out of
   * the reroute while every other task-system notice keeps today's behavior.
   */
  extra?: { systemKind?: string };
}): RuntimeSystemEvent | null {
  const message = shortMessage(input.content ?? '');
  if (!message) return null;
  if (input.extra?.systemKind === 'task_created_unclaimed') return null;
  if (isTaskSystemNoticeSource(input.source)) {
    return {
      id: input.id ?? `runtime-event-${Date.now()}`,
      kind: 'task_system_notice',
      title: '任务系统事件',
      message,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      timestamp: input.timestamp ?? Date.now(),
    };
  }
  if (!isStartupRecoverySource(input.source) && !STARTUP_RECOVERY_RE.test(message)) return null;

  return {
    id: input.id ?? `runtime-event-${Date.now()}`,
    kind: 'startup_recovery',
    title: '运行服务已恢复',
    message,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    timestamp: input.timestamp ?? Date.now(),
  };
}
