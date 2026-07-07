import type { ChatMessage } from '@/stores/chat-types';
import { classifyRuntimeSystemEvent } from './runtime-notices';

const MODEL_SIGNATURE_LINE_RE = /^\s*\[[^\]]*(?:gpt|opus|claude|codex|gemini|kimi|模型)[^\]]*(?:🐾|📋)?\]\s*$/i;
const MODEL_METADATA_LINE_RE = /\bmodel\s*=\s*[a-z0-9._/-]+/i;
const IDENTITY_PREAMBLE_RE = /当前会话身份标注|身份标注为/i;
const SKILLS_BUDGET_WARNING_RE = /Exceeded\s+skills\s+context\s+budget|model-visible\s+skills\s+list/i;
const TOOL_TELEMETRY_LINE_RE =
  /(?:执行已完成，但没有返回文本|记录到\s*\d+\s*个工具事件|最后进度：.*(?:command_execution|file_change|mcp:|exit_code))/i;

export function sanitizeAgentVisibleContent(content: string): string {
  const lines = content.split(/\r?\n/);
  const cleaned: string[] = [];

  for (const line of lines) {
    if (MODEL_SIGNATURE_LINE_RE.test(line)) continue;
    if (MODEL_METADATA_LINE_RE.test(line)) continue;
    if (IDENTITY_PREAMBLE_RE.test(line)) continue;
    if (SKILLS_BUDGET_WARNING_RE.test(line)) continue;
    if (TOOL_TELEMETRY_LINE_RE.test(line)) continue;
    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function isUserVisibleChatMessage(message: ChatMessage): boolean {
  if (message.origin === 'briefing') {
    return false;
  }

  if (
    message.type === 'connector' &&
    classifyRuntimeSystemEvent({
      id: message.id,
      content: message.content,
      source: message.source,
      threadId: message.threadId,
      timestamp: message.timestamp,
    })
  ) {
    return false;
  }

  if (message.type === 'assistant' && message.origin === 'stream' && message.isStreaming) {
    return false;
  }

  if (message.type === 'summary' || message.type === 'system' || message.type === 'connector') {
    return true;
  }

  if (message.type === 'user' && !message.catId) {
    return true;
  }

  if (message.isStreaming) return true;
  if (message.contentBlocks?.length) return true;
  if (sanitizeAgentVisibleContent(message.content).trim().length > 0) return true;
  if (message.extra?.rich?.blocks?.length) return true;
  if (message.extra?.crossPost) return true;
  if (message.thinking) return true;

  return false;
}

export function isUnreadCountableChatMessage(message: ChatMessage): boolean {
  if (!isUserVisibleChatMessage(message)) return false;
  if (!message.mentionsUser && message.extra?.systemKind === 'a2a_routing') return false;
  if (message.extra?.systemKind === 'progress_heartbeat') return false;
  if (!message.mentionsUser && message.variant === 'a2a_followup') return false;
  const hasPrimarySurface =
    sanitizeAgentVisibleContent(message.content).trim().length > 0 ||
    !!message.contentBlocks?.length ||
    !!message.extra?.rich?.blocks?.length ||
    !!message.extra?.crossPost;
  if (message.type === 'assistant' && !message.mentionsUser && !hasPrimarySurface) return false;
  return true;
}
