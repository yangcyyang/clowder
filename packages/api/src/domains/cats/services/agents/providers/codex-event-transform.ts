import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';
import { normalizeTaskStatus } from '../invocation/invoke-helpers.js';

// F060: Allowed image MIME types and max base64 payload size (5 MB encoded ≈ 3.75 MB decoded)
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const MAX_BASE64_LENGTH = 5 * 1024 * 1024;

/**
 * Mutable state for tracking Codex text events.
 *
 * Codex CLI currently reports both process updates and final answers as
 * `item.completed` / `agent_message`. In streaming mode, we keep the latest
 * text as a candidate answer; if another message/tool event arrives before
 * the turn ends, the previous candidate is process text and should render as
 * `thinking` instead of answer content.
 */
export interface CodexStreamState {
  hadPriorTextTurn: boolean;
  pendingTextTurn?: string;
  lastSuppressedThinkingText?: string;
  lastCompletionActivitySummary?: string;
  completionFallbackEmitted?: boolean;
}

const MAX_COMPLETION_ACTIVITY_SUMMARY_LENGTH = 220;

function createTextMessage(catId: CatId, content: string): AgentMessage {
  return {
    type: 'text',
    catId,
    content,
    timestamp: Date.now(),
  };
}

function createThinkingMessage(catId: CatId, text: string): AgentMessage {
  return {
    type: 'system_info',
    catId,
    content: JSON.stringify({ type: 'thinking', catId, text }),
    timestamp: Date.now(),
  };
}

function compactSummary(text: string): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (compacted.length <= MAX_COMPLETION_ACTIVITY_SUMMARY_LENGTH) return compacted;
  return `${compacted.slice(0, MAX_COMPLETION_ACTIVITY_SUMMARY_LENGTH - 1)}…`;
}

function rememberCompletionActivity(state: CodexStreamState | undefined, summary: string): void {
  if (!state) return;
  const text = compactSummary(summary);
  if (!text) return;
  state.lastCompletionActivitySummary = text;
}

function takePendingText(state: CodexStreamState): string | null {
  const text = state.pendingTextTurn;
  delete state.pendingTextTurn;
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

export function flushCodexPendingText(state: CodexStreamState, catId: CatId): AgentMessage | null {
  const text = takePendingText(state);
  if (!text) return null;
  state.hadPriorTextTurn = true;
  return createTextMessage(catId, text);
}

export function flushCodexCompletionText(state: CodexStreamState, catId: CatId): AgentMessage | null {
  const text = takePendingText(state);
  if (text) {
    state.hadPriorTextTurn = true;
    return createTextMessage(catId, text);
  }
  return null;
}

function flushCodexPendingThinking(state: CodexStreamState | undefined, catId: CatId): AgentMessage | null {
  if (!state) return null;
  const text = takePendingText(state);
  if (!text) return null;
  state.lastSuppressedThinkingText = compactSummary(text);
  return createThinkingMessage(catId, text);
}

function withPendingThinking(
  state: CodexStreamState | undefined,
  catId: CatId,
  result: AgentMessage | AgentMessage[] | null,
): AgentMessage | AgentMessage[] | null {
  const thinking = flushCodexPendingThinking(state, catId);
  if (!thinking) return result;
  if (result === null) return thinking;
  return Array.isArray(result) ? [thinking, ...result] : [thinking, result];
}

/**
 * Transform a raw Codex CLI NDJSON event into an AgentMessage.
 * Returns null to skip events we don't care about.
 *
 * When `state` is provided, Codex agent_message text is buffered until
 * `turn.completed` (or service end-of-stream) so process chatter can be
 * separated from the final answer.
 */
export function transformCodexEvent(
  event: unknown,
  catId: CatId,
  state?: CodexStreamState,
): AgentMessage | AgentMessage[] | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as Record<string, unknown>;

  if (e.type === 'thread.started') {
    const threadId = e.thread_id;
    if (typeof threadId !== 'string') return null;
    return {
      type: 'session_init',
      catId,
      sessionId: threadId,
      timestamp: Date.now(),
    };
  }

  if (e.type === 'turn.completed') {
    return state ? flushCodexCompletionText(state, catId) : null;
  }

  // F045: todo_list (started/updated/completed) → system_info(task_progress)
  // Checked BEFORE item.started/item.completed type guards below
  const isTodoList =
    (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') &&
    (e.item as Record<string, unknown> | undefined)?.type === 'todo_list';
  if (isTodoList) {
    const todoItem = e.item as Record<string, unknown>;
    const rawItems = Array.isArray(todoItem.todo_items)
      ? (todoItem.todo_items as Array<Record<string, unknown>>)
      : Array.isArray(todoItem.items)
        ? (todoItem.items as Array<Record<string, unknown>>)
        : [];
    const tasks = rawItems.map((t, i) => {
      const subject = typeof t.content === 'string' ? t.content : typeof t.text === 'string' ? t.text : '';
      const rawStatus =
        typeof t.status === 'string'
          ? t.status
          : typeof t.completed === 'boolean'
            ? t.completed
              ? 'completed'
              : 'pending'
            : 'pending';
      return {
        id: typeof t.id === 'string' ? t.id : `task-${i}`,
        subject: subject.slice(0, 120),
        status: normalizeTaskStatus(rawStatus),
      };
    });
    rememberCompletionActivity(state, `todo_list ${e.type}: tasks=${tasks.length}`);
    return withPendingThinking(state, catId, {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'task_progress', catId, action: 'snapshot', tasks }),
      timestamp: Date.now(),
    });
  }

  if (e.type === 'item.started') {
    const item = e.item as Record<string, unknown> | undefined;

    // F045: mcp_tool_call started → tool_use
    if (item?.type === 'mcp_tool_call') {
      const server = typeof item.server === 'string' ? item.server : 'unknown';
      const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
      const args =
        typeof item.arguments === 'object' && item.arguments !== null
          ? (item.arguments as Record<string, unknown>)
          : {};
      rememberCompletionActivity(state, `mcp:${server}/${tool} started`);
      return withPendingThinking(state, catId, {
        type: 'tool_use',
        catId,
        toolName: `mcp:${server}/${tool}`,
        toolInput: args,
        timestamp: Date.now(),
      });
    }

    if (item?.type !== 'command_execution') return null;
    const command = item.command;
    if (typeof command !== 'string') return null;
    rememberCompletionActivity(state, `command_execution started: ${command}`);
    return withPendingThinking(state, catId, {
      type: 'tool_use',
      catId,
      toolName: 'command_execution',
      toolInput: { command },
      timestamp: Date.now(),
    });
  }

  if (e.type === 'error') {
    const message = e.message;
    if (typeof message !== 'string') return null;
    const text = message.trim();
    // Reconnecting… lines stream to UI as progress
    if (text.startsWith('Reconnecting...')) return { type: 'system_info', catId, content: text, timestamp: Date.now() };
    // Non-Reconnecting errors: return null — CodexAgentService collects them via
    // collectCodexStreamError() and surfaces them as diagnostics in the exit error.
    return null;
  }

  if (e.type !== 'item.completed') return null;

  const item = e.item as Record<string, unknown> | undefined;

  if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim().length > 0) {
    if (!state) return createTextMessage(catId, item.text);

    const thinking = flushCodexPendingThinking(state, catId);
    state.pendingTextTurn = item.text;
    return thinking;
  }

  if (item?.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';

    const sections: string[] = [];
    if (command) sections.push(`command: ${command}`);
    sections.push(`status: ${status}`);
    if (exitCode !== null) sections.push(`exit_code: ${exitCode}`);
    const trimmedOutput = output.trimEnd();
    if (trimmedOutput) sections.push(trimmedOutput);

    rememberCompletionActivity(
      state,
      `command_execution ${status}: ${command || 'unknown command'}${exitCode !== null ? ` exit_code=${exitCode}` : ''}`,
    );
    return withPendingThinking(state, catId, {
      type: 'tool_result',
      catId,
      content: sections.join('\n'),
      timestamp: Date.now(),
    });
  }

  if (item?.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const status = typeof item.status === 'string' ? item.status : 'completed';
    rememberCompletionActivity(state, `file_change ${status}: changes=${changes.length}`);
    return withPendingThinking(state, catId, {
      type: 'tool_use',
      catId,
      toolName: 'file_change',
      toolInput: { status, changes: changes.length },
      timestamp: Date.now(),
    });
  }

  // F045: mcp_tool_call completed → tool_result (+ F060: optional rich_block for images)
  if (item?.type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : 'unknown';
    const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
    const status = typeof item.status === 'string' ? item.status : 'completed';
    const result = item.result as Record<string, unknown> | undefined;
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const typed = contentArr as Array<Record<string, unknown>>;
    const textParts = typed.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);

    const toolLabel = `mcp:${server}/${tool}`;
    rememberCompletionActivity(state, `${toolLabel} ${status}`);
    const toolResult: AgentMessage = {
      type: 'tool_result',
      catId,
      content: `${toolLabel} (${status})\n${textParts.join('\n')}`.trim(),
      timestamp: Date.now(),
    };

    // F060: Extract image content blocks → media_gallery rich block
    // P2 fix: mimeType whitelist + base64 size guard
    const imageItems = typed
      .filter(
        (c) =>
          c.type === 'image' &&
          typeof c.data === 'string' &&
          typeof c.mimeType === 'string' &&
          IMAGE_MIME_WHITELIST.has(c.mimeType as string) &&
          (c.data as string).length <= MAX_BASE64_LENGTH,
      )
      .map((c) => ({
        url: `data:${c.mimeType as string};base64,${c.data as string}`,
        alt: 'MCP tool output image',
      }));

    if (imageItems.length === 0) {
      return withPendingThinking(state, catId, toolResult);
    }

    const richBlock: AgentMessage = {
      type: 'system_info',
      catId,
      content: JSON.stringify({
        type: 'rich_block',
        block: {
          id: `mcp-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'media_gallery',
          v: 1,
          title: toolLabel,
          items: imageItems,
        },
      }),
      timestamp: Date.now(),
    };

    return withPendingThinking(state, catId, [toolResult, richBlock]);
  }

  // F045: web_search → system_info — count only, no query (privacy)
  if (item?.type === 'web_search') {
    rememberCompletionActivity(state, 'web_search completed');
    return withPendingThinking(state, catId, {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'web_search', catId, count: 1 }),
      timestamp: Date.now(),
    });
  }

  // F045: reasoning → system_info(thinking)
  if (item?.type === 'reasoning' && typeof item.text === 'string' && item.text.length > 0) {
    rememberCompletionActivity(state, 'reasoning completed');
    return withPendingThinking(state, catId, createThinkingMessage(catId, item.text));
  }

  // F045: item-level error → system_info(warning)
  if (item?.type === 'error' && typeof item.message === 'string') {
    rememberCompletionActivity(state, 'warning emitted');
    return withPendingThinking(state, catId, {
      type: 'system_info',
      catId,
      content: JSON.stringify({ type: 'warning', catId, message: item.message }),
      timestamp: Date.now(),
    });
  }

  return null;
}
