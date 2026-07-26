/**
 * Task lifecycle tools — batch 2-C (Raft CLI parity)
 *
 * Wraps the dual-auth (invocation + agent-key) /api/callbacks/task-* endpoints
 * added in packages/api/src/routes/callback-task-routes.ts. These are a
 * parallel surface to the legacy cat_cafe_create_task / cat_cafe_claim_task /
 * cat_cafe_update_task / cat_cafe_list_tasks tools (which stay invocation-only,
 * unchanged) — the new cat_cafe_task_* names are the ones registered for the
 * agent-key tier (server-toolsets.ts AGENT_KEY_TOOLS) so persistent non-Claude
 * agents (e.g. Antigravity) get task lifecycle + message search too.
 *
 * Design doc: docs/research/clowder-raft-thread-task-design.md §5.1/§5.2/§5B.5
 */

import { z } from 'zod';
import { agentKeyCatIdSchema, callbackGet, callbackPost, handlePostMessage } from './callback-tools.js';
import { errorResult, type ToolResult } from './file-tools.js';

const taskStatusEnum = z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']);

export const taskClaimInputSchema = {
  taskId: z.string().min(1).optional().describe('Claim an existing task by ID. Exactly one of taskId/messageId required.'),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Convert this message into a task and claim it in one step (Raft "task claim --message-id"). ' +
        'Use when the work item only exists as a message so far — do NOT create a new task for it first, ' +
        'this does both atomically. Exactly one of taskId/messageId required. ' +
        'Ticket-hygiene guardrails on this path (batch4-B5, all return a Chinese `hint` explaining what to do instead): ' +
        '(1) the message must be a TOP-LEVEL channel/DM message — a message inside a branch/discussion thread is ' +
        'rejected (403 TASK_CLAIM_THREAD_NOT_TOP_LEVEL), discussion context is not a claimable work item; ' +
        '(2) the message must be HUMAN-authored — a cat-authored message is rejected (403 ' +
        'TASK_CLAIM_CAT_AUTHORED_MESSAGE), your own work (progress notes, handoffs, reviews) must go through ' +
        'cat_cafe_task_create instead, never through claiming a message; ' +
        '(3) if you already own an ACTIVE task (todo/doing/in_review) in this same thread, this call is downgraded: ' +
        'no new task is created — the message is attached as a progress note on your existing active task instead ' +
        '(response has downgraded:true); if this really is separate new work, use cat_cafe_task_create explicitly ' +
        'instead of message-id claiming; ' +
        '(4) requires the `title` parameter (see below) — missing/too-long title is rejected (400 ' +
        'TASK_CLAIM_TITLE_REQUIRED / TASK_CLAIM_TITLE_TOO_LONG).',
    ),
  title: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Required when claiming by messageId (ignored/not needed for taskId claims): a short, self-authored task ' +
        'title, 1-60 characters after trimming whitespace. Do NOT paste or truncate the raw message text as the ' +
        'title — write a real short name for the work item. The original message full text is preserved ' +
        'automatically as the first post in the task discussion thread, so nothing is lost by keeping the title ' +
        'short. Missing, empty, or over 60 chars is rejected with a Chinese hint explaining this.',
    ),
  why: z.string().max(1000).optional().describe('Optional note explaining why you are claiming this task'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const taskCreateInputSchema = {
  title: z.string().min(1).max(200).describe('Task title — what needs to be done'),
  why: z.string().max(1000).optional().describe('Why this task matters (context for whoever picks it up)'),
  ownerCatId: z.string().min(1).optional().describe('Cat ID to assign the task to (optional, defaults to unassigned)'),
  subjectKey: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Dedup key. If a task already exists for this subjectKey, no duplicate is created — the existing task is ' +
        'returned with status:"existing_task" and a hint to task_claim it instead. Use a stable key ' +
        '(e.g. "pr:{owner/repo}#{num}" or your own domain key) when the same work item might be created more than once.',
    ),
  parentTaskId: z.string().min(1).optional().describe('Optional parent task ID for an intentional child task'),
  threadId: z
    .string()
    .min(1)
    .optional()
    .describe('Target thread ID. Required for agent-key auth (no default thread). Omit for invocation auth.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const taskUpdateInputSchema = {
  taskId: z.string().min(1).describe('The ID of the task to update'),
  status: taskStatusEnum
    .optional()
    .describe(
      'New task status. Transitions are validated: a task cannot jump straight to "done" from anything other ' +
        'than "in_review" (mark in_review with evidence first), and "done" is terminal (no further updates).',
    ),
  failureClass: z
    .enum(['agent_error', 'build_failed', 'test_failed', 'timeout', 'budget_exhausted', 'infra_error', 'manual_fail'])
    .optional()
    .describe('Failure classification, required context when setting status to "failed"'),
  failureReason: z.string().max(2000).optional().describe('Free-text failure detail'),
  why: z.string().max(1000).optional().describe('Optional note explaining the status change'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const taskUnclaimInputSchema = {
  taskId: z.string().min(1).describe('The ID of the task to unclaim'),
  why: z.string().max(1000).optional().describe('Optional note explaining why you are letting this task go'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const taskListInputSchema = {
  threadId: z.string().min(1).optional().describe('Optional thread ID filter'),
  status: taskStatusEnum.optional().describe('Optional task status filter'),
  kind: z.enum(['work', 'pr_tracking']).optional().describe('Optional task kind filter'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const replyInThreadInputSchema = {
  messageId: z
    .string()
    .min(1)
    .describe(
      'The message the reply is anchored to. The reply is routed into the discussion thread already attached ' +
        "to that message's task (Raft: reply always reuses the exact target from the received message). " +
        'If no thread is anchored to this message yet (it was never converted into a task with a discussion ' +
        'thread), this fails with a clear error — use task_claim(messageId) first, or use post_message/' +
        'cross_post_message instead.',
    ),
  content: z.string().min(1).describe('The message content to post into the anchored thread'),
  replyTo: z.string().optional().describe('Optional message ID within the anchored thread to reply to'),
  clientMessageId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional idempotency key for at-least-once delivery de-duplication'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export const searchMessagesInputSchema = {
  q: z.string().trim().min(1).max(200).describe('Keyword search query (relevance-scored, not semantic search)'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
  threadId: z.string().min(1).optional().describe('Optional: restrict search to one thread'),
  catId: z.string().min(1).optional().describe("Optional: filter by speaker catId, or 'user' for human messages"),
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleTaskClaim(input: {
  taskId?: string | undefined;
  messageId?: string | undefined;
  title?: string | undefined;
  why?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/task-claim',
    {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.why ? { why: input.why } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleTaskCreate(input: {
  title: string;
  why?: string | undefined;
  ownerCatId?: string | undefined;
  subjectKey?: string | undefined;
  parentTaskId?: string | undefined;
  threadId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/task-create',
    {
      title: input.title,
      ...(input.why ? { why: input.why } : {}),
      ...(input.ownerCatId ? { ownerCatId: input.ownerCatId } : {}),
      ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleTaskUpdate(input: {
  taskId: string;
  status?: string | undefined;
  failureClass?: string | undefined;
  failureReason?: string | undefined;
  why?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/task-update',
    {
      taskId: input.taskId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.failureClass ? { failureClass: input.failureClass } : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      ...(input.why ? { why: input.why } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleTaskUnclaim(input: {
  taskId: string;
  why?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/task-unclaim',
    {
      taskId: input.taskId,
      ...(input.why ? { why: input.why } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleTaskList(input: {
  threadId?: string | undefined;
  status?: string | undefined;
  kind?: 'work' | 'pr_tracking' | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/task-list',
    {
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleReplyInThread(input: {
  messageId: string;
  content: string;
  replyTo?: string | undefined;
  clientMessageId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  const resolved = await callbackGet(
    '/api/callbacks/resolve-message-thread',
    { messageId: input.messageId },
    { agentKeyCatId: input.agentKeyCatId },
  );
  if (resolved.isError) return resolved;

  let threadId: string | undefined;
  try {
    const data = JSON.parse((resolved.content[0] as { text: string }).text) as { threadId?: string };
    threadId = data.threadId;
  } catch {
    // fall through to the error below
  }
  if (!threadId) {
    return errorResult('Failed to resolve the thread anchored to this message (malformed response).');
  }

  // Reuses the existing, fully-featured post-message pipeline (A2A mention
  // dispatch, freshness hold, agent-key dedup) unchanged — reply_in_thread
  // only adds the message->task-thread resolution step above.
  return handlePostMessage({
    threadId,
    content: input.content,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.agentKeyCatId ? { agentKeyCatId: input.agentKeyCatId } : {}),
  });
}

export async function handleSearchMessages(input: {
  q: string;
  limit?: number | undefined;
  threadId?: string | undefined;
  catId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackGet(
    '/api/callbacks/message-search',
    {
      q: input.q,
      ...(input.limit ? { limit: String(input.limit) } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.catId ? { catId: input.catId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const taskLifecycleTools = [
  {
    name: 'cat_cafe_task_claim',
    description:
      'Claim a task before starting action work — by taskId, or by messageId to convert a plain message into a ' +
      "task and claim it in one step (Raft: 'always claim a task before starting work'). " +
      'Use when: fulfilling a request requires action beyond just replying (running tools, writing code, making changes). ' +
      'NOT for: pure question-answering (no claim needed for that); NOT a bookkeeping action to repeat every turn — ' +
      'claim once at the start of a work item, then use cat_cafe_task_update / cat_cafe_post_progress for everything ' +
      'that follows (a real incident: re-claiming by messageId every turn on peer verdicts and your own handoff notes ' +
      'produced 8+ junk tickets titled with raw chat text in one night). ' +
      'messageId claims are guarded (batch4-B5 ticket hygiene, see the messageId/title parameter docs for exact ' +
      'error codes): only top-level channel/DM messages qualify (not messages inside a branch/discussion thread), ' +
      'only human-authored messages qualify (not your own or another cat\'s messages), an already-active task of ' +
      'yours in the same thread downgrades the call to a progress note instead of a new ticket, and a short ' +
      'self-authored `title` (1-60 chars, not the raw message text) is required. ' +
      'Output: task moves to doing, owned by you; conflicts return 409 with the current ownerCatId — stop instead ' +
      'of duplicating work; a messageId claim may also come back with downgraded:true (attached as progress to an ' +
      'existing task, not a new one — use cat_cafe_task_create if you really meant new independent work). ' +
      'GOTCHA: if claim fails, do not work on that task unless the owner/user explicitly redirects it to you.',
    inputSchema: taskClaimInputSchema,
    handler: handleTaskClaim,
  },
  {
    name: 'cat_cafe_task_create',
    description:
      'Create a new task — but check for an existing one first: if someone already sent this work item as a ' +
      'message, or you pass a subjectKey that matches an existing task, this returns status:"existing_task" ' +
      'instead of creating a duplicate (use cat_cafe_task_claim on it instead). ' +
      'Prefer independent subtasks over sequential chains when splitting work; leave subtasks unassigned by ' +
      'default so others can claim them rather than claiming everything yourself. ' +
      'Output: new task appears in the thread task panel with its own discussion thread already created.',
    inputSchema: taskCreateInputSchema,
    handler: handleTaskCreate,
  },
  {
    name: 'cat_cafe_task_update',
    description:
      'Update a task you own — status, failure detail, or a note. ' +
      'Status transitions are validated: you cannot jump straight to "done" without first marking "in_review" ' +
      '(mark in_review with evidence — test output, diff, screenshot — then done once verified). "done" is terminal. ' +
      'GOTCHA: you can only update tasks assigned to you.',
    inputSchema: taskUpdateInputSchema,
    handler: handleTaskUpdate,
  },
  {
    name: 'cat_cafe_task_unclaim',
    description:
      'Let go of a task you claimed but are not going to finish — releases ownership and returns it to "todo" ' +
      'so someone else (or you, later) can claim it. ' +
      'NOT for: tasks that are done (rejected — completed tasks cannot be unclaimed) or tasks owned by another cat.',
    inputSchema: taskUnclaimInputSchema,
    handler: handleTaskUnclaim,
  },
  {
    name: 'cat_cafe_task_list',
    description:
      'List tasks filtered by thread and/or status. Use before creating a new task to check for an existing one ' +
      '(query dedup), or to see what is blocked/in_review across a thread.',
    inputSchema: taskListInputSchema,
    handler: handleTaskList,
  },
  {
    name: 'cat_cafe_reply_in_thread',
    description:
      'Reply anchored to a specific message — routes into that message\'s task discussion thread (Raft: always ' +
      'reuse the exact target from the received message; post updates in the task\'s thread, not the main channel). ' +
      'Use when: continuing a discussion or reporting progress on a message that was already converted into a task. ' +
      'NOT for: messages that have no task/thread anchored yet — this fails with a clear error in that case ' +
      '(NO_ANCHORED_THREAD); use cat_cafe_task_claim(messageId) first, or use post_message/cross_post_message.',
    inputSchema: replyInThreadInputSchema,
    handler: handleReplyInThread,
  },
  {
    name: 'cat_cafe_search_messages',
    description:
      'Keyword search across channel messages (not semantic — relevance-scored keyword matching), returning ' +
      'msg-id + thread it came from + a content snippet for each hit. This is the first hop of the Raft-style ' +
      "search: 'search' finds the msg-id, then use cat_cafe_get_thread_context or cat_cafe_fetch_thread_history " +
      "with that threadId (and fromMessageId/toMessageId) as the second hop to read full surrounding context. " +
      'Use when: someone references a past discussion/decision that is not in your current context — search before ' +
      'answering from guesswork, and say so explicitly if the search finds nothing. ' +
      'NOT for: project knowledge/decisions/lessons (use cat_cafe_search_evidence instead) — this is raw channel history only.',
    inputSchema: searchMessagesInputSchema,
    handler: handleSearchMessages,
  },
] as const;
