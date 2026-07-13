export type GrokStreamEvent =
  | { kind: 'thought'; data: string }
  | { kind: 'text'; data: string }
  | { kind: 'error'; message: string }
  | { kind: 'end'; sessionId?: string; stopReason?: string; requestId?: string }
  | { kind: 'unknown' };

export function transformGrokEvent(event: unknown): GrokStreamEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { kind: 'unknown' };
  const record = event as Record<string, unknown>;
  if (record.type === 'thought' && typeof record.data === 'string') {
    return { kind: 'thought', data: record.data };
  }
  if (record.type === 'text' && typeof record.data === 'string') {
    return { kind: 'text', data: record.data };
  }
  if (record.type === 'error' && typeof record.message === 'string') {
    return { kind: 'error', message: record.message };
  }
  if (record.type === 'end') {
    return {
      kind: 'end',
      ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
      ...(typeof record.stopReason === 'string' ? { stopReason: record.stopReason } : {}),
      ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
    };
  }
  return { kind: 'unknown' };
}
