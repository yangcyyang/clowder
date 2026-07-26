import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  callbackMemoryTools,
  callbackTools,
  distillationTools,
  evidenceTools,
  limbTools,
  reflectTools,
  richBlockRulesTools,
  scheduleTools,
  sessionChainTools,
  shellTools,
  signalStudyTools,
  signalsTools,
  skillTools,
  taskLifecycleTools,
  writeMemoryTools,
} from './tools/index.js';

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never) => Promise<unknown>;
};

/**
 * F061: CAT_CAFE_READONLY=true → whitelist-only tool registration.
 * Used by Antigravity's persistent MCP registration where callback credentials
 * are unavailable. Bridge handles writes; LS only gets read-only tools.
 *
 * Whitelist approach: new tools default to excluded (safer than blacklist).
 * Design doc: docs/discussions/2026-04-12-f061-antigravity-mcp-evolution-design.md
 */
export const READONLY_ALLOWED_TOOLS = new Set([
  // Evidence & knowledge (local SQLite, no credentials needed)
  'cat_cafe_search_evidence',
  'cat_cafe_reflect',
  'cat_cafe_get_rich_block_rules',
  // Session chain (read-only API calls, no callback creds needed)
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  // Skill router pull model (read-only local catalog)
  'cat_cafe_list_skills',
  'cat_cafe_read_skill',
  // Signals (read-only)
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_list_studies',
  // Shell exec (F061 Bug-F workaround — read-only whitelist enforced at tool level)
  'cat_cafe_shell_exec',
]);

/**
 * F178 Phase C: Tools unlocked when agent-key credentials are available in
 * READONLY mode. These are the KD-8 allowlist — callback-authenticated write
 * tools that persistent agents (Bengal) need. File/shell mutators stay blocked.
 */
export const AGENT_KEY_TOOLS = new Set([
  'cat_cafe_post_progress',
  'cat_cafe_post_message',
  'cat_cafe_cross_post_message',
  'cat_cafe_check_inbox',
  'cat_cafe_get_thread_context',
  'cat_cafe_fetch_thread_history',
  'cat_cafe_list_threads',
  // 批次 2-C: task-* dual-auth surface (docs/research/clowder-raft-thread-task-design.md
  // §5.1/§5B.5) — backed by /api/callbacks/task-* + message-search + resolve-message-thread,
  // all of which support agent-key auth (unlike the legacy cat_cafe_*_task tools above,
  // which stay invocation-only).
  'cat_cafe_task_claim',
  'cat_cafe_task_create',
  'cat_cafe_task_update',
  'cat_cafe_task_unclaim',
  'cat_cafe_task_list',
  'cat_cafe_reply_in_thread',
  'cat_cafe_search_messages',
]);

const isReadonly = process.env['CAT_CAFE_READONLY'] === 'true';
const hasAgentKey = !!(
  process.env['CAT_CAFE_AGENT_KEY_SECRET'] ||
  process.env['CAT_CAFE_AGENT_KEY_FILE'] ||
  process.env['CAT_CAFE_AGENT_KEY_FILES']
);

function applyReadonlyFilter(tools: readonly ToolDef[]): readonly ToolDef[] {
  if (!isReadonly) return tools;
  return tools.filter((t) => READONLY_ALLOWED_TOOLS.has(t.name) || (hasAgentKey && AGENT_KEY_TOOLS.has(t.name)));
}

const collabTools: readonly ToolDef[] = applyReadonlyFilter([
  ...callbackTools,
  ...taskLifecycleTools,
  ...richBlockRulesTools,
  ...scheduleTools,
  ...shellTools,
]);

const memoryTools: readonly ToolDef[] = applyReadonlyFilter([
  ...callbackMemoryTools,
  ...distillationTools,
  ...evidenceTools,
  ...reflectTools,
  ...sessionChainTools,
  ...skillTools,
  // F-F（批次 3，PRD-memory-upgrade.md）：猫主动写记忆——invocation-scoped only
  // (not added to READONLY_ALLOWED_TOOLS/AGENT_KEY_TOOLS, same posture as
  // cat_cafe_retain_memory_callback above).
  ...writeMemoryTools,
]);

const signalTools: readonly ToolDef[] = applyReadonlyFilter([...signalsTools, ...signalStudyTools]);

function registerTools(server: McpServer, tools: readonly ToolDef[]): void {
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      const result = await tool.handler(args as never);
      return {
        ...(result as Record<string, unknown>),
      } as { content: Array<{ type: 'text'; text: string }>; isError?: boolean; [key: string]: unknown };
    });
  }
}

export function registerCollabToolset(server: McpServer): void {
  registerTools(server, collabTools);
}

export function registerMemoryToolset(server: McpServer): void {
  registerTools(server, memoryTools);
}

export function registerSignalToolset(server: McpServer): void {
  registerTools(server, signalTools);
}

const limbNodeTools: readonly ToolDef[] = [...limbTools];

export function registerLimbToolset(server: McpServer): void {
  registerTools(server, limbNodeTools);
}

export function registerFullToolset(server: McpServer): void {
  registerCollabToolset(server);
  registerMemoryToolset(server);
  registerSignalToolset(server);
  registerLimbToolset(server);
}
