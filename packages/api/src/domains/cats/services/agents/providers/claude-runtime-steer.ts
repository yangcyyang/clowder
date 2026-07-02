import type { CatId } from '@cat-cafe/shared';
import type { CliStdinSink } from '../../../../../utils/cli-types.js';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export interface ClaudeRuntimeSteerChannel {
  threadId: string;
  catId: CatId | string;
  userId: string;
  invocationId?: string;
  startedAt: number;
  inject(content: string): boolean;
}

export interface ClaudeRuntimeSteerResult {
  ok: boolean;
  code?: 'STEER_V2_DISABLED' | 'NO_ACTIVE_CLAUDE_CHANNEL' | 'CLAUDE_STDIN_WRITE_FAILED';
  channel?: Omit<ClaudeRuntimeSteerChannel, 'inject'>;
}

function channelKey(threadId: string, catId: string): string {
  return `${threadId}:${catId}`;
}

const channels = new Map<string, ClaudeRuntimeSteerChannel>();

export function isClaudeRuntimeSteerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CAT_CAFE_STEER_V2_CLAUDE ?? env.CAT_CAFE_CLAUDE_STREAM_JSON_STEER ?? '';
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

export function buildClaudeStreamJsonUserMessage(content: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };
}

export function registerClaudeRuntimeSteerChannel(input: {
  threadId: string;
  catId: CatId | string;
  userId: string;
  invocationId?: string;
  sink: CliStdinSink;
}): () => void {
  const key = channelKey(input.threadId, String(input.catId));
  const channel: ClaudeRuntimeSteerChannel = {
    threadId: input.threadId,
    catId: input.catId,
    userId: input.userId,
    invocationId: input.invocationId,
    startedAt: Date.now(),
    inject(content: string): boolean {
      return input.sink.writeJsonLine(buildClaudeStreamJsonUserMessage(content));
    },
  };
  channels.set(key, channel);
  return () => {
    if (channels.get(key) === channel) channels.delete(key);
  };
}

export function injectClaudeRuntimeSteer(
  threadId: string,
  catId: string,
  userId: string,
  content: string,
): ClaudeRuntimeSteerResult {
  if (!isClaudeRuntimeSteerEnabled()) return { ok: false, code: 'STEER_V2_DISABLED' };
  const channel = channels.get(channelKey(threadId, catId));
  if (!channel || channel.userId !== userId) return { ok: false, code: 'NO_ACTIVE_CLAUDE_CHANNEL' };
  const ok = channel.inject(content);
  if (!ok) return { ok: false, code: 'CLAUDE_STDIN_WRITE_FAILED' };
  const { inject: _inject, ...safeChannel } = channel;
  return { ok: true, channel: safeChannel };
}

export function clearClaudeRuntimeSteerChannelsForTests(): void {
  channels.clear();
}
