/**
 * QueueProcessor
 * 处理 InvocationQueue 中的排队条目：自动出队 + 暂停管理。
 *
 * 两个入口：
 * - onInvocationComplete（系统级）：invocation 完成后调用，succeeded 时自动出队
 * - processNext（用户级）：铲屎官手动触发处理自己的下一条
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type CatId, catRegistry, type TaskEvent, type TaskItem } from '@cat-cafe/shared';
import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { hydrateReplyPreview, type IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import { type MessageMetadata, mergeTokenUsage, type TokenUsage } from '../../types.js';
import { appendProjectHandoffLogForPromptProjects } from '../memory/ProjectProgressStore.js';
import { sanitizeAgentVisibleOutput } from '../routing/agent-output-sanitizer.js';
import {
  accumulateTextAggregate,
  accumulateTextParts,
  flattenTextParts,
  flattenTurnTextParts,
} from '../text-aggregation.js';
import { buildA2AIdempotencyKey } from './a2a-idempotency.js';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromAgentMessage,
  formatContinuationPrompt,
  isCollaborationContinuityCapsuleV1,
} from './CollaborationContinuityCapsule.js';
import { type FastLaneExecutionResult, FastLaneExecutor } from './FastLaneExecutor.js';
import {
  FastLaneRouter,
  IMAGE_GENERATION_WORKFLOW_ID,
  isFastLaneEnabled,
  PROJECT_INIT_WORKFLOW_ID,
} from './FastLaneRouter.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import type {
  ConsumedContinuationToken,
  InvocationFinalStatus,
  SessionContinuationCoordinator,
} from './SessionContinuationCoordinator.js';

/** Minimal interfaces for deps — avoid importing full types for testability */

const execFileAsync = promisify(execFile);
const GIT_ARTIFACT_MAX_FILE_BYTES = 1024 * 1024;

interface TrackerLike {
  start(threadId: string, catId: string, userId: string, catIds?: string[]): AbortController;
  startAll(threadId: string, catIds: string[], userId?: string): AbortController;
  complete(threadId: string, catId: string, controller?: AbortController): void;
  completeSlot?(threadId: string, catId: string, controller?: AbortController): void;
  completeAll(threadId: string, catIds: string[], controller?: AbortController): void;
  trackExternalSlot?(
    threadId: string,
    catId: string,
    controller: AbortController,
    userId?: string,
    catIds?: string[],
  ): boolean;
  has(threadId: string, catId?: string): boolean;
}

export interface InvocationRecordStoreLike {
  create(input: Record<string, unknown>): Promise<{ outcome: string; invocationId: string }>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
}

export interface RouterLike {
  routeExecution(
    userId: string,
    content: string,
    threadId: string,
    messageId: string | null,
    targetCats: string[],
    intent: { intent: string },
    opts?: Record<string, unknown>,
  ): AsyncIterable<{ type: string; catId?: string; [key: string]: unknown }>;
  ackCollectedCursors(userId: string, threadId: string, cursors: Map<string, string>): Promise<void>;
}

interface SocketManagerLike {
  broadcastAgentMessage(msg: unknown, threadId: string): void;
  broadcastToRoom(room: string, event: string, data: unknown): void;
  emitToUser(userId: string, event: string, data: unknown): void;
}

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface CatSupervisorLike {
  markProcessing(catIds: string | readonly string[]): Promise<void> | void;
  markOutput?(catIds: string | readonly string[]): Promise<void> | void;
  pauseForTool?(catIds: string | readonly string[]): Promise<void> | void;
  resumeAfterTool?(catIds: string | readonly string[]): Promise<void> | void;
  markIdle(catIds: string | readonly string[]): Promise<void> | void;
}

interface GitArtifactFile {
  path: string;
  added: number;
  removed: number;
}

interface GitArtifactSnapshot {
  files: GitArtifactFile[];
  totalAdded: number;
  totalRemoved: number;
}

type GitArtifactCollector = () => Promise<GitArtifactSnapshot>;

interface TokenUsageAggregate {
  catId: string;
  provider?: string;
  model: string;
  usage: TokenUsage;
}

interface ToolUsageTaskDraft {
  ts: string;
  catId: string;
  invocationId?: string;
  data: Record<string, unknown>;
}

interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
}

const TOKEN_PRICING_BY_MODEL: Record<string, TokenPricing> = {
  'claude-opus-4': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  'claude-sonnet-4': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  'claude-haiku-4': {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheCreationPerMillion: 1,
  },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
};

function findTokenPricing(model: string | undefined): TokenPricing | undefined {
  const normalized = model?.toLowerCase();
  if (!normalized) return undefined;
  return Object.entries(TOKEN_PRICING_BY_MODEL)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([key]) => normalized.includes(key))?.[1];
}

function computeTokenCostUsd(usage: TokenUsage, model: string | undefined): number | undefined {
  if (Number.isFinite(usage.costUsd)) return usage.costUsd;
  const pricing = findTokenPricing(model);
  if (!pricing) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const uncachedInputTokens = Math.max(inputTokens - cacheReadTokens - cacheCreationTokens, 0);
  const inputCost =
    (uncachedInputTokens * pricing.inputPerMillion +
      cacheReadTokens * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
      cacheCreationTokens * (pricing.cacheCreationPerMillion ?? pricing.inputPerMillion)) /
    1_000_000;
  const outputCost = (outputTokens * pricing.outputPerMillion) / 1_000_000;
  const totalCost = inputCost + outputCost;
  return totalCost > 0 ? Number(totalCost.toFixed(8)) : undefined;
}

function isMeaningfulTokenUsage(usage: TokenUsage): boolean {
  return (
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.totalTokens ?? 0) > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheCreationTokens ?? 0) > 0 ||
    Number.isFinite(usage.costUsd)
  );
}

function getMessageMetadata(msg: { metadata?: unknown }): MessageMetadata | undefined {
  if (!msg.metadata || typeof msg.metadata !== 'object') return undefined;
  const metadata = msg.metadata as Partial<MessageMetadata>;
  if (typeof metadata.model !== 'string' || !metadata.usage) return undefined;
  return metadata as MessageMetadata;
}

function isCompleteMessageDeliveryEnabled(): boolean {
  return parseFeatureFlag(process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY) === true;
}

function parseFeatureFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

function isAgentOutputGateEnabled(): boolean {
  const value = parseFeatureFlag(process.env.CAT_CAFE_AGENT_OUTPUT_GATE);
  // Default on: the gate protects the main chat from process chatter while
  // still forwarding lifecycle/liveness events below.
  return value ?? true;
}

function isCodexOutputGateEnabled(): boolean {
  const value = parseFeatureFlag(process.env.CAT_CAFE_CODEX_OUTPUT_GATE);
  // Default on for Codex-style runtimes too. They are the noisiest source of
  // process chatter, while CAT_CAFE_CODEX_OUTPUT_GATE=0 remains the escape hatch.
  return value ?? true;
}

function isCodexRuntimeCat(catId: string): boolean {
  if (catId === 'codex' || catId === 'gpt52') return true;
  const config = catRegistry.tryGet(catId)?.config;
  return config?.cli?.command === 'codex';
}

function isAgentOutputGateRuntimeCat(catId: string): boolean {
  const config = catRegistry.tryGet(catId)?.config;
  const command = config?.cli?.command?.toLowerCase();
  if (command === 'claude' || command === 'codex' || command === 'gemini' || command === 'kimi') return true;

  const clientId = config?.clientId?.toLowerCase();
  if (clientId === 'anthropic' || clientId === 'openai' || clientId === 'google' || clientId === 'kimi') return true;

  // Fallback for bootstrapping/tests before runtime config is registered.
  return (
    catId === 'opus' ||
    catId === 'sonnet' ||
    catId === 'opus-45' ||
    catId === 'opus-47' ||
    catId === 'codex' ||
    catId === 'gpt52' ||
    catId === 'spark' ||
    catId === 'gemini' ||
    catId === 'gemini25' ||
    catId === 'kimi'
  );
}

function isOutputGateEnabledForTargets(targetCats: readonly string[]): boolean {
  if (isAgentOutputGateEnabled() && targetCats.some(isAgentOutputGateRuntimeCat)) return true;
  return isCodexOutputGateEnabled() && targetCats.some(isCodexRuntimeCat);
}

export function isParallelDispatchEnabled(): boolean {
  const value = process.env.CAT_CAFE_PARALLEL_DISPATCH?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isWatchdogOutputEvent(type: string): boolean {
  return (
    type !== 'done' &&
    type !== 'session_init' &&
    type !== 'provider_signal' &&
    type !== 'liveness_signal' &&
    type !== 'system_info'
  );
}

function parseNumstat(stdout: string): GitArtifactSnapshot {
  const files: GitArtifactFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, path] = line.split('\t');
    if (!path) continue;
    const added = Number.parseInt(addedRaw ?? '0', 10);
    const removed = Number.parseInt(removedRaw ?? '0', 10);
    files.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactToolPayload(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted-secret]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-secret]')
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\b\s*[:=]\s*[^\s,;}]+/gi, '[redacted-secret]');
}

function previewToolPayload(value: unknown, maxLength = 1000): string | undefined {
  if (value == null) return undefined;
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = '[unserializable]';
  }
  const redacted = redactToolPayload(raw);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

function extractToolTarget(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.target ?? value.url ?? value.href ?? value.query;
  return typeof candidate === 'string' ? candidate : undefined;
}

function createToolUsageTaskDraft(
  msg: { type: string; catId?: string; [key: string]: unknown },
  invocationId?: string,
): ToolUsageTaskDraft | null {
  if (msg.type !== 'tool_use' || !msg.catId) return null;
  const toolName = typeof msg.toolName === 'string' && msg.toolName.trim() ? msg.toolName.trim() : 'unknown';
  const metadata = isRecord(msg.metadata) ? msg.metadata : undefined;
  const toolInput = msg.toolInput;
  const target = extractToolTarget(toolInput);
  const toolInputPreview = previewToolPayload(toolInput);
  return {
    ts: new Date(typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()).toISOString(),
    catId: msg.catId,
    ...(invocationId ? { invocationId } : {}),
    data: {
      provider: typeof metadata?.provider === 'string' ? metadata.provider : 'agent',
      toolName,
      status: 'started',
      ...(target ? { target } : {}),
      ...(toolInputPreview ? { toolInput: toolInputPreview } : {}),
    },
  };
}

async function collectUntrackedGitFiles(): Promise<GitArtifactFile[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: process.cwd(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'buffer',
  });
  const paths = stdout
    .toString('utf8')
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean);
  const files: GitArtifactFile[] = [];
  for (const path of paths) {
    let added = 0;
    try {
      const content = await readFile(path);
      if (content.length <= GIT_ARTIFACT_MAX_FILE_BYTES && !content.includes(0)) {
        const text = content.toString('utf8');
        added = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      }
    } catch {
      // Best-effort artifact index: keep the file path even if line counting fails.
    }
    files.push({ path, added, removed: 0 });
  }
  return files;
}

async function collectGitDiffArtifactSnapshot(): Promise<GitArtifactSnapshot> {
  const { stdout } = await execFileAsync('git', ['diff', '--numstat', 'HEAD', '--'], {
    cwd: process.cwd(),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const snapshot = parseNumstat(stdout);
  const trackedPaths = new Set(snapshot.files.map((file) => file.path));
  const untracked = (await collectUntrackedGitFiles()).filter((file) => !trackedPaths.has(file.path));
  const files = [...snapshot.files, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

/** Minimal outbound delivery interface — avoids importing full OutboundDeliveryHook. */
export interface OutboundDeliveryHookLike {
  deliver(
    threadId: string,
    content: string,
    catId: string,
    richBlocks?: ReadonlyArray<{ kind: string; [key: string]: unknown }>,
    threadMeta?: { threadShortId?: string; threadTitle?: string; deepLinkUrl?: string },
    origin?: string,
    triggerMessageId?: string,
  ): Promise<void>;
}

/** Minimal streaming outbound interface — avoids importing full StreamingOutboundHook. */
export interface StreamingOutboundHookLike {
  onStreamStart(
    threadId: string,
    catId: string,
    invocationId: string,
    senderHint?: { id: string; name?: string },
  ): Promise<void>;
  onStreamChunk(threadId: string, accumulatedText: string, invocationId: string): Promise<void>;
  onStreamEnd(threadId: string, finalText: string, invocationId: string): Promise<void>;
  cleanupPlaceholders?(threadId: string, invocationId: string): Promise<void>;
  /** F151: Signal adapters that delivery batch is complete for a thread. */
  notifyDeliveryBatchDone?(threadId: string, chainDone: boolean): Promise<void>;
}

/** Thread metadata for outbound delivery (deep link, title, etc.) */
interface ThreadMetaLike {
  threadShortId?: string;
  threadTitle?: string;
  deepLinkUrl?: string;
}

export interface QueueProcessorDeps {
  queue: InvocationQueue;
  invocationTracker: TrackerLike;
  invocationRecordStore: InvocationRecordStoreLike;
  router: RouterLike;
  socketManager: SocketManagerLike;
  messageStore: IMessageStore;
  log: LoggerLike;
  /** F088 fix: optional outbound delivery hook (late-bound after gateway bootstrap). */
  outboundHook?: OutboundDeliveryHookLike;
  /** F088 fix: optional streaming outbound hook (late-bound after gateway bootstrap). */
  streamingHook?: StreamingOutboundHookLike;
  /** F088 fix: optional thread metadata lookup for outbound delivery. */
  threadMetaLookup?: (threadId: string) => ThreadMetaLike | undefined | Promise<ThreadMetaLike | undefined>;
  /** Task #112: lightweight always-online status supervisor. */
  catSupervisor?: CatSupervisorLike;
  /** Task event ledger — used to attach A2A handoff/artifact events to source tasks. */
  taskStore?: Pick<ITaskStore, 'listByThread' | 'update'> & Partial<Pick<ITaskStore, 'listByKind'>>;
  /** Test seam for project scaffold files; production defaults to monorepo root. */
  projectRoot?: string;
  /** Test seam for git artifact tracking; production defaults to `git diff --numstat HEAD --`. */
  gitArtifactCollector?: GitArtifactCollector;
  /** F224: owns passive continuation consume/store around single-cat invocations. */
  sessionContinuationCoordinator?: Pick<
    SessionContinuationCoordinator,
    'prepareInvocationContext' | 'commitInvocationOutcome'
  >;
  /** Test seam for deterministic fast-lane execution. */
  fastLaneExecutor?: FastLaneExecutor;
}

/** F122B B6: Completion hook — called when a queue entry finishes execution. */
export type EntryCompleteHook = (
  entryId: string,
  status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
  responseText: string,
) => void;

export type ContinuationEnqueueOutcome =
  | 'enqueued'
  | 'skipped_missing_capsule'
  | 'skipped_invalid_capsule'
  | 'skipped_existing_entry'
  | 'skipped_rate_limited'
  | 'queue_full';

export class QueueProcessor {
  private deps: QueueProcessorDeps;
  /** F108: Per-slot mutex — prevents concurrent double-start per (thread, cat) pair.
   *  F118 D4: Map value = processingStartedAt for zombie detection. */
  private processingSlots = new Map<string, number>();
  /** F108: Per-slot pause tracking (set on canceled/failed, cleared on next execution) */
  private pausedSlots = new Map<string, 'canceled' | 'failed'>();
  private pauseEpoch = new Map<string, number>();
  /** F122B B6: Per-entry completion hooks (for multi-mention response aggregation). */
  private entryCompleteHooks = new Map<string, EntryCompleteHook>();
  /** F118 D4: max age before a processingSlot is considered zombie (default 2.5× CLI timeout = 75min) */
  private processingSlotTtlMs: number;
  /** #502 PR2: bounded auto-continuation guard, in-memory per process. */
  private continuationWindows = new Map<string, number[]>();
  private fastLaneRouter = new FastLaneRouter();
  private fastLaneExecutor: FastLaneExecutor;
  private static readonly CONTINUATION_WINDOW_MS = 60 * 60 * 1000;
  private static readonly MAX_CONTINUATIONS_PER_WINDOW = 5;

  constructor(deps: QueueProcessorDeps, opts?: { processingSlotTtlMs?: number }) {
    this.deps = deps;
    this.processingSlotTtlMs = opts?.processingSlotTtlMs ?? 2.5 * resolveCliTimeoutMs(undefined);
    this.fastLaneExecutor =
      deps.fastLaneExecutor ?? new FastLaneExecutor({ monorepoRoot: findMonorepoRoot(process.cwd()) });
  }

  private async appendA2AHandoffTaskEvent(params: {
    threadId: string;
    triggerMessageId?: string;
    callerCatId: string;
    targetCatId: string;
    queueEntryId: string;
    summary?: string;
  }): Promise<void> {
    const { taskStore } = this.deps;
    if (!taskStore || !params.triggerMessageId) return;
    try {
      const tasks = await taskStore.listByThread(params.threadId);
      const sourceTask = tasks.find((task) => task.sourceMessageId === params.triggerMessageId);
      if (!sourceTask) return;
      const timestamp = new Date().toISOString();
      const updated = await taskStore.update(sourceTask.id, {
        events: [
          {
            ts: timestamp,
            catId: params.callerCatId,
            type: 'handoff',
            data: {
              fromCatId: params.callerCatId,
              toCatId: params.targetCatId,
              triggerMessageId: params.triggerMessageId,
              queueEntryId: params.queueEntryId,
              summary: params.summary,
            },
          },
        ],
      });
      if (updated) {
        await appendProjectHandoffLogForPromptProjects(
          {
            timestamp,
            fromCatId: params.callerCatId,
            toCatId: params.targetCatId,
            status: updated.status,
            summary: params.summary,
          },
          undefined,
          this.deps.projectRoot,
        );
        this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
      }
    } catch (err) {
      this.deps.log.warn({ err, threadId: params.threadId }, '[QueueProcessor] append A2A handoff task event failed');
    }
  }

  private diffArtifactSnapshots(
    before: GitArtifactSnapshot | null,
    after: GitArtifactSnapshot | null,
  ): GitArtifactSnapshot | null {
    if (!after || after.files.length === 0) return null;
    const beforeByPath = new Map((before?.files ?? []).map((file) => [file.path, file]));
    const changedFiles = after.files.filter((file) => {
      const previous = beforeByPath.get(file.path);
      return !previous || previous.added !== file.added || previous.removed !== file.removed;
    });
    if (changedFiles.length === 0) return null;
    return {
      files: changedFiles,
      totalAdded: changedFiles.reduce((sum, file) => sum + file.added, 0),
      totalRemoved: changedFiles.reduce((sum, file) => sum + file.removed, 0),
    };
  }

  private async collectGitArtifacts(threadId: string): Promise<GitArtifactSnapshot | null> {
    try {
      return await (this.deps.gitArtifactCollector ?? collectGitDiffArtifactSnapshot)();
    } catch (err) {
      this.deps.log.warn({ err, threadId }, '[QueueProcessor] collect git artifacts failed');
      return null;
    }
  }

  private async findSourceTaskForLedger(params: {
    threadId: string;
    sourceMessageIds: readonly string[];
  }): Promise<TaskItem | null> {
    const { taskStore } = this.deps;
    if (!taskStore) return null;
    const sourceMessageIds = new Set(params.sourceMessageIds.filter(Boolean));
    const tasks = await taskStore.listByThread(params.threadId);
    const byMessage = tasks.find((task) => task.sourceMessageId && sourceMessageIds.has(task.sourceMessageId));
    if (byMessage) return byMessage;
    const byTaskThread = tasks.find((task) => task.taskThreadId === params.threadId);
    if (byTaskThread) return byTaskThread;
    if (taskStore.listByKind) {
      const workTasks = await taskStore.listByKind('work');
      return workTasks.find((task) => task.taskThreadId === params.threadId) ?? null;
    }
    return null;
  }

  private collectTokenUsage(
    aggregates: Map<string, TokenUsageAggregate>,
    msg: { catId?: string; metadata?: unknown },
  ): void {
    if (!msg.catId) return;
    const metadata = getMessageMetadata(msg);
    if (!metadata?.usage || !isMeaningfulTokenUsage(metadata.usage)) return;
    const existing = aggregates.get(msg.catId);
    aggregates.set(msg.catId, {
      catId: msg.catId,
      provider: metadata.provider,
      model: metadata.model,
      usage: mergeTokenUsage(existing?.usage, metadata.usage),
    });
  }

  private async appendUsageTaskEvents(params: {
    threadId: string;
    invocationId?: string;
    sourceMessageIds: readonly string[];
    aggregates: Iterable<TokenUsageAggregate>;
  }): Promise<void> {
    const { taskStore } = this.deps;
    if (!taskStore) return;
    const aggregates = Array.from(params.aggregates);
    if (aggregates.length === 0) return;
    try {
      const sourceTask = await this.findSourceTaskForLedger({
        threadId: params.threadId,
        sourceMessageIds: params.sourceMessageIds,
      });
      if (!sourceTask) return;
      for (const aggregate of aggregates) {
        if (!isMeaningfulTokenUsage(aggregate.usage)) continue;
        const totalTokens =
          aggregate.usage.totalTokens ?? (aggregate.usage.inputTokens ?? 0) + (aggregate.usage.outputTokens ?? 0);
        const costUsd = computeTokenCostUsd(aggregate.usage, aggregate.model);
        const updated = await taskStore.update(sourceTask.id, {
          events: [
            {
              ts: new Date().toISOString(),
              catId: aggregate.catId,
              ...(params.invocationId ? { invocationId: params.invocationId } : {}),
              type: 'usage',
              data: {
                provider: aggregate.provider,
                model: aggregate.model,
                inputTokens: aggregate.usage.inputTokens ?? 0,
                outputTokens: aggregate.usage.outputTokens ?? 0,
                totalTokens,
                ...(aggregate.usage.cacheReadTokens != null
                  ? { cacheReadTokens: aggregate.usage.cacheReadTokens }
                  : {}),
                ...(aggregate.usage.cacheCreationTokens != null
                  ? { cacheCreationTokens: aggregate.usage.cacheCreationTokens }
                  : {}),
                ...(costUsd != null ? { costUsd } : {}),
                ...(aggregate.usage.durationMs != null ? { durationMs: aggregate.usage.durationMs } : {}),
                ...(aggregate.usage.durationApiMs != null ? { durationApiMs: aggregate.usage.durationApiMs } : {}),
                ...(aggregate.usage.sourceBreakdown ? { sourceBreakdown: aggregate.usage.sourceBreakdown } : {}),
                ...(aggregate.usage.historyMode ? { historyMode: aggregate.usage.historyMode } : {}),
                ...(aggregate.usage.historyFullTokens != null
                  ? { historyFullTokens: aggregate.usage.historyFullTokens }
                  : {}),
                ...(aggregate.usage.historySummaryTokens != null
                  ? { historySummaryTokens: aggregate.usage.historySummaryTokens }
                  : {}),
                ...(aggregate.usage.historyBudgetRatio != null
                  ? { historyBudgetRatio: aggregate.usage.historyBudgetRatio }
                  : {}),
                ...(aggregate.usage.summarySegmentId ? { summarySegmentId: aggregate.usage.summarySegmentId } : {}),
                ...(aggregate.usage.historyGovernanceDegraded != null
                  ? { historyGovernanceDegraded: aggregate.usage.historyGovernanceDegraded }
                  : {}),
              },
            },
          ],
        });
        if (updated) {
          this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err, threadId: params.threadId }, '[QueueProcessor] append usage task event failed');
    }
  }

  private async appendToolUsageTaskEvents(params: {
    threadId: string;
    sourceMessageIds: readonly string[];
    events: readonly ToolUsageTaskDraft[];
  }): Promise<void> {
    const { taskStore } = this.deps;
    if (!taskStore || params.events.length === 0) return;
    try {
      const sourceTask = await this.findSourceTaskForLedger({
        threadId: params.threadId,
        sourceMessageIds: params.sourceMessageIds,
      });
      if (!sourceTask) return;
      for (const event of params.events) {
        const updated = await taskStore.update(sourceTask.id, {
          events: [
            {
              ts: event.ts,
              catId: event.catId,
              ...(event.invocationId ? { invocationId: event.invocationId } : {}),
              type: 'tool_usage',
              data: event.data,
            },
          ],
        });
        if (updated) {
          this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err, threadId: params.threadId }, '[QueueProcessor] append tool usage task event failed');
    }
  }

  private async appendArtifactTaskEvent(params: {
    threadId: string;
    invocationId?: string;
    catId: string;
    sourceMessageIds: readonly string[];
    before: GitArtifactSnapshot | null;
    after: GitArtifactSnapshot | null;
  }): Promise<void> {
    const { taskStore } = this.deps;
    if (!taskStore) return;
    const artifact = this.diffArtifactSnapshots(params.before, params.after);
    if (!artifact) return;
    try {
      const sourceTask = await this.findSourceTaskForLedger({
        threadId: params.threadId,
        sourceMessageIds: params.sourceMessageIds,
      });
      if (!sourceTask) return;
      const updated = await taskStore.update(sourceTask.id, {
        events: [
          {
            ts: new Date().toISOString(),
            catId: params.catId,
            ...(params.invocationId ? { invocationId: params.invocationId } : {}),
            type: 'artifact',
            data: {
              files: artifact.files,
              totalAdded: artifact.totalAdded,
              totalRemoved: artifact.totalRemoved,
            },
          },
        ],
      });
      if (updated) {
        this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
      }
    } catch (err) {
      this.deps.log.warn({ err, threadId: params.threadId }, '[QueueProcessor] append artifact task event failed');
    }
  }

  private async appendFastLaneTaskEvent(params: {
    threadId: string;
    invocationId?: string;
    catId: string;
    sourceMessageIds: readonly string[];
    type: Extract<
      TaskEvent['type'],
      'fast_lane_decision' | 'fast_lane_started' | 'fast_lane_completed' | 'fast_lane_failed'
    >;
    data: Record<string, unknown>;
  }): Promise<void> {
    const { taskStore } = this.deps;
    if (!taskStore) return;
    try {
      const sourceTask = await this.findSourceTaskForLedger({
        threadId: params.threadId,
        sourceMessageIds: params.sourceMessageIds,
      });
      if (!sourceTask) return;
      const updated = await taskStore.update(sourceTask.id, {
        events: [
          {
            ts: new Date().toISOString(),
            catId: params.catId,
            ...(params.invocationId ? { invocationId: params.invocationId } : {}),
            type: params.type,
            data: params.data,
          },
        ],
      });
      if (updated) {
        this.deps.socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
      }
    } catch (err) {
      this.deps.log.warn({ err, threadId: params.threadId }, '[QueueProcessor] append fast lane task event failed');
    }
  }

  private formatFastLaneSuccessMessage(result: Extract<FastLaneExecutionResult, { status: 'succeeded' }>): string {
    if (result.richBlocks?.length) {
      const urls = (result.publishedUrls ?? result.files).map((file) => `- ${file}`).join('\n');
      return `image 快车道已完成。\n\n生成图片：\n${urls}`;
    }
    const files = result.files.map((file) => `- ${file}`).join('\n');
    return `project-init 快车道已完成。\n\n生成文件：\n${files}`;
  }

  private formatFastLaneFailureMessage(
    workflowId: string,
    result: Extract<FastLaneExecutionResult, { status: 'failed' }>,
  ): string {
    const label = workflowId === IMAGE_GENERATION_WORKFLOW_ID ? 'image' : workflowId;
    return `${label} 快车道失败。\n\n错误：${result.stderr || result.reason}`;
  }

  private async resolveThreadMetaForFastLane(threadId: string, log: LoggerLike): Promise<ThreadMetaLike | undefined> {
    const rawResult = this.deps.threadMetaLookup?.(threadId);
    if (!rawResult) return undefined;
    try {
      const LOOKUP_TIMEOUT_MS = 2000;
      return await Promise.race([
        Promise.resolve(rawResult).catch((err: unknown) => {
          log.warn({ err, threadId }, '[QueueProcessor] fast lane threadMetaLookup late rejection');
          return undefined;
        }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
      ]);
    } catch (err) {
      log.warn({ err, threadId }, '[QueueProcessor] fast lane threadMetaLookup failed');
      return undefined;
    }
  }

  private async deliverFastLaneOutbound(params: {
    threadId: string;
    catId: string;
    content: string;
    richBlocks: ReadonlyArray<{ kind: string; [key: string]: unknown }>;
    triggerMessageId?: string;
    log: LoggerLike;
  }): Promise<void> {
    if (!this.deps.outboundHook) return;
    const DELIVER_TIMEOUT_MS = 10_000;
    const threadMeta = await this.resolveThreadMetaForFastLane(params.threadId, params.log);
    const deliverPromise = this.deps.outboundHook.deliver(
      params.threadId,
      params.content,
      params.catId,
      params.richBlocks,
      threadMeta,
      'agent',
      params.triggerMessageId,
    );
    try {
      await Promise.race([
        deliverPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
      ]);
    } catch (err) {
      params.log.error(
        { err, threadId: params.threadId, catId: params.catId },
        '[QueueProcessor] fast lane outbound delivery failed',
      );
    }
  }

  /** F088 fix: Late-bind outbound hook (set after gateway bootstrap). */
  setOutboundHook(hook: OutboundDeliveryHookLike): void {
    (this.deps as { outboundHook?: OutboundDeliveryHookLike }).outboundHook = hook;
  }

  /** F088 fix: Late-bind streaming hook (set after gateway bootstrap). */
  setStreamingHook(hook: StreamingOutboundHookLike): void {
    (this.deps as { streamingHook?: StreamingOutboundHookLike }).streamingHook = hook;
  }

  /** F088 fix: Late-bind threadMetaLookup (set after gateway bootstrap). */
  setThreadMetaLookup(
    lookup: (threadId: string) => ThreadMetaLike | undefined | Promise<ThreadMetaLike | undefined>,
  ): void {
    (this.deps as { threadMetaLookup?: typeof lookup }).threadMetaLookup = lookup;
  }

  /**
   * F122B B6: Register a completion hook for a specific queue entry.
   * Called by multi-mention dispatch to capture response text for aggregation.
   * Hook is auto-removed after invocation (one-shot).
   */
  registerEntryCompleteHook(entryId: string, hook: EntryCompleteHook): void {
    this.entryCompleteHooks.set(entryId, hook);
  }

  /** F122B B6: Remove a completion hook (e.g. on abort before execution). */
  unregisterEntryCompleteHook(entryId: string): void {
    this.entryCompleteHooks.delete(entryId);
  }

  private static slotKey(threadId: string, catId: string): string {
    return JSON.stringify([threadId, catId]);
  }

  private static slotMatchesThread(key: string, threadId: string): boolean {
    return QueueProcessor.parseSlotKey(key)?.threadId === threadId;
  }

  private static parseSlotKey(key: string): { threadId: string; catId: string } | null {
    try {
      const parsed = JSON.parse(key);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === 'string' &&
        typeof parsed[1] === 'string'
      ) {
        return { threadId: parsed[0], catId: parsed[1] };
      }
    } catch {
      // Legacy in-memory keys from older code are not expected after restart.
    }
    const legacySep = key.indexOf(':');
    if (legacySep > 0) {
      return { threadId: key.slice(0, legacySep), catId: key.slice(legacySep + 1) };
    }
    return null;
  }

  /**
   * F118 D4: Sweep zombie processingSlots.
   * A slot is zombie when: age > TTL AND invocationTracker has no active slot for the same key.
   * The tracker check prevents false-positive cleanup of genuinely slow invocations.
   */
  private sweepZombieSlots(threadId: string): void {
    const now = Date.now();
    const ttl = this.processingSlotTtlMs;
    for (const [key, startedAt] of this.processingSlots) {
      if (!QueueProcessor.slotMatchesThread(key, threadId)) continue;
      if (now - startedAt <= ttl) continue;
      // Only release if tracker also has no active invocation — double-confirm zombie
      const catId = QueueProcessor.parseSlotKey(key)?.catId;
      if (!catId) continue;
      if (!this.deps.invocationTracker.has(threadId, catId)) {
        this.processingSlots.delete(key);
        this.deps.log.warn({ threadId, catId, ageMs: now - startedAt }, '[F118 D4] zombie processingSlot released');
      }
    }
  }

  /** Check if a slot's queue is paused (canceled/failed AND has queued entries). */
  isPaused(threadId: string, catId?: string): boolean {
    if (catId) {
      return (
        this.pausedSlots.has(QueueProcessor.slotKey(threadId, catId)) && this.hasDispatchableQueuedForThread(threadId)
      );
    }
    // Backward compat: check if any slot for this thread is paused
    for (const key of this.pausedSlots.keys()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) {
        if (this.hasDispatchableQueuedForThread(threadId)) return true;
      }
    }
    return false;
  }

  /** Expose queued-state for route fairness decisions in non-queue entry paths (retry/connector). */
  hasQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedForThread(threadId);
  }

  /** A2A fairness gate: only user-sourced entries should block text-scan A2A. */
  hasQueuedUserMessagesForThread(threadId: string): boolean {
    return this.deps.queue.hasQueuedUserMessagesForThread(threadId);
  }

  /** A2A dedup: check if a specific cat already has a queued or processing entry for this thread. */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasQueuedAgentForCat(threadId, catId);
  }

  hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
    return this.deps.queue.hasActiveOrQueuedAgentForCat(threadId, catId);
  }

  /** #555: Cat-specific busy check — covers processingSlots + queue entries for this cat. */
  isCatBusy(threadId: string, catId: string): boolean {
    const startedAt = this.processingSlots.get(QueueProcessor.slotKey(threadId, catId));
    if (startedAt !== undefined && Date.now() - startedAt < this.processingSlotTtlMs) return true;
    return this.deps.queue.hasQueuedOrProcessingForCat(threadId, catId);
  }

  enqueueContinuation(input: {
    threadId: string;
    userId: string;
    catId: string;
    capsule?: CollaborationContinuityCapsuleV1 | null;
    excludeEntryId?: string;
  }): { outcome: ContinuationEnqueueOutcome; entry?: QueueEntry } {
    const { threadId, userId, catId, capsule, excludeEntryId } = input;
    if (!capsule) {
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: missing capsule');
      return { outcome: 'skipped_missing_capsule' };
    }
    if (!isCollaborationContinuityCapsuleV1(capsule)) {
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: invalid capsule');
      return { outcome: 'skipped_invalid_capsule' };
    }
    if (capsule.threadId !== threadId || capsule.catId !== catId) {
      this.deps.log.warn(
        {
          threadId,
          catId,
          capsuleThreadId: capsule.threadId,
          capsuleCatId: capsule.catId,
        },
        '[QueueProcessor] continuation skipped: capsule target mismatch',
      );
      return { outcome: 'skipped_invalid_capsule' };
    }

    const now = Date.now();
    const key = `${threadId}:${catId}`;
    const recent = (this.continuationWindows.get(key) ?? []).filter(
      (t) => now - t < QueueProcessor.CONTINUATION_WINDOW_MS,
    );
    if (recent.length >= QueueProcessor.MAX_CONTINUATIONS_PER_WINDOW) {
      this.setContinuationWindow(key, recent);
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: rate limited');
      return { outcome: 'skipped_rate_limited' };
    }

    const continuationKey = QueueProcessor.continuationKey(capsule);
    if (
      this.deps.queue.hasPendingForCat(threadId, catId, {
        excludeEntryId,
        sources: ['agent'],
        sourceCategories: ['continuation'],
        continuationKey,
      })
    ) {
      this.setContinuationWindow(key, recent);
      this.deps.log.info(
        { threadId, catId, continuationKey },
        '[QueueProcessor] continuation skipped: pending entry exists',
      );
      return { outcome: 'skipped_existing_entry' };
    }

    const result = this.deps.queue.enqueue({
      threadId,
      userId,
      content: formatContinuationPrompt(capsule),
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey,
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      callerCatId: catId,
      priority: 'urgent',
    });
    if (result.outcome === 'full' || !result.entry) {
      this.setContinuationWindow(key, recent);
      this.deps.log.warn({ threadId, catId }, '[QueueProcessor] continuation skipped: queue full');
      return { outcome: 'queue_full' };
    }

    recent.push(now);
    this.setContinuationWindow(key, recent);
    this.deps.socketManager.emitToUser(userId, 'queue_updated', {
      threadId,
      queue: this.deps.queue.list(threadId, userId),
      action: 'continuation_enqueued',
    });
    return { outcome: 'enqueued', entry: result.entry };
  }

  private static continuationKey(capsule: CollaborationContinuityCapsuleV1): string {
    const seal = capsule.seal;
    const sealPart = seal ? `${seal.sessionId}:${seal.sessionSeq}` : `created:${capsule.createdAt}`;
    return `${capsule.threadId}:${capsule.catId}:${capsule.invocationId ?? 'unknown-invocation'}:${sealPart}`;
  }

  private setContinuationWindow(key: string, recent: number[]): void {
    if (recent.length === 0) {
      this.continuationWindows.delete(key);
      return;
    }
    this.continuationWindows.set(key, recent);
  }

  /** F151: Check if thread has any queued or processing entries (used by delivery-batch-done signal). */
  isThreadBusy(threadId: string): boolean {
    if (this.hasDispatchableQueuedForThread(threadId)) return true;
    this.sweepZombieSlots(threadId);
    for (const key of this.processingSlots.keys()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) return true;
    }
    return false;
  }

  /** Active execution only; queued leftovers are not enough to keep new broadcasts in queue mode. */
  hasActiveExecution(threadId: string): boolean {
    if (this.deps.invocationTracker.has(threadId)) return true;
    this.sweepZombieSlots(threadId);
    const now = Date.now();
    for (const [key, startedAt] of this.processingSlots) {
      if (!QueueProcessor.slotMatchesThread(key, threadId)) continue;
      if (now - startedAt < this.processingSlotTtlMs) return true;
    }
    return false;
  }

  /** F151: Signal streaming adapters that delivery is done for this thread invocation.
   *  Fires on both success AND failure — failed invocations must close the task
   *  immediately instead of waiting for TASK_TIMEOUT_MS (P2-1 review fix). */
  private signalDeliveryBatchDone(threadId: string, _status: string): void {
    if (!this.deps.streamingHook?.notifyDeliveryBatchDone) return;
    const threadStillBusy = this.deps.invocationTracker.has(threadId) || this.isThreadBusy(threadId);
    this.deps.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
      this.deps.log.warn({ err, threadId }, '[QueueProcessor] notifyDeliveryBatchDone failed');
    });
  }

  /** Returns pause reason when paused; otherwise undefined. */
  getPauseReason(threadId: string, catId?: string): 'canceled' | 'failed' | undefined {
    if (!this.isPaused(threadId, catId)) return undefined;
    if (catId) {
      return this.pausedSlots.get(QueueProcessor.slotKey(threadId, catId));
    }
    // Backward compat: return first paused slot's reason
    for (const [key, reason] of this.pausedSlots.entries()) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) return reason;
    }
    return undefined;
  }

  /** #595: auto-recovery delay for failed/canceled slots (ms) */
  private static readonly PAUSE_RECOVERY_DELAY_MS = 10_000;

  /**
   * System-level entry: called when an invocation completes.
   * F108: Now slot-aware — catId identifies which slot completed.
   * - succeeded → auto-dequeue oldest across users
   * - canceled/failed → pause slot, notify users, auto-recover after delay
   */
  async onInvocationComplete(
    threadId: string,
    catId: string,
    status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
  ): Promise<void> {
    const sk = QueueProcessor.slotKey(threadId, catId);
    if (status === 'succeeded' || status === 'canceled_by_user') {
      this.pausedSlots.delete(sk);
      if (this.hasDispatchableQueuedForThread(threadId)) {
        if (isParallelDispatchEnabled()) {
          await this.tryExecuteAllAcrossUsers(threadId, catId);
        } else {
          await this.tryExecuteNextAcrossUsers(threadId, catId);
        }
        await this.tryAutoExecute(threadId);
        if (status === 'canceled_by_user') {
          this.deps.log.info({ threadId, catId }, 'Auto-resumed queued entry after user cancel');
        }
      }
    } else {
      // canceled or failed → pause ONLY if there are queued entries to manage.
      if (!this.hasDispatchableQueuedForThread(threadId)) {
        this.pausedSlots.delete(sk);
        return;
      }
      const epoch = (this.pauseEpoch.get(sk) ?? 0) + 1;
      this.pauseEpoch.set(sk, epoch);
      this.pausedSlots.set(sk, status);
      this.emitPausedToQueuedUsers(threadId, status);

      // #595: auto-recover paused slot after delay — prevents indefinite stuck state
      setTimeout(() => {
        if (this.pauseEpoch.get(sk) !== epoch) return;
        this.pausedSlots.delete(sk);
        this.deps.log.info(
          { threadId, catId, status },
          '[QueueProcessor] Auto-recovering paused slot after timeout (#595)',
        );
        if (this.hasDispatchableQueuedForThread(threadId)) {
          const recovery = isParallelDispatchEnabled()
            ? this.tryExecuteAllAcrossUsers(threadId, catId)
            : this.tryExecuteNextAcrossUsers(threadId, catId);
          void recovery.catch((err) => {
            this.deps.log.error({ err, threadId, catId }, '[QueueProcessor] Auto-recovery dequeue failed');
          });
        }
      }, QueueProcessor.PAUSE_RECOVERY_DELAY_MS);
    }
  }

  /**
   * Preemptively clear paused state for a slot.
   * Used by force-send: the old invocation's async cleanup will call
   * onInvocationComplete('canceled'/'failed') which pauses the slot,
   * but force-send already starts a new invocation — the pause is stale.
   */
  clearPause(threadId: string, catId?: string): void {
    if (catId) {
      const sk = QueueProcessor.slotKey(threadId, catId);
      this.pausedSlots.delete(sk);
    } else {
      for (const key of [...this.pausedSlots.keys()]) {
        if (QueueProcessor.slotMatchesThread(key, threadId)) {
          this.pausedSlots.delete(key);
        }
      }
    }
  }

  /**
   * F108: Force-release the per-slot mutex.
   *
   * Used by queue steer immediate: we cancel the current invocation, but the
   * old queue execution's `.then()` cleanup that deletes the mutex may not have
   * run yet. Releasing early avoids a user-visible false 409 ("queue busy").
   *
   * Idempotent: repeated deletes are safe.
   */
  releaseSlot(threadId: string, catId: string): void {
    this.processingSlots.delete(QueueProcessor.slotKey(threadId, catId));
  }

  /**
   * @deprecated Use releaseSlot(threadId, catId) instead. Kept for backward compat during migration.
   */
  releaseThread(threadId: string): void {
    for (const key of [...this.processingSlots.keys()]) {
      if (QueueProcessor.slotMatchesThread(key, threadId)) this.processingSlots.delete(key);
    }
  }

  /**
   * User-level entry: 铲屎官 manually triggers processing their next entry.
   */
  async processNext(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry; entries?: QueueEntry[] }> {
    // Clear all paused slots for this thread (manual resume clears all)
    this.clearPause(threadId);
    if (isParallelDispatchEnabled()) {
      return this.tryExecuteAllForUser(threadId, userId);
    }
    return this.tryExecuteNextForUser(threadId, userId);
  }

  /**
   * F122B: Try to auto-execute any queued autoExecute entries whose target cat slot is free.
   * Called immediately after enqueuing an agent entry.
   * Scans all entries and starts every one whose cat slot is free (parallel multi-cat).
   * Per-cat slot mutex (processingSlots + invocationTracker) prevents conflicts.
   */
  async tryAutoExecute(threadId: string): Promise<void> {
    this.sweepZombieSlots(threadId);
    if (this.hasDispatchableNonAgentQueued(threadId)) return;
    const entries = (this.deps.queue.listAutoExecute?.(threadId) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    if (entries.length > 0) {
      const now = Date.now();
      this.deps.log.info(
        {
          threadId,
          entryCount: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            targetCat: entry.targetCats[0] ?? 'unknown',
            createdAt: entry.createdAt,
            ageMs: now - entry.createdAt,
          })),
        },
        '[DIAG/a2a] tryAutoExecute candidate scan',
      );
    }

    for (const entry of entries) {
      const entryCat = entry.targetCats[0] ?? 'unknown';
      const sk = QueueProcessor.slotKey(threadId, entryCat);
      // Skip if slot is busy (mutex or tracker)
      if (this.processingSlots.has(sk)) continue;
      if (this.deps.invocationTracker.has(threadId, entryCat)) continue;

      // Guard: markProcessingById may fail if entry was consumed between snapshot and now
      if (!this.deps.queue.markProcessingById(threadId, entry.id)) continue;
      this.processingSlots.set(sk, Date.now());
      void this.executeEntry(entry).then(
        (status) => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
          this.signalDeliveryBatchDone(threadId, status);
        },
        () => {
          this.processingSlots.delete(sk);
          this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
          this.signalDeliveryBatchDone(threadId, 'failed');
        },
      );
      // Continue scanning — start all entries with free cat slots (parallel dispatch)
    }
  }

  // ── Internal ──

  private hasDispatchableQueuedForThread(threadId: string): boolean {
    return this.deps.queue.hasDispatchableQueuedForThread(threadId);
  }

  private hasDispatchableNonAgentQueued(threadId: string): boolean {
    if (!this.deps.queue.hasQueuedNonAgentForThread?.(threadId)) return false;
    for (const userId of this.deps.queue.listUsersForThread(threadId)) {
      for (const entry of this.deps.queue.list(threadId, userId)) {
        if (entry.source === 'agent' || entry.status !== 'queued' || entry.autoExecute) continue;
        const cat = entry.targetCats[0];
        if (!cat || !this.pausedSlots.has(QueueProcessor.slotKey(threadId, cat))) return true;
      }
    }
    return false;
  }

  private async tryExecuteNextAcrossUsers(
    threadId: string,
    catId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.sweepZombieSlots(threadId);

    // F175: scan by comparator order, skip entries whose target slot is busy
    const busyCats = new Set<string>();
    for (;;) {
      const entry = this.deps.queue.markProcessingAcrossUsers(threadId, busyCats);
      if (!entry) return { started: false };

      const entryCat = entry.targetCats[0] ?? catId;
      const entrySk = QueueProcessor.slotKey(threadId, entryCat);

      if (this.processingSlots.has(entrySk) || this.deps.invocationTracker.has(threadId, entryCat)) {
        this.deps.queue.rollbackProcessing(threadId, entry.id);
        busyCats.add(entryCat);
        continue;
      }

      this.processingSlots.set(entrySk, Date.now());
      void this.executeEntry(entry).then(
        (status) => {
          this.processingSlots.delete(entrySk);
          this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
          this.signalDeliveryBatchDone(threadId, status);
        },
        () => {
          this.processingSlots.delete(entrySk);
          this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
          this.signalDeliveryBatchDone(threadId, 'failed');
        },
      );

      return { started: true, entry };
    }
  }

  private async tryExecuteAllAcrossUsers(
    threadId: string,
    catId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry; entries?: QueueEntry[] }> {
    const entries: QueueEntry[] = [];
    for (;;) {
      const result = await this.tryExecuteNextAcrossUsers(threadId, catId);
      if (!result.started || !result.entry) break;
      entries.push(result.entry);
    }
    return { started: entries.length > 0, entry: entries[0], entries };
  }

  private async tryExecuteNextForUser(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry }> {
    this.sweepZombieSlots(threadId);
    // P0 per-agent queue: 队首目标 cat 忙时，不应阻塞后面的空闲 cat。
    // 逐个跳过忙 slot；同一 cat 的多次 invocation 仍由 slot mutex 串行保护。
    const busyCats = new Set<string>();
    let entry: QueueEntry | null = null;
    let entryCat = 'unknown';
    let sk = '';
    for (;;) {
      entry = this.deps.queue.markProcessing(threadId, userId, busyCats);
      if (!entry) return { started: false };

      entryCat = entry.targetCats[0] ?? 'unknown';
      sk = QueueProcessor.slotKey(threadId, entryCat);

      if (this.processingSlots.has(sk) || this.deps.invocationTracker.has(threadId, entryCat)) {
        this.deps.queue.rollbackProcessing(threadId, entry.id);
        busyCats.add(entryCat);
        continue;
      }
      break;
    }

    this.processingSlots.set(sk, Date.now());
    // Fire-and-forget execution — chain onInvocationComplete AFTER mutex release
    void this.executeEntry(entry).then(
      (status) => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, status).catch(() => {});
        this.signalDeliveryBatchDone(threadId, status);
      },
      () => {
        this.processingSlots.delete(sk);
        this.onInvocationComplete(threadId, entryCat, 'failed').catch(() => {});
        this.signalDeliveryBatchDone(threadId, 'failed');
      },
    );

    return { started: true, entry };
  }

  private async tryExecuteAllForUser(
    threadId: string,
    userId: string,
  ): Promise<{ started: boolean; entry?: QueueEntry; entries?: QueueEntry[] }> {
    const entries: QueueEntry[] = [];
    for (;;) {
      const result = await this.tryExecuteNextForUser(threadId, userId);
      if (!result.started || !result.entry) break;
      entries.push(result.entry);
    }
    return { started: entries.length > 0, entry: entries[0], entries };
  }

  /**
   * Execute a queue entry — mirrors messages.ts background invocation pipeline.
   * Creates InvocationRecord → tracker.start → route execution → complete → cleanup.
   * Returns final status for chain auto-dequeue (called by tryExecuteNext*).
   */
  private async executeEntry(entry: QueueEntry): Promise<InvocationFinalStatus> {
    const { queue, invocationTracker, invocationRecordStore, router, socketManager, messageStore, log } = this.deps;
    const { threadId, userId, targetCats, intent, messageId } = entry;
    const primaryCat = targetCats[0] ?? 'unknown';

    const batchedEntryIds: string[] = [];
    const batchedMessageIds: string[] = [];
    let content = entry.content;

    let controller: AbortController | undefined;
    let invocationId: string | undefined;
    let finalStatus: InvocationFinalStatus = 'failed';
    let responseText = '';
    const cursorBoundaries = new Map<string, string>();
    const continuationCapsules = new Map<string, CollaborationContinuityCapsuleV1>();
    let consumedContinuation: ConsumedContinuationToken | undefined;

    try {
      // 1. Create InvocationRecord (before batching — avoid claiming entries on duplicate)
      // Connector-sourced entries use connector-${messageId} to match the direct-execution
      // idempotency path, so retries after queue processing are also caught persistently.
      const idempotencyKey =
        entry.idempotencyKey ??
        (entry.sourceCategory === 'a2a' && entry.a2aTriggerMessageId && entry.callerCatId && primaryCat !== 'unknown'
          ? buildA2AIdempotencyKey({
              triggerMessageId: entry.a2aTriggerMessageId,
              callerCatId: entry.callerCatId,
              targetCatId: primaryCat,
            })
          : entry.source === 'connector' && messageId
            ? `connector-${messageId}`
            : `queue-${entry.id}`);
      const createResult = await invocationRecordStore.create({
        threadId,
        userId,
        targetCats,
        intent,
        idempotencyKey,
        ...(entry.callerCatId ? { callerCatId: entry.callerCatId } : {}),
        ...(entry.a2aTriggerMessageId ? { a2aTriggerMessageId: entry.a2aTriggerMessageId } : {}),
      });

      if (createResult.outcome === 'duplicate') {
        log.warn({ threadId, entryId: entry.id }, '[QueueProcessor] Duplicate invocation, skipping');
        finalStatus = 'succeeded';
        return 'succeeded';
      }
      invocationId = createResult.invocationId;

      // F175: user-message batching — collect adjacent matching entries
      // Placed after idempotency check so batched entries aren't dropped on duplicate
      if (entry.source === 'user') {
        const batch = queue.collectUserBatch(threadId, userId);
        const sortedTargets = [...entry.targetCats].sort();
        const matching = batch.filter(
          (e) =>
            e.source === 'user' &&
            e.intent === entry.intent &&
            e.targetCats.length === sortedTargets.length &&
            [...e.targetCats].sort().every((t, i) => t === sortedTargets[i]),
        );
        for (const be of matching) {
          if (!queue.markProcessingById(threadId, be.id)) continue;
          batchedEntryIds.push(be.id);
          if (be.messageId) batchedMessageIds.push(be.messageId);
          content = content + '\n' + be.content;
        }
      }

      // 2. Start tracking ALL target cats (shared controller for F5/reconnect recovery)
      controller = invocationTracker.startAll(threadId, targetCats, userId);
      void this.deps.catSupervisor?.markProcessing(targetCats);

      // 3. Backfill message ID
      if (messageId) {
        await invocationRecordStore.update(invocationId, {
          userMessageId: messageId,
        });
      }

      // 4. Mark running
      await invocationRecordStore.update(invocationId, {
        status: 'running',
        phase: 'runtime_starting',
      });

      socketManager.broadcastToRoom(`thread:${threadId}`, 'spawn_started', {
        threadId,
        targetCats,
        invocationId,
      });
      socketManager.broadcastToRoom(`thread:${threadId}`, 'invocation_phase', {
        threadId,
        invocationId,
        targetCats,
        phase: 'runtime_starting',
      });

      // 5. intent_mode deferred to first CLI event (#768: avoid "replying" when CLI never starts)
      let intentModeBroadcast = false;
      await invocationRecordStore.update(invocationId, { phase: 'first_token_waiting' });
      socketManager.broadcastToRoom(`thread:${threadId}`, 'invocation_phase', {
        threadId,
        invocationId,
        targetCats,
        phase: 'first_token_waiting',
      });

      // 6. Emit queue_updated (processing)
      socketManager.emitToUser(userId, 'queue_updated', {
        threadId,
        queue: queue.list(threadId, userId),
        action: 'processing',
      });

      // F098-D: Mark queued messages as delivered (set deliveredAt = now)
      // F117: Collect full message objects for frontend bubble rendering
      const allMessageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? []), ...batchedMessageIds].filter(
        Boolean,
      );
      const deliveredNow = Date.now();
      const deliveredIds: string[] = [];
      const deliveredMessages: Array<{
        id: string;
        content: string;
        catId: string | null;
        timestamp: number;
        mentions: readonly string[];
        userId: string;
        contentBlocks?: readonly unknown[];
        extra?: Record<string, unknown>;
        origin?: string;
        replyTo?: string;
        replyPreview?: { senderCatId: string | null; content: string; deleted?: boolean; kind?: string };
        mentionsUser?: boolean;
      }> = [];
      for (const mid of allMessageIds) {
        try {
          const result = await messageStore.markDelivered(mid, deliveredNow);
          if (result) {
            deliveredIds.push(mid);
            let preview: Awaited<ReturnType<typeof hydrateReplyPreview>> | null = null;
            if (result.replyTo) {
              try {
                preview = await hydrateReplyPreview(messageStore, result.replyTo);
              } catch {
                /* best-effort: preview failure must not drop the delivered message */
              }
            }
            deliveredMessages.push({
              id: result.id,
              content: result.content,
              catId: result.catId,
              timestamp: result.timestamp,
              mentions: result.mentions,
              userId: result.userId,
              contentBlocks: result.contentBlocks,
              ...(result.extra ? { extra: result.extra as Record<string, unknown> } : {}),
              ...(result.origin ? { origin: result.origin } : {}),
              ...(result.replyTo ? { replyTo: result.replyTo } : {}),
              ...(preview ? { replyPreview: preview } : {}),
              ...(result.mentionsUser ? { mentionsUser: true } : {}),
            });
          }
        } catch {
          /* best-effort: delivery timestamp is non-critical */
        }
      }
      // Notify frontend only for successfully persisted IDs (cloud P2: avoid phantom timestamps)
      // F117: Include messages array so frontend can render user bubble on delivery
      if (deliveredIds.length > 0) {
        socketManager.emitToUser(userId, 'messages_delivered', {
          threadId,
          messageIds: deliveredIds,
          deliveredAt: deliveredNow,
          messages: deliveredMessages,
        });
      }

      if (this.deps.sessionContinuationCoordinator && targetCats.length === 1) {
        const singleCatId = targetCats[0]!;
        try {
          const originalContent = content;
          const prepared = await this.deps.sessionContinuationCoordinator.prepareInvocationContext({
            threadId,
            catId: singleCatId,
            userId,
            content,
          });
          content = prepared.content;
          consumedContinuation = prepared.consumedContinuation;

          if (prepared.sessionPolicy === 'reborn' && entry.sourceCategory === 'continuation') {
            log.info(
              { threadId, catId: singleCatId, entryId: entry.id },
              '[QueueProcessor] F224: reborn session drops stale continuation entry',
            );
            await invocationRecordStore.update(invocationId, { status: 'succeeded', phase: 'done' });
            finalStatus = 'succeeded';
            return 'succeeded';
          }

          if (prepared.consumedContinuation) {
            const sameQueuedContinuation =
              entry.sourceCategory === 'continuation' &&
              entry.continuationKey === QueueProcessor.continuationKey(prepared.consumedContinuation.capsule);
            if (sameQueuedContinuation) {
              content = originalContent;
            }
          }
        } catch (err) {
          log.warn(
            { threadId, catId: singleCatId, err },
            '[QueueProcessor] F224: prepareInvocationContext failed, proceeding without continuation context',
          );
        }
      }

      // 7. Route execution
      const persistenceContext: { richBlocks?: Array<{ kind: string; [key: string]: unknown }> } = {};
      const collectedTextParts: string[] = [];

      // F088 fix: Track per-turn content for outbound delivery (same pattern as ConnectorInvokeTrigger)
      const outboundTurns: Array<{
        catId: string;
        textParts: string[];
        richBlocks?: Array<{ kind: string; [key: string]: unknown }>;
      }> = [];
      let currentTurnCatId: string | undefined;
      const completeMessageDeliveryEnabled =
        isCompleteMessageDeliveryEnabled() || isOutputGateEnabledForTargets(targetCats);
      const completedSocketTurnIndices = new Set<number>();
      const tokenUsageAggregates = new Map<string, TokenUsageAggregate>();
      const toolUsageTaskEvents: ToolUsageTaskDraft[] = [];

      // F039 remaining: queued image messages must be visible to cats.
      // Aggregate contentBlocks from the stored user messages (messageId + merged).
      const messageIds: string[] = [messageId ?? '', ...(entry.mergedMessageIds ?? []), ...batchedMessageIds].filter(
        Boolean,
      );
      const contentBlocks: unknown[] = [];
      for (const id of messageIds) {
        try {
          const stored = await messageStore.getById(id);
          if (stored?.contentBlocks && stored.contentBlocks.length > 0) {
            contentBlocks.push(...stored.contentBlocks);
          }
        } catch (err) {
          log.warn(
            { threadId, entryId: entry.id, messageId: id, err },
            '[QueueProcessor] messageStore.getById failed, degrading to text-only execution',
          );
        }
      }
      const artifactBaseline = this.deps.taskStore ? await this.collectGitArtifacts(threadId) : null;

      const fastLaneDecision = isFastLaneEnabled() ? this.fastLaneRouter.decide({ content, intent }) : null;
      if (fastLaneDecision) {
        log.info(
          {
            threadId,
            entryId: entry.id,
            catId: primaryCat,
            decision: fastLaneDecision,
          },
          '[QueueProcessor] fast lane decision',
        );
        await this.appendFastLaneTaskEvent({
          threadId,
          invocationId,
          catId: primaryCat,
          sourceMessageIds: allMessageIds,
          type: 'fast_lane_decision',
          data: {
            ...fastLaneDecision,
            routeExecutionBypassed: false,
          },
        });
      }

      if (fastLaneDecision?.lane === 'fast') {
        if (contentBlocks.length > 0) {
          await this.appendFastLaneTaskEvent({
            threadId,
            invocationId,
            catId: primaryCat,
            sourceMessageIds: allMessageIds,
            type: 'fast_lane_decision',
            data: {
              lane: 'slow',
              workflowId: fastLaneDecision.workflowId,
              reason: 'contentBlocks present; fast lane supports text-only commands',
              fallbackReason: 'content_blocks_present',
            },
          });
        } else {
          await this.appendFastLaneTaskEvent({
            threadId,
            invocationId,
            catId: primaryCat,
            sourceMessageIds: allMessageIds,
            type: 'fast_lane_started',
            data: {
              workflowId: fastLaneDecision.workflowId,
              workflowVersion: '1',
              input: fastLaneDecision.input,
            },
          });
          const result =
            fastLaneDecision.workflowId === PROJECT_INIT_WORKFLOW_ID
              ? await this.fastLaneExecutor.executeProjectInit(fastLaneDecision.input)
              : await this.fastLaneExecutor.executeImageGeneration(fastLaneDecision.input, {
                  invocationId,
                  threadId,
                  catId: primaryCat,
                });
          if (result.status === 'skipped') {
            await this.appendFastLaneTaskEvent({
              threadId,
              invocationId,
              catId: primaryCat,
              sourceMessageIds: allMessageIds,
              type: 'fast_lane_decision',
              data: {
                lane: 'slow',
                workflowId: fastLaneDecision.workflowId,
                reason: result.reason,
                fallbackReason: 'preflight_skipped',
                durationMs: result.durationMs,
              },
            });
          } else if (result.status === 'succeeded') {
            const artifactAfter = artifactBaseline ? await this.collectGitArtifacts(threadId) : null;
            const artifact = this.diffArtifactSnapshots(artifactBaseline, artifactAfter);
            await invocationRecordStore.update(invocationId, {
              status: 'succeeded',
              phase: 'done',
            });
            finalStatus = 'succeeded';
            responseText = this.formatFastLaneSuccessMessage(result);
            const richBlocks = result.richBlocks ?? [];
            let fastLaneMessageId: string | undefined;
            if (richBlocks.length > 0) {
              const stored = await messageStore.append({
                userId,
                catId: primaryCat as CatId,
                content: responseText,
                mentions: [],
                timestamp: Date.now(),
                threadId,
                origin: 'callback',
                extra: { rich: { v: 1, blocks: richBlocks } },
              });
              fastLaneMessageId = stored.id;
            }
            socketManager.broadcastAgentMessage(
              {
                type: 'text',
                catId: primaryCat,
                content: responseText,
                origin: 'fast_lane',
                timestamp: Date.now(),
                invocationId,
                ...(fastLaneMessageId ? { messageId: fastLaneMessageId } : {}),
              },
              threadId,
            );
            for (const block of richBlocks) {
              socketManager.broadcastAgentMessage(
                {
                  type: 'system_info',
                  catId: primaryCat,
                  content: JSON.stringify({ type: 'rich_block', block }),
                  origin: 'fast_lane',
                  timestamp: Date.now(),
                  invocationId,
                  ...(fastLaneMessageId ? { messageId: fastLaneMessageId } : {}),
                },
                threadId,
              );
            }
            socketManager.broadcastAgentMessage(
              {
                type: 'done',
                catId: primaryCat,
                timestamp: Date.now(),
                invocationId,
              },
              threadId,
            );
            await this.deliverFastLaneOutbound({
              threadId,
              catId: primaryCat,
              content: responseText,
              richBlocks: richBlocks.map((block) => block as unknown as { kind: string; [key: string]: unknown }),
              triggerMessageId: messageId ?? fastLaneMessageId,
              log,
            });
            await this.appendFastLaneTaskEvent({
              threadId,
              invocationId,
              catId: primaryCat,
              sourceMessageIds: allMessageIds,
              type: 'fast_lane_completed',
              data: {
                workflowId: fastLaneDecision.workflowId,
                workflowVersion: '1',
                durationMs: result.durationMs,
                stdout: result.stdout,
                stderr: result.stderr,
                files: result.files,
                ...(result.publishedUrls ? { publishedUrls: result.publishedUrls } : {}),
                ...(result.provider ? { provider: result.provider } : {}),
                ...(result.model ? { model: result.model } : {}),
                ...(result.prompt ? { prompt: result.prompt } : {}),
                ...(richBlocks.length > 0 ? { richBlockIds: richBlocks.map((block) => block.id) } : {}),
                ...(fastLaneMessageId ? { messageId: fastLaneMessageId } : {}),
                artifactCount: artifact?.files.length ?? 0,
                routeExecutionBypassed: true,
                tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
                estimatedTokensSaved: 'slow lane not invoked',
              },
            });
            if (artifactBaseline) {
              await this.appendArtifactTaskEvent({
                threadId,
                invocationId,
                catId: primaryCat,
                sourceMessageIds: allMessageIds,
                before: artifactBaseline,
                after: artifactAfter,
              });
            }
            return 'succeeded';
          } else {
            responseText = this.formatFastLaneFailureMessage(fastLaneDecision.workflowId, result);
            await invocationRecordStore.update(invocationId, {
              status: 'failed',
              phase: 'done',
              error: result.stderr || result.reason,
            });
            await this.appendFastLaneTaskEvent({
              threadId,
              invocationId,
              catId: primaryCat,
              sourceMessageIds: allMessageIds,
              type: 'fast_lane_failed',
              data: {
                workflowId: fastLaneDecision.workflowId,
                workflowVersion: '1',
                durationMs: result.durationMs,
                reason: result.reason,
                stdout: result.stdout,
                stderr: result.stderr,
                ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
                ...(result.signal ? { signal: result.signal } : {}),
                routeExecutionBypassed: true,
              },
            });
            let fastLaneMessageId: string | undefined;
            try {
              const stored = await messageStore.append({
                userId,
                catId: primaryCat as CatId,
                content: responseText,
                mentions: [],
                timestamp: Date.now(),
                threadId,
                origin: 'callback',
              });
              fastLaneMessageId = stored.id;
            } catch (err) {
              log.warn({ err, threadId, entryId: entry.id }, '[QueueProcessor] persist fast lane failure failed');
            }
            socketManager.broadcastAgentMessage(
              {
                type: 'error',
                catId: primaryCat,
                error: result.stderr || result.reason,
                isFinal: true,
                origin: 'fast_lane',
                timestamp: Date.now(),
                invocationId,
                ...(fastLaneMessageId ? { messageId: fastLaneMessageId } : {}),
              },
              threadId,
            );
            await this.deliverFastLaneOutbound({
              threadId,
              catId: primaryCat,
              content: responseText,
              richBlocks: [],
              triggerMessageId: messageId ?? fastLaneMessageId,
              log,
            });
            finalStatus = 'failed';
            return 'failed';
          }
        }
      }

      // F122B B6: Collect response text for completion hook (multi-mention aggregation).
      const hook = this.entryCompleteHooks.get(entry.id);

      // F088 fix: start streaming placeholder on external platforms
      let streamStartPromise: Promise<void> | undefined;
      if (this.deps.streamingHook) {
        streamStartPromise = this.deps.streamingHook
          .onStreamStart(threadId, primaryCat, invocationId, entry.senderMeta)
          .catch((err) => {
            log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamStart failed');
          });
      }

      // F151: Mid-loop delivery to preserve ordering (same fix as ConnectorInvokeTrigger)
      const deliveredTurnIndices = new Set<number>();
      const DELIVER_TIMEOUT_MS = 10_000;
      let threadMeta: ThreadMetaLike | undefined;
      let threadMetaPromise: Promise<ThreadMetaLike | undefined> | undefined;
      if (this.deps.outboundHook && this.deps.threadMetaLookup) {
        const rawResult = this.deps.threadMetaLookup(threadId);
        if (rawResult) {
          const LOOKUP_TIMEOUT_MS = 2000;
          threadMetaPromise = Promise.race([
            Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[QueueProcessor] threadMetaLookup late rejection');
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)),
          ]);
        }
      }

      for await (const msg of router.routeExecution(
        userId,
        content,
        threadId,
        messageId,
        targetCats,
        { intent, ...(entry.suggestedSkill ? { promptTags: [`skill:${entry.suggestedSkill}`] } : {}) },
        {
          ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
          ...(controller.signal ? { signal: controller.signal } : {}),
          queueHasQueuedMessages: (tid: string) => queue.hasQueuedUserMessagesForThread(tid),
          hasQueuedOrActiveAgentForCat: (tid: string, catId: string) => queue.hasActiveOrQueuedAgentForCat(tid, catId),
          enqueueA2ATargets: async (handoff: {
            threadId: string;
            userId: string;
            callerCatId: import('@cat-cafe/shared').CatId;
            targetCats: import('@cat-cafe/shared').CatId[];
            content: string;
            triggerMessageId?: string;
          }) => {
            const enqueued: import('@cat-cafe/shared').CatId[] = [];
            for (const targetCat of handoff.targetCats) {
              if (queue.hasActiveOrQueuedAgentForCat(handoff.threadId, targetCat)) continue;
              const result = queue.enqueue({
                threadId: handoff.threadId,
                userId: handoff.userId,
                ...(handoff.triggerMessageId
                  ? {
                      idempotencyKey: buildA2AIdempotencyKey({
                        triggerMessageId: handoff.triggerMessageId,
                        callerCatId: handoff.callerCatId,
                        targetCatId: targetCat,
                      }),
                    }
                  : {}),
                content: handoff.content,
                source: 'agent',
                sourceCategory: 'a2a',
                targetCats: [targetCat],
                intent: 'execute',
                autoExecute: true,
                callerCatId: handoff.callerCatId,
                a2aTriggerMessageId: handoff.triggerMessageId,
              });
              if (result.outcome !== 'enqueued' || !result.entry) continue;
              if (handoff.triggerMessageId) {
                queue.backfillMessageId(handoff.threadId, handoff.userId, result.entry.id, handoff.triggerMessageId);
              }
              await this.appendA2AHandoffTaskEvent({
                threadId: handoff.threadId,
                triggerMessageId: handoff.triggerMessageId,
                callerCatId: handoff.callerCatId,
                targetCatId: targetCat,
                queueEntryId: result.entry.id,
                summary: handoff.content,
              });
              enqueued.push(targetCat);
            }
            if (enqueued.length > 0) {
              socketManager.emitToUser(handoff.userId, 'queue_updated', {
                threadId: handoff.threadId,
                queue: queue.list(handoff.threadId, handoff.userId),
                action: 'enqueued',
              });
              await this.tryAutoExecute(handoff.threadId);
            }
            return enqueued;
          },
          invocationController: controller,
          trackA2ASlot: (tid: string, catId: string, uid: string, ctrl: AbortController) => {
            invocationTracker.trackExternalSlot?.(tid, catId, ctrl, uid, [catId]);
          },
          completeA2ASlots: (tid: string, catIds: readonly string[], ctrl: AbortController) => {
            for (const catId of catIds) invocationTracker.completeSlot?.(tid, catId, ctrl);
          },
          cursorBoundaries,
          persistenceContext,
          ...(invocationId ? { parentInvocationId: invocationId } : {}),
          ...(entry.callerCatId ? { directMessageFrom: entry.callerCatId } : {}),
          ...(entry.a2aTriggerMessageId
            ? { a2aTriggerMessageId: entry.a2aTriggerMessageId, replyToMessageId: entry.a2aTriggerMessageId }
            : {}),
          callerTraceContext: entry.callerTraceContext,
        },
      )) {
        if (controller.signal.aborted) {
          break;
        }
        this.collectTokenUsage(tokenUsageAggregates, msg);
        const toolUsageTaskEvent = createToolUsageTaskDraft(msg, invocationId);
        if (toolUsageTaskEvent) toolUsageTaskEvents.push(toolUsageTaskEvent);
        if (msg.catId) {
          if (msg.type === 'tool_use') {
            await this.deps.catSupervisor?.pauseForTool?.(msg.catId);
          } else if (msg.type === 'tool_result') {
            await this.deps.catSupervisor?.resumeAfterTool?.(msg.catId);
          } else if (isWatchdogOutputEvent(msg.type)) {
            await this.deps.catSupervisor?.markOutput?.(msg.catId);
          }
        }
        if (msg.type === 'tool_use') {
          await invocationRecordStore.update(invocationId, { phase: 'tool_calling' });
          socketManager.broadcastToRoom(`thread:${threadId}`, 'invocation_phase', {
            threadId,
            invocationId,
            targetCats,
            phase: 'tool_calling',
          });
        }
        // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
        if (!intentModeBroadcast) {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'intent_mode', {
            threadId,
            mode: intent,
            targetCats,
            invocationId,
          });
          intentModeBroadcast = true;
        }
        if (hook && msg.catId === primaryCat && msg.type === 'text' && (msg as { content?: string }).content) {
          responseText = accumulateTextAggregate(
            responseText,
            (msg as { content?: string }).content!,
            (msg as { textMode?: 'append' | 'replace' }).textMode,
          );
        }
        const continuationCapsule = extractContinuityCapsuleFromAgentMessage(msg);
        if (continuationCapsule) {
          continuationCapsules.set(continuationCapsule.catId, continuationCapsule);
        }
        if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
          invocationTracker.completeSlot?.(threadId, msg.catId, controller);
        }

        // F088 fix: collect per-turn content for outbound delivery
        if (msg.type === 'done' && msg.catId) {
          if (persistenceContext.richBlocks) {
            const turn = outboundTurns[outboundTurns.length - 1];
            if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
              turn.richBlocks = [...persistenceContext.richBlocks];
            } else {
              outboundTurns.push({ catId: msg.catId, textParts: [], richBlocks: [...persistenceContext.richBlocks] });
            }
            persistenceContext.richBlocks = undefined;
          }
          currentTurnCatId = undefined;
          // F151: Deliver completed cat's turns immediately (same fix as ConnectorInvokeTrigger)
          if (this.deps.outboundHook) {
            if (threadMetaPromise) {
              threadMeta = await threadMetaPromise;
              threadMetaPromise = undefined;
            }
            for (let i = 0; i < outboundTurns.length; i++) {
              if (deliveredTurnIndices.has(i)) continue;
              const turn = outboundTurns[i];
              if (turn.catId !== msg.catId) continue;
              const turnContent = turn.textParts.join('');
              if (!turnContent && !turn.richBlocks?.length) continue;
              try {
                await Promise.race([
                  this.deps.outboundHook.deliver(
                    threadId,
                    turnContent,
                    turn.catId,
                    turn.richBlocks,
                    threadMeta,
                    undefined,
                    messageId ?? undefined,
                  ),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
                  ),
                ]);
                deliveredTurnIndices.add(i);
              } catch (err) {
                log.error(
                  { err, threadId, catId: turn.catId },
                  '[QueueProcessor] Mid-loop delivery failed, will retry in final phase',
                );
              }
            }
          }
        }
        if (msg.type === 'text' && typeof (msg as Record<string, unknown>).content === 'string') {
          const textContent = (msg as Record<string, unknown>).content as string;
          const textMode = (msg as { textMode?: 'append' | 'replace' }).textMode;
          accumulateTextParts(collectedTextParts, textContent, textMode);
          if (msg.catId) {
            if (msg.catId !== currentTurnCatId) {
              outboundTurns.push({ catId: msg.catId, textParts: [] });
              currentTurnCatId = msg.catId;
            }
            const turn = outboundTurns[outboundTurns.length - 1];
            accumulateTextParts(turn.textParts, textContent, textMode);
          }
          if (this.deps.streamingHook) {
            const accumulated =
              outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);
            this.deps.streamingHook.onStreamChunk(threadId, accumulated, invocationId).catch((err) => {
              log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamChunk failed');
            });
          }
        }
        if (controller.signal.aborted) {
          break;
        }

        if (completeMessageDeliveryEnabled && msg.type === 'done' && msg.catId) {
          for (let i = 0; i < outboundTurns.length; i++) {
            if (completedSocketTurnIndices.has(i)) continue;
            const turn = outboundTurns[i];
            if (!turn || turn.catId !== msg.catId) continue;
            const turnContent = sanitizeAgentVisibleOutput(turn.textParts.join(''));
            if (!turnContent) continue;
            socketManager.broadcastAgentMessage(
              {
                type: 'text',
                catId: turn.catId,
                content: turnContent,
                textMode: 'replace',
                origin: 'stream',
                timestamp: Date.now(),
                ...(invocationId ? { invocationId } : {}),
              },
              threadId,
            );
            completedSocketTurnIndices.add(i);
          }
        }

        if (!(completeMessageDeliveryEnabled && msg.type === 'text')) {
          socketManager.broadcastAgentMessage({ ...msg, ...(invocationId ? { invocationId } : {}) }, threadId);
        }
      }

      // 8. Check abort before marking succeeded (F122B B6 P1: abort→succeeded bug fix)
      if (controller.signal.aborted) {
        log.info({ threadId, entryId: entry.id }, '[QueueProcessor] Entry aborted during execution');
        // F148 fix: ack cursors for cats that completed before abort (monotonic CAS, safe to call)
        if (cursorBoundaries.size > 0) {
          await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        }
        await invocationRecordStore.update(invocationId, { status: 'canceled', phase: 'done' });
        finalStatus = controller.signal.reason === 'user_cancel' ? 'canceled_by_user' : 'canceled';
        return finalStatus;
      }

      // 9. Ack cursors + mark succeeded
      await invocationRecordStore.update(invocationId, { phase: 'persisting' });
      socketManager.broadcastToRoom(`thread:${threadId}`, 'invocation_phase', {
        threadId,
        invocationId,
        targetCats,
        phase: 'persisting',
      });
      await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
      await invocationRecordStore.update(invocationId, {
        status: 'succeeded',
        phase: 'done',
      });

      finalStatus = 'succeeded';

      // 10. Outbound delivery: send remaining per-turn content to bound external chats
      await this.deliverOutbound(
        threadId,
        primaryCat,
        invocationId!,
        collectedTextParts,
        outboundTurns,
        persistenceContext,
        streamStartPromise,
        log,
        messageId ?? undefined,
        deliveredTurnIndices,
        threadMeta,
      );

      await this.appendToolUsageTaskEvents({
        threadId,
        sourceMessageIds: allMessageIds,
        events: toolUsageTaskEvents,
      });

      await this.appendUsageTaskEvents({
        threadId,
        invocationId,
        sourceMessageIds: allMessageIds,
        aggregates: tokenUsageAggregates.values(),
      });

      if (artifactBaseline) {
        const artifactAfter = await this.collectGitArtifacts(threadId);
        await this.appendArtifactTaskEvent({
          threadId,
          invocationId,
          catId: primaryCat,
          sourceMessageIds: allMessageIds,
          before: artifactBaseline,
          after: artifactAfter,
        });
      }

      return 'succeeded';
    } catch (err) {
      finalStatus = 'failed';
      log.error({ threadId, entryId: entry.id, err }, '[QueueProcessor] executeEntry failed');
      // F148 fix: ack cursors for cats that completed before the exception
      if (cursorBoundaries.size > 0) {
        try {
          await router.ackCollectedCursors(userId, threadId, cursorBoundaries);
        } catch {
          /* best-effort — don't mask the original error */
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      // Best-effort: mark record failed + broadcast error
      try {
        if (invocationId) {
          await invocationRecordStore.update(invocationId, {
            status: 'failed',
            phase: 'done',
            error: errMsg,
          });
        }
        socketManager.broadcastAgentMessage(
          {
            type: 'error',
            catId: targetCats[0] ?? 'system',
            error: errMsg,
            isFinal: true,
            timestamp: Date.now(),
          },
          threadId,
        );
      } catch {
        /* ignore secondary errors */
      }

      return 'failed';
    } finally {
      void this.deps.catSupervisor?.markIdle(targetCats);
      // Always cleanup tracker + queue (all target cat slots)
      invocationTracker.completeAll(threadId, targetCats, controller);
      queue.removeProcessedAcrossUsers(threadId, entry.id);
      // F175: on success remove batched entries; on failure/cancel rollback so they can retry
      if (finalStatus === 'succeeded') {
        for (const bid of batchedEntryIds) {
          queue.removeProcessedAcrossUsers(threadId, bid);
        }
        for (const continuationCapsule of continuationCapsules.values()) {
          this.enqueueContinuation({
            threadId,
            userId,
            catId: continuationCapsule.catId,
            capsule: continuationCapsule,
          });
        }
      } else {
        for (const bid of batchedEntryIds) {
          queue.rollbackProcessing(threadId, bid);
        }
      }
      if (this.deps.sessionContinuationCoordinator) {
        try {
          await this.deps.sessionContinuationCoordinator.commitInvocationOutcome({
            finalStatus,
            threadId,
            catId: primaryCat,
            userId,
            consumedContinuation,
            producedCapsules: continuationCapsules.values(),
          });
        } catch (err) {
          log.warn({ threadId, targetCats, err }, '[QueueProcessor] F224: commitInvocationOutcome failed');
        }
      }
      socketManager.emitToUser(userId, 'queue_updated', {
        threadId,
        queue: queue.list(threadId, userId),
        action: 'completed',
      });
      // F122B B6: Fire completion hook (one-shot) and clean up
      const completeHook = this.entryCompleteHooks.get(entry.id);
      if (completeHook) {
        this.entryCompleteHooks.delete(entry.id);
        try {
          completeHook(entry.id, finalStatus, responseText);
        } catch {
          /* best-effort: hook errors must not break queue chain */
        }
      }
      // Chain auto-dequeue is handled by tryExecuteNext* (calls onInvocationComplete
      // AFTER releasing processingThreads mutex to avoid self-blocking).
    }
  }

  /**
   * F088 fix: Deliver collected outbound turns to bound external chats.
   * Mirrors ConnectorInvokeTrigger ⑥ logic: per-turn delivery, streaming cleanup, late-success fallback.
   */
  private async deliverOutbound(
    threadId: string,
    primaryCat: string,
    invocationId: string,
    collectedTextParts: string[],
    outboundTurns: Array<{
      catId: string;
      textParts: string[];
      richBlocks?: Array<{ kind: string; [key: string]: unknown }>;
    }>,
    persistenceContext: { richBlocks?: Array<{ kind: string; [key: string]: unknown }> },
    streamStartPromise: Promise<void> | undefined,
    log: LoggerLike,
    triggerMessageId?: string,
    deliveredTurnIndices?: Set<number>,
    preResolvedMeta?: ThreadMetaLike | undefined,
  ): Promise<void> {
    const finalContent =
      outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);

    // Finalize streaming — ensure start completed before ending
    if (this.deps.streamingHook) {
      if (streamStartPromise) {
        const STREAM_START_TIMEOUT_MS = 5000;
        await Promise.race([
          streamStartPromise,
          new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
        ]);
      }
      await this.deps.streamingHook.onStreamEnd(threadId, finalContent, invocationId).catch((err) => {
        log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.onStreamEnd failed');
      });
    }

    const hasContent = collectedTextParts.length > 0 || outboundTurns.length > 0;
    if (this.deps.outboundHook && hasContent) {
      // F151: Use pre-resolved threadMeta from mid-loop delivery, or do fresh lookup
      let threadMeta: ThreadMetaLike | undefined = preResolvedMeta;
      if (threadMeta === undefined && !(deliveredTurnIndices && deliveredTurnIndices.size > 0)) {
        try {
          const LOOKUP_TIMEOUT_MS = 2000;
          const rawResult = this.deps.threadMetaLookup?.(threadId);
          if (rawResult) {
            const lookupPromise = Promise.resolve(rawResult).catch((err: unknown) => {
              log.warn({ err, threadId }, '[QueueProcessor] threadMetaLookup late rejection');
              return undefined;
            });
            const timeout = new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS),
            );
            threadMeta = await Promise.race([lookupPromise, timeout]);
          }
        } catch (lookupErr) {
          log.warn({ err: lookupErr, threadId }, '[QueueProcessor] threadMetaLookup failed');
        }
      }

      const DELIVER_TIMEOUT_MS = 10_000;
      // F151: skip turns already delivered mid-loop
      const nonEmptyTurns = outboundTurns.filter(
        (t, i) =>
          !(deliveredTurnIndices && deliveredTurnIndices.has(i)) &&
          (t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0)),
      );

      let deliveryFailed = false;
      const inflightDeliverPromises: Promise<void>[] = [];

      // BUG-5 (2026-03-25): iLink context_token is reusable — SINGLE_TOKEN_CONNECTORS
      // merge logic removed. Each turn now delivers independently for all connectors.
      if (nonEmptyTurns.length > 1) {
        for (const turn of nonEmptyTurns) {
          const turnContent = turn.textParts.join('');
          const deliverPromise = this.deps.outboundHook.deliver(
            threadId,
            turnContent,
            turn.catId,
            turn.richBlocks,
            threadMeta,
            undefined,
            triggerMessageId,
          );
          inflightDeliverPromises.push(deliverPromise);
          try {
            await Promise.race([
              deliverPromise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
              ),
            ]);
          } catch (err) {
            deliveryFailed = true;
            log.error({ err, threadId, catId: turn.catId }, '[QueueProcessor] Outbound delivery error');
          }
        }
      } else if (nonEmptyTurns.length === 1) {
        const turn = nonEmptyTurns[0];
        const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
        const deliverPromise = this.deps.outboundHook.deliver(
          threadId,
          finalContent,
          turn.catId,
          richBlocks,
          threadMeta,
          undefined,
          triggerMessageId,
        );
        inflightDeliverPromises.push(deliverPromise);
        try {
          await Promise.race([
            deliverPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          deliveryFailed = true;
          log.error({ err, threadId }, '[QueueProcessor] Outbound delivery error');
        }
      } else if (!(deliveredTurnIndices && deliveredTurnIndices.size > 0)) {
        // Fallback: no per-turn delivery happened — deliver remaining content as one
        const richBlocks = persistenceContext.richBlocks;
        if (richBlocks) {
          const deliverPromise = this.deps.outboundHook.deliver(
            threadId,
            finalContent,
            primaryCat,
            richBlocks,
            threadMeta,
            undefined,
            triggerMessageId,
          );
          inflightDeliverPromises.push(deliverPromise);
          try {
            await Promise.race([
              deliverPromise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS),
              ),
            ]);
          } catch (err) {
            deliveryFailed = true;
            log.error({ err, threadId }, '[QueueProcessor] Outbound delivery error');
          }
        }
      }

      if (!deliveryFailed && this.deps.streamingHook?.cleanupPlaceholders) {
        await this.deps.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
          log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.cleanupPlaceholders failed');
        });
      } else if (deliveryFailed && this.deps.streamingHook?.cleanupPlaceholders) {
        const cleanupFn = this.deps.streamingHook.cleanupPlaceholders.bind(this.deps.streamingHook);
        Promise.allSettled(inflightDeliverPromises).then((results) => {
          if (results.every((r) => r.status === 'fulfilled')) {
            cleanupFn(threadId, invocationId).catch((err) => {
              log.warn({ err, threadId }, '[QueueProcessor] Placeholder cleanup failed after late-success delivery');
            });
          }
        });
      }
    } else if (this.deps.streamingHook?.cleanupPlaceholders) {
      await this.deps.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
        log.warn({ err, threadId }, '[QueueProcessor] StreamingHook.cleanupPlaceholders failed (silent)');
      });
    }
  }

  /** Emit queue_paused to each user who has queued entries for this thread. */
  private emitPausedToQueuedUsers(threadId: string, reason: 'canceled' | 'failed'): void {
    const users = this.deps.queue.listUsersForThread(threadId);
    for (const userId of users) {
      const userQueue = this.deps.queue.list(threadId, userId);
      if (!userQueue.some((e) => e.status === 'queued')) continue;
      this.deps.socketManager.emitToUser(userId, 'queue_paused', {
        threadId,
        reason,
        queue: userQueue,
      });
    }
  }
}
