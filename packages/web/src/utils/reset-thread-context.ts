import { apiFetch } from './api-client';

export const RESET_CONTEXT_CONFIRMATION = '已重置：该线程 reset 前的对话与未读不再进入上下文';

export async function resetThreadContext(threadId: string): Promise<void> {
  const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/reset-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string; detail?: string; code?: string } | null;
  if (res.status === 409 || body?.code === 'CONTEXT_RESET_BUSY') {
    throw new Error('猫猫正在工作或队列中，请完成后重试');
  }
  throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
}
