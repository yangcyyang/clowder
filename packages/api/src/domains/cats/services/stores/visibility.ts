/**
 * Message Visibility — F35 Whisper + System-user exemption
 * Pure functions for determining whether a message is visible to a given viewer.
 */

import type { CatId } from '@cat-cafe/shared';
import type { StoredMessage } from './ports/MessageStore.js';

/**
 * System-level userIds whose messages are visible to ALL thread participants
 * regardless of the per-user filter (scheduler, system, etc.).
 */
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set(['scheduler', 'system']);

/**
 * Returns true if a message was authored by a trusted system-level source.
 *
 * Historical writes use `catId: 'system'`; newer display-only badges (for example
 * persisted ACP errors) use `catId: null`. Both must bypass per-user filtering.
 */
export function isSystemUserMessage(msg: Pick<StoredMessage, 'userId' | 'catId'>): boolean {
  return SYSTEM_USER_IDS.has(msg.userId) && (msg.catId === 'system' || msg.catId === null);
}

/** Who is viewing */
export type Viewer = { readonly type: 'user' } | { readonly type: 'cat'; readonly catId: CatId };

/**
 * Check if a message is visible to the given viewer.
 *
 * Rules:
 * - User (铲屎官) always sees everything
 * - Public messages (visibility undefined or 'public') are visible to all
 * - Revealed whispers (revealedAt set) are visible to all
 * - Unrevealed whispers are only visible to recipients listed in whisperTo
 */
export function canViewMessage(msg: StoredMessage, viewer: Viewer): boolean {
  if (viewer.type === 'user') return true;

  if (!msg.visibility || msg.visibility === 'public') return true;

  if (msg.visibility === 'whisper') {
    if (msg.revealedAt) return true;
    return msg.whisperTo?.includes(viewer.catId) ?? false;
  }

  return false;
}

/**
 * 摘要压缩只能消费已经公开给整条线程的实质消息。
 *
 * 这里故意不采用某只猫或用户的 viewer 视角：未 reveal 的 whisper 即使对
 * 收件猫可见，也不能进入线程级摘要，否则摘要会把私聊内容扩散给所有参与者。
 */
export function isSummaryCompactionEligibleMessage(msg: StoredMessage): boolean {
  if (msg.deliveryStatus && msg.deliveryStatus !== 'delivered') return false;
  if (msg.deletedAt || msg._tombstone) return false;
  if (SYSTEM_USER_IDS.has(msg.userId) || msg.catId === 'system') return false;
  if (msg.origin === 'progress' || msg.origin === 'briefing') return false;
  if (msg.visibility === 'whisper' && !msg.revealedAt) return false;
  return true;
}

const TOOL_TELEMETRY_LINE_RE =
  /(?:执行已完成，但没有返回文本|记录到\s*\d+\s*个工具事件|最后进度：.*(?:command_execution|file_change|mcp:|exit_code))/i;
const STARTUP_RECOVERY_RE = /运行服务已恢复|已自动接续|process_restart|服务刚重启/i;

function sanitizeUnreadVisibleContent(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !TOOL_TELEMETRY_LINE_RE.test(line))
    .join('\n')
    .trim();
}

export function isUserVisibleUnreadMessage(msg: StoredMessage): boolean {
  if (msg.deletedAt || msg._tombstone) return false;
  if (msg.origin === 'briefing') return false;
  if (msg.origin === 'progress') return false;
  if (msg.source?.connector === 'task-system') return false;
  if (!msg.mentionsUser && msg.extra?.systemKind === 'a2a_routing') return false;
  if (msg.extra?.systemKind === 'progress_heartbeat') return false;
  if (msg.source?.connector === 'startup-reconciler' || STARTUP_RECOVERY_RE.test(msg.content)) return false;
  if (msg.contentBlocks?.length) return true;
  if (sanitizeUnreadVisibleContent(msg.content).length > 0) return true;
  if (msg.extra?.rich?.blocks?.length) return true;
  if (msg.extra?.crossPost) return true;
  return false;
}
