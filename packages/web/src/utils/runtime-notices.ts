'use client';

import type { ConnectorSourceData, RuntimeWarning } from '@/stores/chat-types';

export interface RuntimeSystemEvent {
  id: string;
  kind: 'startup_recovery';
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

export function classifyRuntimeSystemEvent(input: {
  id?: string;
  content?: string;
  source?: ConnectorSourceData;
  threadId?: string;
  timestamp?: number;
}): RuntimeSystemEvent | null {
  const message = shortMessage(input.content ?? '');
  if (!message) return null;
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
