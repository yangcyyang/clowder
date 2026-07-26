/**
 * Single Cat Invocation
 * 单猫调用的核心逻辑，从 AgentRouter 提取。
 *
 * 处理: credentials 创建、session 获取、workingDirectory 解析、
 *       CLI 调用、消息 yield、错误处理、审计日志。
 *
 * 不处理: system prompt 构建（由调用方负责 prepend）、
 *         消息存储（由调用方在 yield 后累积并存储）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type CatId,
  type ContextHealth,
  catRegistry,
  getSanityLineFallback,
  type MessageContent,
  type ToolPolicy,
} from '@cat-cafe/shared';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  resolveBuiltinClientForProvider,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../../../../../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../../../../../config/cat-account-binding.js';
import { isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { getContextWindowFallback } from '../../../../../config/context-window-sizes.js';
import { getSessionStrategy, shouldTakeAction } from '../../../../../config/session-strategy.js';
import { assertSafeTestConfigRoot } from '../../../../../config/test-config-write-guard.js';
import { capturePromptIfEnabled } from '../../../../../infrastructure/debug/prompt-capture-bridge.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  AGENT_ID,
  GENAI_MODEL,
  GENAI_SYSTEM,
  OPERATION_NAME,
  STATUS,
  TRIGGER,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  activeInvocations,
  catInvocationCount,
  catResponseDuration,
  invocationCompleted,
  invocationDuration,
  llmCallDuration,
  sessionRounds,
  threadDuration,
  tokenUsage,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { normalizeModel } from '../../../../../infrastructure/telemetry/model-normalizer.js';
import { emitOtelLog } from '../../../../../infrastructure/telemetry/otel-logger.js';
import { recordLlmCallSpan, recordToolUseSpan } from '../../../../../infrastructure/telemetry/span-helpers.js';
import { resolveActiveProjectRoot } from '../../../../../utils/active-project-root.js';
import { resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { DEFAULT_CLI_TIMEOUT_MS, resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import { filterAccountEnvVars } from '../../../../../utils/env-var-secret-guard.js';
import { findMonorepoRoot, isSameProject } from '../../../../../utils/monorepo-root.js';
import { isUnderAllowedRoot } from '../../../../../utils/project-path.js';
import { tcpProbe } from '../../../../../utils/tcp-probe.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import type { AgentPaneRegistry } from '../../../../terminal/agent-pane-registry.js';
import type { TmuxGateway } from '../../../../terminal/tmux-gateway.js';
import { createPromptDigest } from '../../context/prompt-digest.js';
import { estimatePromptSourceBreakdown } from '../../context/prompt-source-breakdown.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { autoUpdateAgentMemory } from '../memory/AgentMemoryAutoWriter.js';
import {
  inferResumeTrustForSessionHandoff,
  writeContextHandoffForPromptProjects,
} from '../memory/ProjectProgressStore.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import {
  deriveOpenCodeApiType,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  parseOpenCodeModel,
  safeProviderName,
  summarizeOpenCodeRuntimeConfigForDebug,
  writeOpenCodeRuntimeConfig,
} from '../providers/opencode-config-template.js';
import { evaluateClaudeBudgetGate } from './claude-budget-gate.js';
import {
  maybeRotateCliNativeSession,
  type CliSessionRotationResult,
} from './cli-native-session-rotation.js';

const log = createModuleLogger('invoke');
const tracer = trace.getTracer('cat-cafe-api', '0.1.0');
let _openCodeKnownModels: Set<string> | null = null;

export function getOpenCodeKnownModels(): Set<string> {
  if (_openCodeKnownModels !== null) return _openCodeKnownModels;
  try {
    const opencodePath = resolveCliCommand('opencode');
    if (!opencodePath) {
      _openCodeKnownModels = new Set();
      return _openCodeKnownModels;
    }
    const stdout = execFileSync(opencodePath, ['models'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    _openCodeKnownModels = new Set(
      stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    _openCodeKnownModels = new Set();
  }
  return _openCodeKnownModels;
}

function resolveClowderCliEnv(hostProjectRoot: string): Record<string, string> {
  const binDir = join(hostProjectRoot, 'bin');
  const cliPath = join(binDir, 'clowder');
  if (!existsSync(cliPath)) return {};

  const existingPath = process.env.PATH ?? '';
  return {
    CLOWDER_CLI_PATH: cliPath,
    PATH: [binDir, existingPath].filter(Boolean).join(':'),
  };
}

/** @internal Exposed for tests */
export function _resetOpenCodeKnownModels(override?: Set<string> | null): void {
  _openCodeKnownModels = override ?? null;
}

import {
  formatSanityHandoffMarkdown,
  generateSanityHandoffCapsule,
  isSanityHandoffEnabled,
} from '../../session/HandoffCapsuleGenerator.js';
import { getSanitySealCooldownMsFromEnv, SanitySealCooldownStore } from '../../session/SanitySealCooldownStore.js';
import type { SessionManager } from '../../session/SessionManager.js';
import {
  computeSanityTransition,
  getSanityThresholdsFromEnv,
  isSanitySealEnabled,
} from '../../session/SessionSanityMonitor.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { TranscriptSessionInfo, TranscriptWriter } from '../../session/TranscriptWriter.js';
import type { ICooldownStore } from '../../stores/ports/CooldownStore.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import { isSummaryCompactionEligibleMessage } from '../../stores/visibility.js';
import type { AgentMessage, AgentService, AgentServiceOptions, DeliveryOnlyDegradedIssue } from '../../types.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';
import { completeCapsuleForSeal, type RouteStateContinuityCapsule } from './CollaborationContinuityCapsule.js';
import type { ResumeFailureKind } from './invoke-helpers.js';
import {
  classifyResumeFailure,
  extractTaskProgress,
  isCliTimeoutError,
  isContextWindowOverflowError,
  isMissingClaudeSessionError,
  isPromptTokenLimitExceededError,
  isTransientAcpPromptFailure,
  isTransientCliExitCode1,
  preflightRace,
} from './invoke-helpers.js';
import { SessionMutex } from './SessionMutex.js';
import type { TaskProgressItem, TaskProgressStatus, TaskProgressStore } from './TaskProgressStore.js';

/** F118: Module-level singleton — guards per-cliSessionId serialization */
const sessionMutex = new SessionMutex();
const SESSION_MUTEX_WAIT_TIMEOUT_MS = Number(process.env.CAT_CAFE_SESSION_MUTEX_WAIT_TIMEOUT_MS) || 90_000;

function isFilesystemPermissionError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return code === 'EPERM' || code === 'EACCES' || /operation not permitted|permission denied/i.test(message);
}

/**
 * F089: Race an async iterator's .next() against an AbortSignal.
 * Returns the iterator result, or throws the abort reason if the signal fires first.
 * This is necessary because `for await` blocks on gen.next() and cannot be interrupted.
 */
function abortableNext<T>(iter: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    iter.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const ANTHROPIC_PROFILE_MODE_KEY = 'CAT_CAFE_ANTHROPIC_PROFILE_MODE';
const ANTHROPIC_PROFILE_MODE_API_KEY = 'api_key';

/** Derive a URL-safe slug from profile ID for proxy routing. */
function deriveProxySlug(profileId: string): string {
  // "profile-a247a834-1ac1-4752-aa73-6bd159b9acc5" → "a247a834"
  const match = profileId.match(/^profile-([a-f0-9]+)/);
  return match?.[1] ?? profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Register/update upstream mapping in .cat-cafe/proxy-upstreams.json (hot-reloaded by proxy). */
function registerProxyUpstream(projectRoot: string, slug: string, targetUrl: string): void {
  assertSafeTestConfigRoot(projectRoot, 'invoke-single-cat.registerProxyUpstream');
  const dir = resolve(projectRoot, '.cat-cafe');
  const filePath = resolve(dir, 'proxy-upstreams.json');
  let upstreams: Record<string, string> = {};
  try {
    if (existsSync(filePath)) {
      upstreams = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* start fresh */
  }
  if (upstreams[slug] === targetUrl) return; // no change
  upstreams[slug] = targetUrl;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(upstreams, null, 2)}\n`);
}

/**
 * F-BLOAT: Context compression detection for non-Claude providers (Codex/Gemini).
 *
 * Track last known context fill per cat:thread. When usedTokens drops >60%
 * between turns, mark for systemPrompt re-injection on the next invocation.
 * This handles the edge case where auto-compact fires before our seal threshold.
 *
 * Note: module-level state — lost on server restart (acceptable, seal handles 95% of cases).
 */
const _prevContextFill = new Map<string, number>();
const _needsReinjection = new Set<string>();
const _staticIdentityRegistryRevision = new Map<string, number>();
const _handoffDraftWindowSessions = new Set<string>();

const SANITY_HANDOFF_MESSAGE_WINDOW = 200;

/**
 * 理智线 T4 (task #386): 生成 9 字段轻交接包 + 写进当前 thread（结构化消息）。
 * 安全钉：源消息在这里先过 isSummaryCompactionEligibleMessage 再传给生成器——未 reveal
 * 的 whisper 在这一步就被剔除，生成器本身不再做二次可见性判断（唯一防线，见调用点注释）。
 * 注意：不能用 canViewMessage(msg, {type:'user'})——那个函数对 user viewer 直接短路
 * `return true`（"铲屎官看见一切"是它的设计意图，不是过滤器），会让 whisper 照样通过。
 * isSummaryCompactionEligibleMessage 是 viewer-agnostic 的"这条消息能不能进线程级摘要"
 * 判断，专门为这种场景设计（stores/visibility.ts 原有注释就是防"摘要泄漏 whisper"）。
 * 只在 T3 跨档到 yellow/red 时被调用（由调用方保证幂等，这里不重复判断）。
 */
async function generateAndPersistSanityHandoff(
  deps: { messageStore?: IMessageStore },
  input: { threadId: string; catId: CatId; triggerState: 'yellow' | 'red'; userId: string },
): Promise<import('@cat-cafe/shared').SanityHandoffCapsuleV1 | null> {
  if (!isSanityHandoffEnabled() || !deps.messageStore) return null;
  try {
    const raw = await deps.messageStore.getByThread(input.threadId, SANITY_HANDOFF_MESSAGE_WINDOW, input.userId);
    const visible = raw
      .filter((m) => isSummaryCompactionEligibleMessage(m))
      .map((m) => ({ content: m.content, catId: m.catId, timestamp: m.timestamp }));
    const capsule = generateSanityHandoffCapsule({
      threadId: input.threadId,
      catId: input.catId,
      triggerState: input.triggerState,
      messages: visible,
    });
    await deps.messageStore.append({
      userId: 'system',
      catId: null,
      content: formatSanityHandoffMarkdown(capsule),
      mentions: [],
      timestamp: Date.now(),
      threadId: input.threadId,
      extra: { systemKind: 'sanity_handoff' },
    });
    return capsule;
  } catch {
    /* best-effort — a failed handoff generation must not break the invocation */
    return null;
  }
}

/** 理智线 T6 (task #388): recognized-but-unresolved-resetAt default cooldown window. */
const DEFAULT_USAGE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/**
 * 理智线 T6 (task #388): 把一条 errorCode==='usage_limit' 的 AgentMessage 写成结构化冷却。
 * **调用方硬约束**：只在 `msg.errorCode === 'usage_limit'` 时调用——不能对"任何未识别
 * 的错误"都套这条兜底（专家-Claude scoping 澄清：Kimi/Gemini 没有 pattern 时它们的错误
 * 压根不会被识别成 usage_limit，走通用错误处理，保持现状，不被误冷却）。
 * `until` 优先取 `msg.metadata.diagnostics.resetAt`（结构化/精确解析值）；解析不出时才
 * 落 30 分钟默认冷却（这也是这条"识别到但没解析出具体时间"分支唯一合法触发默认值的场景）。
 */
async function recordUsageLimitCooldown(
  deps: { cooldownStore?: ICooldownStore },
  input: { catId: CatId; msg: AgentMessage },
): Promise<{ until: number; resetAtResolved: boolean } | null> {
  if (!deps.cooldownStore) return null;
  try {
    const diagnostics = input.msg.metadata?.diagnostics as { resetAt?: unknown } | undefined;
    const resetAt = typeof diagnostics?.resetAt === 'number' ? diagnostics.resetAt : undefined;
    const until = resetAt ?? Date.now() + DEFAULT_USAGE_LIMIT_COOLDOWN_MS;
    const source = catRegistry.tryGet(input.catId as string)?.config.clientId ?? 'unknown';
    await deps.cooldownStore.set({
      catId: input.catId,
      until,
      reason: 'usage_limit',
      source,
      originalError: input.msg.error ?? 'usage_limit',
    });
    return { until, resetAtResolved: resetAt !== undefined };
  } catch {
    /* best-effort — a failed cooldown write must not break the invocation */
    return null;
  }
}

/** @internal Exposed for testing */
export function _resetCompressionDetection(): void {
  _prevContextFill.clear();
  _needsReinjection.clear();
}

/** @internal Exposed for testing */
export function _resetStaticIdentityRegistryRevisionForTests(): void {
  _staticIdentityRegistryRevision.clear();
}

function sessionIdentityKey(userId: string, catId: CatId, threadId: string): string {
  return `${userId}:${catId as string}:${threadId}`;
}

/**
 * Shared dependencies for all cat invocations within one AgentRouter
 */
export interface InvocationDeps {
  readonly registry: InvocationRegistry;
  readonly sessionManager: SessionManager;
  readonly threadStore: IThreadStore | null;
  readonly apiUrl: string;
  /** F045 Gap #4: Redis-backed task progress snapshots (optional in memory mode/tests) */
  readonly taskProgressStore?: TaskProgressStore;
  /** F24: Session chain store for context health tracking */
  readonly sessionChainStore?: ISessionChainStore;
  /** 理智线 T4 (task #386): message store for reading thread context to build the
   *  sanity handoff capsule + writing the handoff message itself. Optional so
   *  existing test/deps construction sites keep compiling without it. */
  readonly messageStore?: IMessageStore;
  /** F24 Phase B: Session sealer for auto-seal when context threshold reached */
  readonly sessionSealer?: ISessionSealer;
  /** 理智线 T6 (task #388): per-cat quota-cooldown state. Optional so existing
   *  test/deps construction sites keep compiling without it. */
  readonly cooldownStore?: ICooldownStore;
  /** B1 (2026-07-23): (catId, threadId) post-forced-seal cooldown to stop the
   *  seal→new-session→turn-1-red→seal loop. Optional so existing test/deps
   *  construction sites keep compiling without it. */
  readonly sanitySealCooldownStore?: SanitySealCooldownStore;
  /** F24 Phase C: Transcript writer for event collection + flush on seal */
  readonly transcriptWriter?: TranscriptWriter;
  /** F24 Phase D: Transcript reader for reading sealed session data */
  readonly transcriptReader?: import('../../session/TranscriptReader.js').TranscriptReader;
  /** F065: Task store for bootstrap task snapshot injection */
  readonly taskStore?: import('../../stores/ports/TaskStore.js').ITaskStore;
  /** F073 P4: Workflow SOP store for SOP stage hint injection */
  readonly workflowSopStore?: import('../../stores/ports/WorkflowSopStore.js').IWorkflowSopStore;
  /** F070 Phase 3a: Execution digest store for dispatch backflow */
  readonly executionDigestStore?: import('../../../../projects/execution-digest-store.js').ExecutionDigestStore;
  /** F089 Phase 2: tmux gateway for agent-in-pane execution */
  readonly tmuxGateway?: TmuxGateway;
  /** F089 Phase 2: agent pane registry for observability */
  readonly agentPaneRegistry?: AgentPaneRegistry;
  /** F091: Lookup signal articles linked to a thread for context injection */
  readonly signalArticleLookup?: (threadId: string) => Promise<
    readonly {
      id: string;
      title: string;
      source: string;
      tier: number;
      contentSnippet: string;
      note?: string | undefined;
      relatedDiscussions?: readonly { sessionId: string; snippet: string; score: number }[] | undefined;
    }[]
  >;
}

/**
 * Per-invocation parameters
 */
export interface InvocationParams {
  readonly catId: CatId;
  readonly service: AgentService;
  /** The fully-orchestrated prompt (dynamic context + chain context already prepended by caller) */
  readonly prompt: string;
  readonly userId: string;
  readonly threadId: string;
  /** Per-thread append watermark captured before this invocation reads context. */
  readonly freshnessBaseline?: string;
  readonly currentUserMessageId?: string;
  readonly contentBlocks?: readonly MessageContent[];
  readonly uploadDir?: string;
  readonly signal?: AbortSignal;
  readonly isLastCat: boolean;
  /** Static identity prompt — prepended to prompt on new sessions (gated by F-BLOAT logic) */
  readonly systemPrompt?: string;
  /** Scheduler isolation: start a new provider-native session while retaining Clowder summaries. */
  readonly forceFreshCliSession?: true;
  /**
   * ADR-024 D2: structured four-slot payload (CONTEXT_CACHE_LAYOUT=v2, gated by the route
   * layer's `TRANSPORT_SEAM_CLIENT_IDS` allowlist — Claude-only in W1-B, extended to the
   * rest of the W2-E-verified providers). When present the caller has already ordered
   * `prompt` as history→meta→userMsg, so this layer does NOT prepend systemPrompt into the
   * `-p` body/blob — it hands `systemPrompt`/`transportPayload` to the adapter (its own
   * system channel for Claude/Pi/CatAgent, or a single-blob prepend for the rest) and
   * forwards this payload for direct slot mapping. Gating on `transportPayload` (not just
   * `systemPrompt`) is what flips `useTransportSeam` below and skips the resume-gated
   * prepend — the fix for non-Claude resumed sessions losing system content each turn.
   */
  readonly transportPayload?: import('../../types.js').AgentServiceOptions['transportPayload'];
  /** F108 fix: InvocationRecordStore's parent invocation ID for worklist key alignment */
  readonly parentInvocationId?: string;
  /** F121: The A2A trigger message ID for auto-replyTo */
  readonly a2aTriggerMessageId?: string;
  /** Original human thread for an explicitly cross-thread routed invocation. */
  readonly crossPostSourceThreadId?: string;
  /** F153 Phase E: Parent route span — invocation span becomes its child */
  readonly routeSpan?: import('@opentelemetry/api').Span;
  /** F153: mutable ref so caller can capture the invocation span for trace propagation */
  readonly invocationSpanRef?: { current?: import('@opentelemetry/api').Span };
  /** #502 PR2: structured route control state to persist on threshold seal. */
  readonly continuityCapsule?: RouteStateContinuityCapsule;
  /** Effective toolbox level for this invocation. */
  readonly toolPolicy?: ToolPolicy;
  /** Whether toolbox level came from the agent default or a user message override. */
  readonly toolPolicySource?: 'agent-default' | 'user-override';
  /** Runtime context-budget diagnostics shown in the execution bar. */
  readonly contextBudget?: {
    surface: 'thread';
    threadId: string;
    toolPolicy: ToolPolicy;
    toolPolicySource: 'agent-default' | 'user-override';
    mode: 'serial' | 'parallel';
    estimatedTokens: number;
    historyMessages: number;
    loadedBlocks: string[];
    skippedBlocks: string[];
    governanceTier: 'core' | 'operational';
    governanceEstimatedTokens: number;
    governanceSourceInjected: boolean;
    usesFullHistory: boolean;
    maxPromptTokens: number;
    maxContextTokens: number;
    historyMode?: 'observe' | 'shadow-summary' | 'summary-active';
    historyFullTokens?: number;
    historySummaryTokens?: number;
    historyBudgetRatio?: number;
    summarySegmentId?: string;
    historyGovernanceDegraded?: boolean;
    deliveryOnlyMode?: 'active' | 'degraded';
    deliveryOnlyDegradedIssue?: DeliveryOnlyDegradedIssue;
  };
  /** Route layer will perform a mandatory post-publication memory writeback. */
  readonly deferMemoryWriteback?: boolean;
}

/**
 * Invoke a single cat agent and yield messages.
 *
 * The caller is responsible for:
 * - Building and prepending the system prompt to params.prompt
 * - Accumulating text/metadata from yielded messages
 * - Storing the final response in messageStore
 */
export async function* invokeSingleCat(deps: InvocationDeps, params: InvocationParams): AsyncIterable<AgentMessage> {
  const { registry, sessionManager, threadStore, apiUrl } = deps;
  const { catId, service, prompt, userId, threadId, isLastCat, signal: callerSignal } = params;
  const freshnessProtected = params.freshnessBaseline !== undefined;

  const { invocationId, callbackToken } = await registry.create(
    userId,
    catId,
    threadId,
    params.parentInvocationId,
    params.a2aTriggerMessageId,
    freshnessProtected || params.crossPostSourceThreadId
      ? {
          ...(freshnessProtected ? { freshnessBaseline: params.freshnessBaseline } : {}),
          ...(params.crossPostSourceThreadId ? { crossPostSourceThreadId: params.crossPostSourceThreadId } : {}),
        }
      : undefined,
  );

  // F153: Record cat invocation count with trigger type
  const triggerType = params.a2aTriggerMessageId ? 'mention' : params.parentInvocationId ? 'routing' : 'default';
  catInvocationCount.add(1, { [AGENT_ID]: catId, [TRIGGER]: triggerType });

  // F089: Invocation-level hard timeout — independent of NDJSON stream / CLI timeout.
  // Must be > CLI_TIMEOUT_MS to avoid racing the inner timeout.
  // When CLI_TIMEOUT_MS=0 (disable), fall back to DEFAULT (30min) so invocation still has a ceiling.
  const INVOCATION_TIMEOUT_MULTIPLIER = 2;
  const cliTimeoutMs = resolveCliTimeoutMs(undefined);
  const invocationTimeoutMs =
    (cliTimeoutMs > 0 ? cliTimeoutMs : DEFAULT_CLI_TIMEOUT_MS) * INVOCATION_TIMEOUT_MULTIPLIER;
  const invocationAc = new AbortController();
  let invocationTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInvocationTimeout = (): void => {
    if (invocationTimer) clearTimeout(invocationTimer);
    invocationTimer = setTimeout(() => {
      log.error({ invocationId, catId, threadId, timeoutMs: invocationTimeoutMs }, 'Invocation hard timeout fired');
      invocationAc.abort(new Error('invocation_timeout'));
    }, invocationTimeoutMs);
    invocationTimer.unref();
  };
  resetInvocationTimeout();

  // Merge caller signal (user cancel) with invocation timeout — neither loses semantics.
  const signal: AbortSignal | undefined = callerSignal
    ? AbortSignal.any([callerSignal, invocationAc.signal])
    : invocationAc.signal;

  log.info({ invocationId, catId, threadId, userId }, 'Created invocation');
  const hostProjectRoot = findMonorepoRoot(process.cwd());

  // F22 R2 P1-1: Expose invocationId to caller (route-serial/parallel) so they can
  // use it for RichBlockBuffer.consume() instead of getLatestId() which is wrong
  // under preemption — old invocation A would steal new invocation B's blocks.
  yield {
    type: 'system_info' as const,
    catId,
    content: JSON.stringify({
      type: 'invocation_created',
      invocationId,
      ...(params.toolPolicy ? { toolPolicy: params.toolPolicy } : {}),
      ...(params.toolPolicySource ? { toolPolicySource: params.toolPolicySource } : {}),
      ...(params.contextBudget ? { contextBudget: params.contextBudget } : {}),
    }),
    timestamp: Date.now(),
  };

  const callbackEnv: Record<string, string> = {
    CAT_CAFE_API_URL: apiUrl,
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
    CAT_CAFE_USER_ID: userId,
    CAT_CAFE_CAT_ID: catId,
    ...(process.env.CLOWDER_API_BEARER_TOKEN?.trim()
      ? { CLOWDER_API_BEARER_TOKEN: process.env.CLOWDER_API_BEARER_TOKEN.trim() }
      : {}),
    ...(params.currentUserMessageId ? { CAT_CAFE_CURRENT_MESSAGE_ID: params.currentUserMessageId } : {}),
    // F061 Bug-F cold-start (codex peer review on 47922fe7): cat_cafe_list_session_chain
    // requires threadId; without it, Bengal's cold-start prompt step 1 fails with
    // "missing required parameter". Inject the live threadId so prompt template
    // can resolve to a concrete value.
    CAT_CAFE_THREAD_ID: threadId,
    ...resolveClowderCliEnv(hostProjectRoot),
    ...(process.env.CAT_CAFE_SIGNAL_USER ? { CAT_CAFE_SIGNAL_USER: process.env.CAT_CAFE_SIGNAL_USER } : {}),
  };

  const auditLog = getEventAuditLog();
  const promptDigest = createPromptDigest(prompt);
  const startTime = Date.now();

  let threadCreatedAt: number | undefined;

  // F118 AC-C5: Flags for finally block fallback audit (must be before any early return)
  let hadError = false;
  let didWriteAudit = false;
  let didComplete = false;
  let didResetRestoreFailures = false;
  let openCodeRuntimeConfigPath: string | undefined;
  let assistantTextForMemory = '';
  // 理智线 T5 (task #387): set true once the red-zone forced writeback below has
  // run (success or failure), so the normal end-of-invocation writeback doesn't
  // fire a second time for the same turn.
  let forcedMemoryWritebackDone = false;
  // 理智线 T5 (task #387): sessionId of the active record once sanityTransition
  // crosses into 'red' this turn, consumed by the forced-seal check inside F33's
  // block below (reset per turn — this function handles exactly one invocation).
  let sanityRedTriggerSessionId: string | undefined;
  // F-G (PRD-memory-upgrade 批次 3, docs/research/memory-absorption.md §3): set when
  // maybeRotateCliNativeSession() decided to rotate this invocation's CLI-native
  // session (over size threshold + cat on the CLOWDER_CLI_SESSION_ROTATE_CATS
  // whitelist). Consumed in the `finally` block to force a supplementary memory
  // distillation write tied to the rotation event (autoUpdateAgentMemory needs
  // invocation-complete state, so it can't be called at decision time — see the
  // call site below for the reasoning).
  let rotationEvent: CliSessionRotationResult | undefined;

  const captureAssistantTextForMemory = (message: AgentMessage): void => {
    // F193: the route owns the freshness verdict. Until it publishes, stdout is
    // a private draft and must not enter a durable/searchable memory sink.
    if (freshnessProtected) return;
    if (message.type !== 'text' || !message.content) return;
    assistantTextForMemory =
      message.textMode === 'replace' ? message.content : `${assistantTextForMemory}${message.content}`;
    if (assistantTextForMemory.length > 4000) {
      assistantTextForMemory = assistantTextForMemory.slice(-4000);
    }
  };

  // === CAT_INVOKED 审计 (fire-and-forget, 缅因猫 review P2-3) ===
  auditLog
    .append({
      type: AuditEventTypes.CAT_INVOKED,
      threadId,
      data: {
        catId,
        userId,
        invocationId,
        promptDigest,
        isLastCat,
      },
    })
    .catch((err) => {
      // P2-2: 打印完整错误信息 + 上下文
      log.warn({ threadId, invocationId, err }, 'CAT_INVOKED audit write failed');
    });

  let hadStreamError = false;
  let lastTasks: TaskProgressItem[] | null = null;
  let terminalTaskProgressStatus: TaskProgressStatus | null = null;
  let terminalInterruptReason: 'error' | 'aborted' | null = null;
  let finalizedTaskProgressStatus: TaskProgressStatus | null = null;

  const attachInvocationIdToTaskProgress = (message: AgentMessage): AgentMessage => {
    if (message.type !== 'system_info' || !message.content) return message;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.type !== 'task_progress' || typeof parsed.invocationId === 'string') return message;
      return {
        ...message,
        content: JSON.stringify({ ...parsed, invocationId }),
      };
    } catch {
      return message;
    }
  };

  const maybePersistTaskProgress = async (out: AgentMessage): Promise<void> => {
    if (!deps.taskProgressStore) return;
    if (out.type !== 'system_info' || !out.content) return;
    let tasks: TaskProgressItem[] | null = null;
    try {
      const parsed = JSON.parse(out.content) as { type?: string; tasks?: unknown };
      if (parsed.type !== 'task_progress' || !Array.isArray(parsed.tasks)) return;
      tasks = parsed.tasks as TaskProgressItem[];
      lastTasks = tasks;
    } catch {
      return;
    }

    try {
      await deps.taskProgressStore.setSnapshot({
        threadId,
        catId,
        tasks,
        status: 'running',
        updatedAt: Date.now(),
        lastInvocationId: invocationId,
      });
    } catch (err) {
      log.warn({ threadId, catId, invocationId, err }, 'Task progress persist running snapshot failed');
    }
  };

  const finalizeTaskProgress = async (): Promise<void> => {
    if (!deps.taskProgressStore || !lastTasks) return;
    const wasAborted = Boolean(signal?.aborted);

    // Determine the terminal status once per invocation and keep it stable.
    // In particular: if we already reached a successful terminal (`done` without error),
    // later `AbortSignal` flips (client disconnect / iterator.return()) must NOT
    // downgrade the snapshot to `interrupted`.
    const status: TaskProgressStatus =
      terminalTaskProgressStatus ?? (hadError || wasAborted ? 'interrupted' : 'completed');
    const interruptReason =
      terminalInterruptReason ??
      (status === 'interrupted' ? (hadError ? 'error' : wasAborted ? 'aborted' : undefined) : undefined);

    // Once we have persisted a "completed" snapshot, don't downgrade it to
    // "interrupted" just because the request was aborted after completion
    // (e.g. client disconnect / iterator.return()).
    if (finalizedTaskProgressStatus === 'completed' && status === 'interrupted' && !hadError) return;
    // Similarly, don't upgrade an interrupted snapshot back to completed.
    if (finalizedTaskProgressStatus === 'interrupted' && status === 'completed') return;
    if (finalizedTaskProgressStatus === status) return;

    try {
      await deps.taskProgressStore.setSnapshot({
        threadId,
        catId,
        tasks: lastTasks,
        status,
        updatedAt: Date.now(),
        lastInvocationId: invocationId,
        ...(interruptReason ? { interruptReason } : {}),
      });
      finalizedTaskProgressStatus = status;
    } catch (err) {
      log.warn({ threadId, catId, invocationId, status, err }, 'Task progress persist final snapshot failed');
    }
  };

  // F118: Declared before try so it's accessible in finally
  let sessionMutexRelease: (() => void) | undefined;

  // F152: Create invocation span for distributed tracing
  // F153 Phase E: If a route span exists, make invocation its child
  const parentCtx = params.routeSpan ? trace.setSpan(context.active(), params.routeSpan) : undefined;
  const invocationSpan = tracer.startSpan(
    'cat_cafe.invocation',
    { attributes: { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke', invocationId } },
    parentCtx,
  );

  // F153: Expose invocation span to caller + persist trace context for A2A propagation
  if (params.invocationSpanRef) params.invocationSpanRef.current = invocationSpan;
  const sc = invocationSpan.spanContext();
  try {
    if (typeof deps.registry.setTraceContext === 'function') {
      await deps.registry.setTraceContext(invocationId, {
        traceId: sc.traceId,
        spanId: sc.spanId,
        traceFlags: sc.traceFlags,
      });
    }
  } catch (err) {
    log.warn({ catId, threadId, invocationId, err }, 'Trace context persistence failed, continuing invocation');
  }

  try {
    // F152: Track active invocations — must be inside try so add/sub symmetry
    // is guaranteed by the finally block, even on generator early abort.
    activeInvocations.add(1, { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' });

    // F152: Emit invocation start through OTel log pipeline
    emitOtelLog('INFO', 'invocation_started', { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' }, invocationSpan);

    let sessionId: string | undefined;
    let authoritativeSessionCreatedAt: number | undefined;
    let contextResetBoundary: Awaited<ReturnType<IThreadStore['getContextResetBoundary']>> = null;
    let contextResetBoundaryReadFailed = false;
    if (deps.threadStore) {
      try {
        contextResetBoundary = await preflightRace(
          Promise.resolve(deps.threadStore.getContextResetBoundary(threadId, userId)),
          'getContextResetBoundary',
          signal,
        );
      } catch {
        contextResetBoundaryReadFailed = true;
      }
    }
    try {
      sessionId = contextResetBoundaryReadFailed
        ? undefined
        : await preflightRace(
            sessionManager.get(userId, catId, threadId, contextResetBoundary?.resetAt),
            'sessionManager.get',
            signal,
          );
    } catch (err) {
      // Redis read failure or preflight timeout — continue without session
      log.warn({ catId, threadId, invocationId, err }, 'Session get failed (timeout or Redis), proceeding without');
    }

    // R8 P1: Read-side short-circuit — if sessionChainStore has sealed/sealing sessions
    // but NO active session, the previous session was sealed. Discard the persisted CLI
    // sessionId to prevent --resume into a sealed session. This eliminates the race
    // window between fire-and-forget delete and next get().
    // Only applies when chain is non-empty (empty chain = fresh thread, keep sessionId).
    //
    // R11 P1-1: When active record exists, its cliSessionId is the authoritative value.
    // sessionManager.get() may return a stale value if session_init updated the record
    // but sessionManager wasn't re-written. Always align to the active record.
    //
    // F33-fix: Always check chain even when sessionManager returns nothing.
    // The PATCH bind endpoint writes to sessionChainStore but not sessionManager,
    // so a freshly-bound session would be missed if we gate on sessionId being truthy.
    const sessionChainActive = isSessionChainEnabled(catId);
    if (deps.sessionChainStore && sessionChainActive) {
      // Reaper: reconcile any sessions stuck in 'sealing' > 5 minutes (best-effort).
      if (deps.sessionSealer) {
        try {
          await preflightRace(deps.sessionSealer.reconcileStuck(catId, threadId), 'reconcileStuck', signal);
        } catch {
          /* best-effort reconcile — timeout or error */
        }
      }
      try {
        const chain = await preflightRace(
          Promise.resolve(deps.sessionChainStore.getChain(catId, threadId)),
          'getChain',
          signal,
        );
        if (chain.length > 0) {
          const activeRec = chain.find((s) => s.status === 'active');
          if (!activeRec) {
            // Chain exists but no active session → previous was sealed; don't resume
            sessionId = undefined;
          } else if (activeRec.cliSessionId) {
            authoritativeSessionCreatedAt = activeRec.createdAt;
            // F118 AC-C6: Overflow circuit breaker — too many consecutive restore failures (#86)
            // Note: time-based "stale" check removed — idle sessions are healthy,
            // only repeated restore failures indicate a toxic session.
            const MAX_CONSECUTIVE_FAILURES = 3;
            const isOverflow = (activeRec.consecutiveRestoreFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES;
            if (isOverflow && deps.sessionSealer) {
              let sealOk = false;
              try {
                const result = await preflightRace(
                  deps.sessionSealer.requestSeal({ sessionId: activeRec.id, reason: 'overflow_circuit_breaker' }),
                  'requestSeal',
                  signal,
                );
                sealOk = result.accepted;
                if (sealOk) {
                  // Must finalize to write transcript + digest to disk,
                  // otherwise session recall tools get 404 (no data on disk).
                  deps.sessionSealer.finalize({ sessionId: activeRec.id }).catch(() => {});
                }
              } catch {
                /* best-effort seal */
              }
              // Only drop sessionId if seal succeeded — otherwise resume with existing
              if (sealOk) {
                sessionId = undefined;
              } else {
                sessionId = activeRec.cliSessionId;
              }
            } else {
              // Active record's cliSessionId is authoritative (includes F33 manual bind)
              sessionId = activeRec.cliSessionId;
            }
          }
        }
      } catch {
        // R9 P1: Fail-closed — if chain store read fails, discard sessionId.
        // Rationale: requestSeal accepted = hard seal boundary. When we can't
        // verify chain state, it's safer to start fresh than risk --resume
        // into a sealed session. Lost resume is recoverable; sealed-session
        // corruption is not.
        sessionId = undefined;
      }
    }

    if (
      contextResetBoundaryReadFailed ||
      (sessionChainActive &&
        contextResetBoundary &&
        (!authoritativeSessionCreatedAt || authoritativeSessionCreatedAt < contextResetBoundary.resetAt))
    ) {
      sessionId = undefined;
    }

    // Batch 4-C4: a scheduler tick is an independent execution. Its durable
    // context comes from the normal digest/memory path, not an ever-growing
    // provider-native --resume transcript from an earlier tick.
    if (params.forceFreshCliSession) {
      sessionId = undefined;
    }

    // Claude budget gate: high-history threads must not resume a huge hidden CLI session.
    const preResumeCatConfig = catRegistry.tryGet(catId as string)?.config;
    let budgetGateUsage:
      | {
          budgetGateTriggered: true;
          historyFullTokensBeforeGate?: number;
        }
      | undefined;
    const preResumeBudgetGate = evaluateClaudeBudgetGate({
      provider: preResumeCatConfig?.clientId,
      contextBudget: params.contextBudget,
      hasResumeSession: Boolean(sessionId),
    });
    if (preResumeBudgetGate.action === 'drop-resume') {
      log.warn(
        {
          threadId,
          catId,
          userId,
          invocationId,
          sessionId,
          reason: preResumeBudgetGate.reason,
          historyFullTokens: preResumeBudgetGate.historyFullTokens,
          historyBudgetRatio: preResumeBudgetGate.historyBudgetRatio,
          thresholdTokens: preResumeBudgetGate.thresholdTokens,
          thresholdRatio: preResumeBudgetGate.thresholdRatio,
        },
        'Claude budget gate dropped resume session before subprocess launch',
      );
      budgetGateUsage = {
        budgetGateTriggered: true,
        ...(preResumeBudgetGate.historyFullTokens != null
          ? { historyFullTokensBeforeGate: preResumeBudgetGate.historyFullTokens }
          : {}),
      };
      sessionId = undefined;
    }

    // F118: Acquire per-cliSessionId mutex to prevent concurrent resume
    if (sessionId) {
      try {
        sessionMutexRelease = await sessionMutex.acquire(sessionId, signal, {
          timeoutMs: SESSION_MUTEX_WAIT_TIMEOUT_MS,
        });
      } catch (err) {
        // Abort while queued is not a runtime error — clean exit
        if (signal?.aborted) {
          const sc = invocationSpan.spanContext();
          const parentSid = params.routeSpan?.spanContext().spanId;
          yield {
            type: 'done' as const,
            catId,
            isFinal: isLastCat,
            timestamp: Date.now(),
            tracing: { traceId: sc.traceId, spanId: sc.spanId, ...(parentSid ? { parentSpanId: parentSid } : {}) },
          };
          didComplete = true; // F118 AC-C5: Abort early exit, not force-return
          return;
        }
        if (err instanceof Error && /SessionMutex acquire timeout/i.test(err.message)) {
          log.warn(
            { threadId, catId, userId, invocationId, sessionId, timeoutMs: SESSION_MUTEX_WAIT_TIMEOUT_MS },
            'Session mutex wait timed out — starting a fresh CLI session to avoid a stuck invocation',
          );
          sessionId = undefined;
        } else {
          throw err; // unexpected error — let outer catch handle
        }
      }
    }

    // Resolve workingDirectory from thread's projectPath
    let workingDirectory: string | undefined;
    if (threadStore) {
      try {
        const thread = await preflightRace(Promise.resolve(threadStore.get(threadId)), 'threadStore.get', signal);
        if (thread?.createdAt) threadCreatedAt = thread.createdAt;
        if (thread?.projectPath && thread.projectPath !== 'default') {
          if (isUnderAllowedRoot(thread.projectPath)) {
            workingDirectory = thread.projectPath;
          }
        }
      } catch {
        // Thread store timeout or error — proceed without workingDirectory
      }
    }
    const workingProjectRoot = workingDirectory ? findMonorepoRoot(workingDirectory) : undefined;

    // F-G (PRD-memory-upgrade 批次 3): CLI 原生 session 撑爆治理——即将 --resume 一个旧
    // session 之前，检查它在磁盘上的原生体积。默认全关（CLOWDER_CLI_SESSION_MAX_MB
    // 未设置/0）时 maybeRotateCliNativeSession 在任何 fs 访问之前就短路返回
    // disabled，零行为变化。超限且该猫在 CLOWDER_CLI_SESSION_ROTATE_CATS 白名单内时，
    // 把本地 sessionId 清空——下面 session_init 的既有 'cli_session_replaced' 分支
    // （约:1780+）会自动 seal 旧 chain 记录、绑定新记录，不需要额外接线。
    if (sessionId) {
      try {
        rotationEvent = await maybeRotateCliNativeSession({
          catId: catId as string,
          clientId: preResumeCatConfig?.clientId,
          sessionId,
          workingDirectory,
        });
      } catch (err) {
        log.warn({ catId, threadId, invocationId, sessionId, err }, 'CLI native session rotation check failed (non-blocking, resume proceeds)');
        rotationEvent = undefined;
      }
      if (rotationEvent?.rotated) {
        log.warn(
          {
            catId,
            threadId,
            invocationId,
            oldSessionId: rotationEvent.sessionId,
            sessionPath: rotationEvent.sessionPath,
            sizeBytes: rotationEvent.sizeBytes,
            thresholdBytes: rotationEvent.thresholdBytes,
            archivedPath: rotationEvent.archivedPath,
          },
          'CLI native session rotated — starting a fresh session; archived old session file (not deleted)',
        );
        sessionId = undefined;
        if (deps.messageStore) {
          const sizeMb = rotationEvent.sizeBytes != null ? (rotationEvent.sizeBytes / (1024 * 1024)).toFixed(1) : '?';
          try {
            await deps.messageStore.append({
              userId: 'system',
              catId: null,
              content: `已为 ${catId} 开启新会话（旧会话 ${sizeMb} MB 已归档），要点已沉淀记忆。`,
              mentions: [],
              timestamp: Date.now(),
              threadId,
              source: {
                connector: 'session-governance',
                label: 'Session',
                icon: '🗂️',
                meta: { presentation: 'system_notice', noticeTone: 'info', eventType: 'cli_session_rotated' },
              },
              extra: { systemKind: 'cli_session_rotated' },
            });
          } catch (err) {
            log.warn({ catId, threadId, invocationId, err }, 'CLI session rotation notice append failed (non-blocking)');
          }
        }
      }
    }

    // Shared-state preflight — covers ALL cats (Claude/Codex/Gemini), vendor-agnostic.
    // Three-layer defense model (shared-rules §14):
    //   L1 .githooks/pre-commit = hard block (prevents committing on wrong branch)
    //   L2 this check = see below
    //   L3 CI guard = hard block (prevents merging PRs with shared-state changes)
    //
    // Scope: only check the host Clowder AI repo (or its worktrees). External projects /
    // fork playgrounds may be routed by this runtime, but they must not inherit
    // shared-state warnings from the repo that launched the API process.
    if (
      process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT !== '1' &&
      (!workingProjectRoot || isSameProject(workingProjectRoot, hostProjectRoot))
    ) {
      // L2 behavior is warn-only during interactive invocation. Hard safety still lives
      // in L1/L3 (`pre-commit` + CI / merge gate); blocking regular chat invocations on
      // local git state made multi-cat routing unusable whenever shared-state lagged.
      try {
        const { checkSharedStatePreflight } = await import('../../../../../config/shared-state-preflight.js');
        const preflightRoot = workingProjectRoot ?? hostProjectRoot;
        const ssCheck = checkSharedStatePreflight(preflightRoot);
        if (!ssCheck.ok) {
          if (ssCheck.unpushedFiles?.length) {
            const msg =
              `Shared-state files committed but not pushed: ${ssCheck.unpushedFiles.join(', ')}. ` +
              'Please `git push` soon so other cats see the latest shared state (shared-rules §14).';
            log.warn(
              { catId, preflightRoot, unpushedFiles: ssCheck.unpushedFiles },
              'Shared-state preflight: unpushed files',
            );
            yield {
              type: 'system_info' as const,
              catId,
              content: `⚠️ ${msg}`,
              timestamp: Date.now(),
            };
          }
          if (ssCheck.uncommittedFiles?.length) {
            const msg = `uncommitted shared-state files: ${ssCheck.uncommittedFiles.join(', ')}`;
            log.warn(
              { catId, preflightRoot, uncommittedFiles: ssCheck.uncommittedFiles },
              'Shared-state preflight: uncommitted files',
            );
            yield {
              type: 'system_info' as const,
              catId,
              content: `⚠️ Shared-state preflight: ${msg}. Please commit+push before continuing (shared-rules §14).`,
              timestamp: Date.now(),
            };
          }
        }
      } catch {
        // Don't block on preflight errors
      }
    }

    // F070: Governance gate for external project dispatch
    if (workingDirectory && !isSameProject(workingDirectory, hostProjectRoot)) {
      const catCafeRoot = hostProjectRoot;
      const catEntry = catRegistry.tryGet(catId as string);
      let preflight: Awaited<
        ReturnType<typeof import('../../../../../config/governance/governance-preflight.js').checkGovernancePreflight>
      >;
      try {
        const { tryGovernanceBootstrap } = await import(
          '../../../../../config/capabilities/capability-orchestrator.js'
        );
        await tryGovernanceBootstrap(workingDirectory, catCafeRoot);
        const { checkGovernancePreflight } = await import('../../../../../config/governance/governance-preflight.js');
        preflight = await checkGovernancePreflight(workingDirectory, catCafeRoot, catEntry?.config.clientId);
      } catch (err) {
        if (!isFilesystemPermissionError(err)) throw err;
        log.warn({ catId, workingDirectory, err }, 'Governance preflight permission denied');
        // The gate's contract is "governance rules present in the workdir", not "auto-sync
        // refresh write succeeded". macOS TCC can deny bootstrap's write (or even a single
        // read) transiently while the rules block is already on disk — blocking dispatch in
        // that state killed runs with no user-visible trace (2026-07-25 推特日报 incident).
        // Fall back to the read-only preflight; only block when that also cannot pass.
        try {
          const { checkGovernancePreflight } = await import(
            '../../../../../config/governance/governance-preflight.js'
          );
          preflight = await checkGovernancePreflight(workingDirectory, catCafeRoot, catEntry?.config.clientId);
          if (preflight.ready) {
            log.warn(
              { catId, workingDirectory },
              'Governance auto-sync write denied but rules already present — proceeding without refresh',
            );
          }
        } catch {
          preflight = {
            ready: false,
            needsPermission: true,
            reason:
              `Clowder cannot read ${workingDirectory}. ` +
              'macOS may be blocking protected folders such as Documents/Desktop/Downloads. ' +
              'Grant Full Disk Access to the app that runs Clowder, then restart Clowder.',
          };
        }
      }
      // Last-resort fail-open — applies to BOTH computation paths (bootstrap threw, OR the
      // read-only preflight returned needsPermission via its normal internal catch, e.g. only
      // the skills-dir read is TCC-denied). The governance registry lives inside catCafeRoot
      // (always readable) and records the human's one-time confirmation — that recorded
      // consent, not a live file read, is the gate's real source of truth. The spawned cat
      // CLI carries its own macOS permission grants, so dispatch can still succeed even when
      // the api cannot touch the folder. (2026-07-26: previously this only covered the
      // throw path — silent blocks recurred through the normal-return path.)
      if (!preflight.ready && preflight.needsPermission) {
        try {
          const { GovernanceBootstrapService } = await import(
            '../../../../../config/governance/governance-bootstrap.js'
          );
          const registryEntry = await new GovernanceBootstrapService(catCafeRoot).getRegistry().get(workingDirectory);
          if (registryEntry?.confirmedByUser) {
            log.warn(
              { catId, workingDirectory },
              'Governance blocked by OS permission but project is registered+confirmed — proceeding (fail-open)',
            );
            preflight = { ready: true };
          }
        } catch {
          // Registry unreadable too — keep the permission-denied block.
        }
      }
      if (!preflight.ready) {
        const reasonKind = preflight.needsPermission
          ? 'permission_denied'
          : preflight.needsBootstrap
            ? 'needs_bootstrap'
            : preflight.needsConfirmation
              ? 'needs_confirmation'
              : 'files_missing';
        // 2026-07-26: a governance block previously left ZERO trace — the yielded card is
        // stream-only in practice and nothing logged. Two silent-death incidents later:
        // always log, and best-effort persist a real thread message so the user sees it.
        log.warn(
          { catId, workingDirectory, reasonKind, reason: preflight.reason },
          'Governance gate blocked dispatch',
        );
        // A2 (base spec): a permission_denied block means the OS just revoked access to
        // something — trigger A1's self-check immediately instead of waiting for the
        // next restart, so the lobby alert (and its later resolution notice) reflects
        // reality as soon as possible. Fire-and-forget, best-effort: this must never
        // slow down or fail the dispatch-block path itself.
        if (reasonKind === 'permission_denied') {
          void import('../../../../../services/StartupPermissionCheck.js')
            .then(({ getActiveStartupPermissionCheck }) => getActiveStartupPermissionCheck()?.runCheck())
            .catch((err) => log.warn({ err }, '[invoke-single-cat] A1 recheck trigger failed (best-effort)'));
        }
        if (deps.messageStore) {
          try {
            await deps.messageStore.append({
              userId: 'system',
              catId: null,
              threadId: params.threadId,
              content: `🚫 @${catId} 的派单被治理门拦下（${reasonKind}）：${preflight.reason ?? '原因未知'}`,
              mentions: [],
              timestamp: Date.now(),
              source: {
                connector: 'governance-blocked',
                label: '治理拦截',
                icon: 'warning',
                meta: { presentation: 'system_notice', noticeTone: 'warning', reasonKind, projectPath: workingDirectory },
              },
              idempotencyKey: `governance-blocked:${params.parentInvocationId ?? `${params.threadId}:${catId as string}`}`,
            });
          } catch {
            /* best-effort — visibility must not break the block path itself */
          }
        }
        // F070: Structured governance_blocked event — frontend renders actionable card
        yield {
          type: 'system_info',
          catId,
          content: JSON.stringify({
            type: 'governance_blocked',
            projectPath: workingDirectory,
            reasonKind,
            reason: preflight.reason,
            invocationId: params.parentInvocationId,
          }),
          timestamp: Date.now(),
        };
        // F070: done with errorCode so routes mark invocation as failed (retryable)
        yield {
          type: 'done',
          catId,
          isFinal: params.isLastCat,
          errorCode: preflight.needsPermission ? 'PROJECT_PERMISSION_DENIED' : 'GOVERNANCE_BOOTSTRAP_REQUIRED',
          timestamp: Date.now(),
        };
        didComplete = true;
        return;
      }
    }

    // F070 Phase 2: Inject dispatch mission context for external projects
    let missionPrefix = '';
    let capturedMissionPack: import('@cat-cafe/shared').DispatchMissionPack | undefined;
    if (workingDirectory && !isSameProject(workingDirectory, hostProjectRoot) && threadStore) {
      try {
        const thread = await preflightRace(
          Promise.resolve(threadStore.get(threadId)),
          'threadStore.get:mission',
          signal,
        );
        if (thread) {
          const { buildMissionPack, formatMissionPackPrompt } = await import(
            '../../../../../config/governance/mission-pack.js'
          );
          capturedMissionPack = buildMissionPack({
            title: thread.title ?? undefined,
            phase: thread.phase ?? undefined,
            backlogItemId: thread.backlogItemId ?? undefined,
          });
          missionPrefix = formatMissionPackPrompt(capturedMissionPack);
        }
      } catch {
        // Thread store timeout — proceed without mission context
      }
    }

    // F127 account injection:
    // Members bind to a concrete accountRef (builtin oauth account or generic api_key account).
    const catConfig = catRegistry.tryGet(catId as string)?.config;
    const provider = catConfig?.clientId;
    const builtinClient = provider ? resolveBuiltinClientForProvider(provider) : null;
    const defaultModel = catConfig?.defaultModel?.trim() || undefined;
    // Account resolution, proxy registration, and runtime config always use the
    // runtime root (process.cwd()), NOT thread.projectPath.  catRegistry loads
    // from the runtime root at startup — reading a divergent catalog (e.g. the
    // dev worktree pointed to by thread.projectPath) misses runtime-only accounts.
    // workingProjectRoot is still used for shared-state preflight + cat cwd.
    const projectRoot = resolveActiveProjectRoot(process.cwd());
    const effectiveAccountRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
    const resolveRuntimeAccount = async () => {
      if (!builtinClient) return null;
      // Yield to event loop so preflight warnings are delivered before account resolution.
      await Promise.resolve();
      const runtime = resolveForClient(projectRoot, builtinClient, effectiveAccountRef);
      if (effectiveAccountRef && !runtime) {
        throw new Error(`bound account "${effectiveAccountRef}" not found`);
      }
      return runtime;
    };
    const assertCompatibleRuntimeAccount = <T extends { id: string }>(
      account: (T & Parameters<typeof validateRuntimeProviderBinding>[1]) | null,
    ) => {
      if (!provider || !account) return account;
      const compatibilityError = validateRuntimeProviderBinding(provider, account, defaultModel);
      if (compatibilityError) {
        throw new Error(compatibilityError);
      }
      return account;
    };
    const isExplicitBindingCompatibilityError = (err: unknown): err is Error =>
      err instanceof Error &&
      (/bound provider profile/i.test(err.message) || /model ".+" is not available on provider/i.test(err.message));
    const isBoundAccountResolutionError = (err: unknown): err is Error =>
      err instanceof Error && /bound account ".+" not found/i.test(err.message);

    // Resolve account first, then use its protocol for env injection.
    // For API Key accounts, protocol is declared on the account itself.
    // For builtin OAuth accounts, protocol comes from the provider mapping.
    let resolvedAccount: Awaited<ReturnType<typeof resolveRuntimeAccount>> = null;
    try {
      resolvedAccount = assertCompatibleRuntimeAccount(await resolveRuntimeAccount());
    } catch (err) {
      if (isExplicitBindingCompatibilityError(err) || isBoundAccountResolutionError(err)) {
        throw err;
      }
      if (effectiveAccountRef) {
        throw new Error(`failed to resolve bound account "${effectiveAccountRef}"`);
      }
    }

    // Fail fast when an api_key account has no credential — otherwise the child
    // process silently receives no auth and produces cryptic errors.
    if (resolvedAccount?.authType === 'api_key' && !resolvedAccount.apiKey) {
      throw new Error(
        `account "${resolvedAccount.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }

    // clowder-ai#340: Protocol is fully derived from client/provider identity — account.protocol retired.
    // Non-opencode clients have a fixed protocol. OpenCode derives protocol from the
    // variant's model provider name or model string prefix, defaulting to anthropic.
    const protocolForProvider: Record<string, string> = {
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
      kimi: 'kimi',
      grok: 'xai',
      dare: 'openai',
      opencode: 'anthropic',
      openrouter: 'openai',
    };
    let effectiveProtocol: string | null = provider ? (protocolForProvider[provider] ?? null) : null;
    if (provider === 'opencode') {
      // Priority 1: explicit variant.provider field
      const modelProviderHint = catConfig?.provider?.trim();
      if (modelProviderHint && protocolForProvider[modelProviderHint]) {
        effectiveProtocol = protocolForProvider[modelProviderHint];
      } else {
        // Priority 2: model string prefix (e.g. 'openrouter/google/model' → openrouter → openai)
        const trimmedModel = typeof defaultModel === 'string' ? defaultModel.trim() : '';
        const parsed = trimmedModel ? parseOpenCodeModel(trimmedModel) : null;
        if (parsed && protocolForProvider[parsed.providerName]) {
          effectiveProtocol = protocolForProvider[parsed.providerName];
        }
      }
    }

    // effectiveProtocol is used below for env injection branching (anthropic/openai/google)
    // but is NOT passed to callbackEnv — it should not influence CLI routing decisions.

    if (effectiveProtocol === 'anthropic') {
      if (resolvedAccount?.authType === 'api_key') {
        callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'api_key';
        if (resolvedAccount.apiKey) callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.models?.length && provider !== 'opencode') {
          callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE = resolvedAccount.models[0];
        }
        if (resolvedAccount.baseUrl) {
          const proxyPortStr = process.env.ANTHROPIC_PROXY_PORT || '9877';
          const proxyPortNum = parseInt(proxyPortStr, 10);
          const proxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED !== '0';
          if (proxyEnabled && !Number.isNaN(proxyPortNum) && proxyPortNum > 0 && proxyPortNum <= 65535) {
            const proxyAlive = await tcpProbe('127.0.0.1', proxyPortNum);
            if (proxyAlive) {
              const slug = deriveProxySlug(resolvedAccount.id);
              registerProxyUpstream(projectRoot, slug, resolvedAccount.baseUrl);
              callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPortStr}/${slug}`;
            } else {
              log.warn(
                { proxyPort: proxyPortStr, baseUrl: resolvedAccount.baseUrl },
                'Proxy unreachable, falling back to direct upstream',
              );
              callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = resolvedAccount.baseUrl;
            }
          } else {
            if (proxyEnabled && (Number.isNaN(proxyPortNum) || proxyPortNum <= 0 || proxyPortNum > 65535)) {
              log.warn({ proxyPort: proxyPortStr }, 'Invalid ANTHROPIC_PROXY_PORT, falling back to direct upstream');
            }
            callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = resolvedAccount.baseUrl;
          }
        }
      } else {
        callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'subscription';
      }
    } else if (effectiveProtocol === 'openai' || effectiveProtocol === 'openai-responses') {
      if (resolvedAccount?.authType === 'api_key') {
        callbackEnv.CODEX_AUTH_MODE = 'api_key';
        if (resolvedAccount.apiKey) {
          callbackEnv.OPENAI_API_KEY = resolvedAccount.apiKey;
          // OpenCode selects provider by model prefix; `openrouter/...` models require this key name.
          callbackEnv.OPENROUTER_API_KEY = resolvedAccount.apiKey;
        }
        if (resolvedAccount.baseUrl) {
          callbackEnv.OPENAI_BASE_URL = resolvedAccount.baseUrl;
          callbackEnv.OPENAI_API_BASE = resolvedAccount.baseUrl;
        }
      } else if (effectiveAccountRef) {
        callbackEnv.CODEX_AUTH_MODE = 'oauth';
      }
    } else if (effectiveProtocol === 'google') {
      if (resolvedAccount?.authType === 'api_key' && resolvedAccount.apiKey) {
        // Gemini CLI: native Google SDK, uses GEMINI_API_KEY
        callbackEnv.GEMINI_API_KEY = resolvedAccount.apiKey;
        callbackEnv.GOOGLE_API_KEY = resolvedAccount.apiKey;
        // opencode CLI: OpenRouter provider uses OPENROUTER_API_KEY
        callbackEnv.OPENROUTER_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.baseUrl) {
          callbackEnv.GEMINI_BASE_URL = resolvedAccount.baseUrl;
        }
      }
    } else if (effectiveProtocol === 'kimi') {
      if (resolvedAccount?.authType === 'api_key' && resolvedAccount.apiKey) {
        callbackEnv.CAT_CAFE_KIMI_PROFILE_MODE = 'api_key';
        callbackEnv.CAT_CAFE_KIMI_API_KEY = resolvedAccount.apiKey;
        callbackEnv.MOONSHOT_API_KEY = resolvedAccount.apiKey;
        if (resolvedAccount.baseUrl) {
          callbackEnv.CAT_CAFE_KIMI_BASE_URL = resolvedAccount.baseUrl;
        }
      } else {
        callbackEnv.CAT_CAFE_KIMI_PROFILE_MODE = 'subscription';
      }
    } else if (effectiveProtocol === 'xai') {
      if (resolvedAccount?.authType === 'api_key' && resolvedAccount.apiKey) {
        callbackEnv.CAT_CAFE_GROK_PROFILE_MODE = 'api_key';
        callbackEnv.XAI_API_KEY = resolvedAccount.apiKey;
      } else {
        callbackEnv.CAT_CAFE_GROK_PROFILE_MODE = 'subscription';
      }
    } else if (provider === 'anthropic' || provider === 'opencode') {
      // Fallback for unresolved accounts on anthropic/opencode providers
      callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = 'subscription';
    }

    // Dare has its own env vars regardless of protocol-based injection above
    if (provider === 'dare' && resolvedAccount?.authType === 'api_key') {
      if (resolvedAccount.apiKey) callbackEnv.DARE_API_KEY = resolvedAccount.apiKey;
      if (resolvedAccount.baseUrl) callbackEnv.DARE_ENDPOINT = resolvedAccount.baseUrl;
    }

    // F171: User-defined env vars from account config.
    // Passed separately via accountEnv — NOT injected into callbackEnv.
    // callbackEnv is for MCP callback routing; accountEnv is applied LAST
    // in subprocess env so user vars override provider-injected values.
    let accountEnv: Record<string, string> | undefined;
    if (resolvedAccount?.envVars) {
      // 票B B1: defense-in-depth — drop secret-like entries (accounts written
      // before write-time rejection existed). Values are never logged.
      const filtered = filterAccountEnvVars(resolvedAccount.envVars, (drop) => {
        if (drop.reason === 'secret_like') {
          log.warn(
            { catId, invocationId, envKey: drop.maskedKey, detail: drop.detail },
            '[security] dropping secret-like account envVars entry — store secrets in credentials, not envVars',
          );
        }
      });
      if (Object.keys(filtered).length > 0) accountEnv = filtered;
    }

    const trimmedDefaultModel = typeof defaultModel === 'string' ? defaultModel.trim() : undefined;
    const modelProviderName = catConfig?.provider?.trim() || undefined;
    const parsedOpenCodeModel =
      provider === 'opencode' && trimmedDefaultModel ? parseOpenCodeModel(trimmedDefaultModel) : null;
    // clowder-ai#223 intake: determine effective provider + model.
    // Three cases for defaultModel shape:
    //   1. Canonical "provider/model" where parsed provider === modelProviderName → use as-is
    //   2. Namespaced "ns/model" where parsed prefix ≠ modelProviderName → prefix with modelProviderName
    //   3. Bare "model" → prefix with modelProviderName if available
    // When modelProviderName is absent, parseOpenCodeModel is the sole source.
    let effectiveProviderName: string | undefined;
    let effectiveModel: string | undefined;
    if (parsedOpenCodeModel) {
      if (modelProviderName && parsedOpenCodeModel.providerName !== modelProviderName) {
        // Namespace case: model's "/" is a namespace separator, not provider prefix
        effectiveProviderName = modelProviderName;
        effectiveModel = `${modelProviderName}/${trimmedDefaultModel}`;
      } else {
        // Canonical provider/model (with or without matching modelProviderName)
        effectiveProviderName = modelProviderName || parsedOpenCodeModel.providerName;
        effectiveModel = trimmedDefaultModel!;
      }
    } else if (modelProviderName && trimmedDefaultModel) {
      // Bare model + modelProviderName fallback
      effectiveProviderName = modelProviderName;
      effectiveModel = `${modelProviderName}/${trimmedDefaultModel}`;
    }

    if (provider === 'opencode') {
      log.debug(
        {
          catId,
          invocationId,
          boundAccountRef: effectiveAccountRef ?? null,
          resolvedAccount: resolvedAccount
            ? {
                id: resolvedAccount.id,
                authType: resolvedAccount.authType,
                baseUrl: resolvedAccount.baseUrl ?? null,
                modelCount: resolvedAccount.models?.length ?? 0,
                hasApiKey: Boolean(resolvedAccount.apiKey),
              }
            : null,
          defaultModel: trimmedDefaultModel ?? null,
          modelProviderName: modelProviderName ?? null,
          parsedOpenCodeModel,
          effectiveProviderName: effectiveProviderName ?? null,
          effectiveModel: effectiveModel ?? null,
        },
        'Resolved OpenCode runtime inputs',
      );
    }
    // fix(#280): explicit provider name means we must force the clowder-ai#223 path so the
    // effective "provider/model" string is injected into opencode, even for builtin
    // providers. For legacy members without provider name, only synthesize runtime
    // config when the fully-qualified model is not already routable by `opencode models`.
    //
    // MCP injection: even known models need a runtime config to get deterministic
    // Cat Cafe MCP server access (especially in game threads where project-level
    // opencode.json may not be discoverable).
    const hasExplicitOcProvider = Boolean(modelProviderName);
    const configuredMcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH?.trim();
    const mcpServerPath = configuredMcpServerPath
      ? resolve(process.cwd(), configuredMcpServerPath)
      : resolveDefaultClaudeMcpServerPath();
    if (
      provider === 'opencode' &&
      resolvedAccount != null &&
      resolvedAccount.authType === 'api_key' &&
      effectiveModel &&
      effectiveProviderName &&
      (hasExplicitOcProvider || !getOpenCodeKnownModels().has(effectiveModel) || mcpServerPath)
    ) {
      // Remap model prefix when provider name collides with OpenCode builtins
      // (e.g. 'openai/gpt-4o' → 'openai-compat/gpt-4o') so the CLI -m arg
      // matches the remapped provider key in opencode.json.
      const safeProvider = safeProviderName(effectiveProviderName);
      const safeModel =
        safeProvider !== effectiveProviderName && effectiveModel.startsWith(`${effectiveProviderName}/`)
          ? `${safeProvider}/${effectiveModel.slice(effectiveProviderName.length + 1)}`
          : effectiveModel;
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE = safeModel;
      const apiType = deriveOpenCodeApiType(effectiveProviderName);
      const rawModels = resolvedAccount.models?.length ? resolvedAccount.models : [effectiveModel];
      const runtimeConfigOptions = {
        providerName: effectiveProviderName,
        models: rawModels,
        defaultModel: effectiveModel,
        apiType,
        hasBaseUrl: Boolean(resolvedAccount.baseUrl),
        mcpServerPath,
      } as const;
      openCodeRuntimeConfigPath = writeOpenCodeRuntimeConfig(
        projectRoot,
        catId as string,
        invocationId,
        runtimeConfigOptions,
      );
      callbackEnv.OPENCODE_CONFIG = openCodeRuntimeConfigPath;
      if (resolvedAccount.apiKey) callbackEnv[OC_API_KEY_ENV] = resolvedAccount.apiKey;
      if (resolvedAccount.baseUrl) callbackEnv[OC_BASE_URL_ENV] = resolvedAccount.baseUrl;
      log.debug(
        {
          catId,
          invocationId,
          openCodeConfigPath: openCodeRuntimeConfigPath,
          apiType,
          callbackEnvSummary: {
            opencodeConfig: callbackEnv.OPENCODE_CONFIG,
            ocBaseUrl: callbackEnv[OC_BASE_URL_ENV] ?? null,
            ocApiKeyPresent: Boolean(callbackEnv[OC_API_KEY_ENV]),
            modelOverride: callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? null,
          },
          runtimeConfigSummary: summarizeOpenCodeRuntimeConfigForDebug(runtimeConfigOptions),
        },
        'Prepared OpenCode runtime config',
      );
    }

    // F-BLOAT: Only inject staticIdentity (systemPrompt) on new sessions for cats
    // that support persistent sessions (sessionChain=true).
    // Cats with sessionChain=false always need it — each turn is effectively new.
    // Note: As of F053, all cats (including Gemini) have sessionChain=true.
    // Exception: compression detected → force re-inject (see _needsReinjection)
    //
    // Injection method: prepend to prompt string (universal, all CLIs).
    // --append-system-prompt proved unreliable (cats didn't receive content).
    // Codex/Gemini AgentServices also prepend if options.systemPrompt is set,
    // so we intentionally do NOT pass systemPrompt in options to avoid double injection.
    const isResume = !!sessionId;
    const canSkipOnResume = isSessionChainEnabled(catId);
    const compressionKey = `${userId}:${catId as string}:${threadId}`;
    const forceReinjection = _needsReinjection.delete(compressionKey);
    const registryRevision = catRegistry.getRevision();
    const identityKey = sessionIdentityKey(userId, catId, threadId);
    const lastStaticIdentityRevision = _staticIdentityRegistryRevision.get(identityKey);
    const registryChangedSinceStaticIdentity =
      canSkipOnResume &&
      isResume &&
      lastStaticIdentityRevision !== undefined &&
      lastStaticIdentityRevision !== registryRevision;
    const injectSystemPrompt = !canSkipOnResume || !isResume || forceReinjection || registryChangedSinceStaticIdentity;
    if (canSkipOnResume) {
      if (injectSystemPrompt) {
        _staticIdentityRegistryRevision.set(identityKey, registryRevision);
      } else if (isResume && lastStaticIdentityRevision === undefined) {
        _staticIdentityRegistryRevision.set(identityKey, registryRevision);
      }
    }

    // Prepend staticIdentity to prompt when injection is needed
    // F070-P2: missionPrefix (dispatch context) is prepended for external projects
    const promptWithMission = missionPrefix ? `${missionPrefix}\n\n${prompt}` : prompt;

    // ADR-024 D2 (v2 transport seam): when the caller supplies a structured
    // transportPayload, the system slot is delivered via the adapter's system
    // channel (options.systemPrompt → --append-system-prompt), NOT prepended into
    // the `-p` body — otherwise system would be injected twice. Gated by payload
    // presence, so v1 and non-seam adapters keep the existing prepend behavior.
    const useTransportSeam = !!params.transportPayload;
    const effectivePrompt =
      !useTransportSeam && injectSystemPrompt && params.systemPrompt
        ? `${params.systemPrompt}\n\n---\n\n${promptWithMission}`
        : `${promptWithMission}`;
    const promptSourceBreakdown = estimatePromptSourceBreakdown({
      systemPrompt: injectSystemPrompt ? params.systemPrompt : undefined,
      userPrompt: promptWithMission,
    });

    const visiblePromptBudgetGate = evaluateClaudeBudgetGate({
      provider,
      contextBudget: {
        ...(params.contextBudget ?? {
          surface: 'thread',
          threadId,
          toolPolicy: params.toolPolicy ?? 'standard',
          toolPolicySource: params.toolPolicySource ?? 'agent-default',
          mode: 'serial',
          estimatedTokens: 0,
          historyMessages: 0,
          loadedBlocks: [],
          skippedBlocks: [],
          governanceTier: 'core',
          governanceEstimatedTokens: 0,
          governanceSourceInjected: false,
          usesFullHistory: false,
          maxPromptTokens: 0,
          maxContextTokens: 0,
        }),
        estimatedTokens: Math.max(params.contextBudget?.estimatedTokens ?? 0, estimateTokens(effectivePrompt)),
      },
      hasResumeSession: Boolean(sessionId),
    });
    if (visiblePromptBudgetGate.action === 'block') {
      log.warn(
        {
          threadId,
          catId,
          userId,
          invocationId,
          reason: visiblePromptBudgetGate.reason,
          estimatedTokens: visiblePromptBudgetGate.estimatedTokens,
          thresholdTokens: visiblePromptBudgetGate.thresholdTokens,
        },
        'Claude budget gate blocked oversized visible prompt before subprocess launch',
      );
      yield {
        type: 'error' as const,
        catId,
        error:
          `Claude 预算闸门已拦截：本次可见 prompt 预计 ${visiblePromptBudgetGate.estimatedTokens} tokens，` +
          `超过上限 ${visiblePromptBudgetGate.thresholdTokens} tokens。请先压缩线程、改用摘要，或改派 Codex/Sonnet。`,
        timestamp: Date.now(),
      };
      yield {
        type: 'done' as const,
        catId,
        isFinal: params.isLastCat,
        errorCode: 'CLAUDE_PROMPT_BUDGET_EXCEEDED',
        timestamp: Date.now(),
      };
      didComplete = true;
      return;
    }

    capturePromptIfEnabled({
      catId: catId as string,
      invocationId,
      threadId,
      userId,
      model: resolvedAccount?.models?.[0] ?? 'unknown',
      systemPrompt: params.systemPrompt ?? '',
      missionPrefix: missionPrefix ?? undefined,
      userPrompt: prompt,
      effectivePrompt,
      injectionDecision: { isResume, canSkipOnResume, forceReinjection, injected: injectSystemPrompt },
    });

    // F089 Phase 2+3: Create tmux spawn override for agent-in-pane execution
    let spawnCliOverride: AgentServiceOptions['spawnCliOverride'];
    if (deps.tmuxGateway && workingDirectory) {
      const { resolveWorktreeIdByPath } = await import('../../../../workspace/workspace-security.js');
      const { createTmuxSpawnOverride } = await import('../../../../terminal/tmux-agent-spawner.js');
      try {
        const worktreeId = await resolveWorktreeIdByPath(workingDirectory);
        spawnCliOverride = createTmuxSpawnOverride(
          worktreeId,
          invocationId,
          userId,
          deps.tmuxGateway,
          deps.agentPaneRegistry,
        );
      } catch {
        log.warn({ workingDirectory }, 'resolveWorktreeIdByPath failed — skipping tmux pane');
      }
    }

    const baseOptions: AgentServiceOptions = {
      callbackEnv,
      ...(accountEnv ? { accountEnv } : {}),
      auditContext: {
        invocationId,
        threadId,
        userId,
        catId,
      },
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(params.contentBlocks ? { contentBlocks: params.contentBlocks } : {}),
      ...(params.uploadDir ? { uploadDir: params.uploadDir } : {}),
      ...(signal ? { signal } : {}),
      ...(spawnCliOverride ? { spawnCliOverride } : {}),
      invocationId,
      ...(sessionId ? { cliSessionId: sessionId } : {}),
      // F118 Phase B: Enable liveness probe with defaults for all CLI providers
      // #774: stallAutoKill — auto-kill on idle-silent stall (~5min) instead of waiting 30min
      livenessProbe: {
        softWarningMs: 30_000,
        stallWarningMs: 300_000,
        stallAutoKill: true,
      },
      ...(catConfig?.cliConfigArgs?.length ? { cliConfigArgs: catConfig.cliConfigArgs } : {}),
      // Batch 3-E item 1: forward the resolved CatConfig permission profile so
      // ClaudeAgentService/CodexAgentService can map it to their own CLI flags.
      ...(catConfig?.permissionProfile ? { permissionProfile: catConfig.permissionProfile } : {}),
      // ADR-024 D2: v2 transport seam — hand the system slot to the adapter's system
      // channel and forward the structured payload for direct slot mapping.
      ...(params.transportPayload
        ? {
            transportPayload: params.transportPayload,
            ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          }
        : {}),
      parentSpan: invocationSpan,
    };

    let lastErrorMessage: string | undefined;

    const processMessage = async (msg: AgentMessage): Promise<AgentMessage[]> => {
      const outputs: AgentMessage[] = [];

      if (msg.type === 'error') {
        hadStreamError = true;
        lastErrorMessage = msg.error;

        // 理智线 T6 (task #388): errorCode==='usage_limit' is the ONLY trigger for
        // a cooldown write — any other/unrecognized errorCode must NOT be swept
        // into cooldown (would falsely cool down a cat on a normal error).
        if (msg.errorCode === 'usage_limit') {
          const cooldown = await recordUsageLimitCooldown(deps, { catId: catId as CatId, msg });
          if (cooldown) {
            outputs.push({
              type: 'system_info' as const,
              catId,
              content: JSON.stringify({
                type: 'cooldown_started',
                catId,
                threadId,
                until: cooldown.until,
                resetAtResolved: cooldown.resetAtResolved,
              }),
              timestamp: Date.now(),
            });
          }
        }
      }

      if (msg.type === 'session_init' && msg.sessionId) {
        log.info(
          { cliSessionId: msg.sessionId, threadId, catId, userId, invocationId },
          'Session init: binding session',
        );
        try {
          await sessionManager.store(userId, catId, threadId, msg.sessionId);
        } catch {
          // Redis write failure — session won't persist, but chain continues
        }

        // F24: Ensure SessionRecord exists for this session
        if (deps.sessionChainStore && sessionChainActive) {
          try {
            const existing = await deps.sessionChainStore.getActive(catId, threadId);
            if (existing) {
              if (existing.cliSessionId !== msg.sessionId) {
                if (msg.ephemeralSession) {
                  // ACP transport: sessionId is per-invocation (newSession() each time).
                  // This is normal — NOT a "session replaced" event. Just update the tracked ID.
                  await deps.sessionChainStore.update(existing.id, {
                    cliSessionId: msg.sessionId,
                    ...(params.continuityCapsule ? { continuityCapsule: params.continuityCapsule } : {}),
                    updatedAt: Date.now(),
                  });
                } else {
                  // CLI session changed → old context is lost (resume failed / CLI restarted).
                  // Use requestSeal + finalize to ensure transcript/digest are written,
                  // not bare update(status:'sealed') which skips flush.
                  let sealAccepted = false;
                  if (deps.sessionSealer) {
                    try {
                      const result = await deps.sessionSealer.requestSeal({
                        sessionId: existing.id,
                        reason: 'cli_session_replaced',
                      });
                      sealAccepted = result.accepted;
                      if (sealAccepted) {
                        deps.sessionSealer.finalize({ sessionId: existing.id }).catch(() => {});
                      }
                    } catch {
                      /* best-effort seal */
                    }
                  } else {
                    // Fallback: no sealer available — bare update (legacy path)
                    const now = Date.now();
                    await deps.sessionChainStore.update(existing.id, {
                      status: 'sealed',
                      sealReason: 'cli_session_replaced',
                      sealedAt: now,
                      updatedAt: now,
                    });
                    sealAccepted = true;
                  }
                  // Only create new active record if old one was successfully sealed.
                  // Otherwise we'd have two active records — a dirty state.
                  if (sealAccepted || !deps.sessionSealer) {
                    // F118 D1: Inherit failure count from the replaced session.
                    // create() doesn't accept consecutiveRestoreFailures, so use immediate update().
                    const inheritedFailures = existing.consecutiveRestoreFailures ?? 0;
                    const newRec = await deps.sessionChainStore.create({
                      cliSessionId: msg.sessionId,
                      threadId,
                      catId,
                      userId,
                    });
                    if (inheritedFailures > 0) {
                      await deps.sessionChainStore.update(newRec.id, {
                        consecutiveRestoreFailures: inheritedFailures,
                        ...(params.continuityCapsule ? { continuityCapsule: params.continuityCapsule } : {}),
                      });
                    } else if (params.continuityCapsule) {
                      await deps.sessionChainStore.update(newRec.id, {
                        continuityCapsule: params.continuityCapsule,
                      });
                    }
                  }
                }
              } else if (params.continuityCapsule) {
                await deps.sessionChainStore.update(existing.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            } else {
              // No active session (first invocation or previous was sealed)
              const newRec = await deps.sessionChainStore.create({
                cliSessionId: msg.sessionId,
                threadId,
                catId,
                userId,
              });
              if (params.continuityCapsule) {
                await deps.sessionChainStore.update(newRec.id, {
                  continuityCapsule: params.continuityCapsule,
                });
              }
            }
          } catch {
            // Best-effort — don't break the invocation chain
          }
        }

        // Push session info as system_info for frontend status panel
        // Include sessionSeq if SessionChainStore is available
        let sessionSeq: number | undefined;
        if (deps.sessionChainStore && sessionChainActive) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
            sessionSeq = activeRec != null ? activeRec.seq + 1 : undefined;
          } catch {
            /* best-effort */
          }
        }
        outputs.push({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'invocation_metrics',
            kind: 'session_started',
            sessionId: msg.sessionId,
            invocationId,
            ...(sessionSeq !== undefined ? { sessionSeq } : {}),
          }),
          timestamp: Date.now(),
        });
      }

      if (msg.type === 'done') {
        // === CAT_RESPONDED / CAT_ERROR 审计 (fire-and-forget) ===
        // P1 fix: when error was yielded during stream, emit CAT_ERROR instead of CAT_RESPONDED
        const durationMs = Date.now() - startTime;
        const auditType = hadStreamError ? AuditEventTypes.CAT_ERROR : AuditEventTypes.CAT_RESPONDED;
        auditLog
          .append({
            type: auditType,
            threadId,
            data: {
              catId,
              userId,
              invocationId,
              durationMs,
              ...(hadStreamError ? { error: lastErrorMessage ?? 'unknown stream error' } : {}),
              isFinal: isLastCat,
              metadata: msg.metadata,
            },
          })
          .catch((err) => {
            log.warn({ threadId, invocationId, err }, `${auditType} audit write failed`);
          });

        // Increment session messageCount (best-effort).
        // This counter is critical for unseal safety: empty sessions (0 messages)
        // can be displaced, but sessions with messages must not be silently sealed.
        if (deps.sessionChainStore && sessionChainActive) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
            if (activeRec) {
              const newCount = (activeRec.messageCount ?? 0) + 1;
              await deps.sessionChainStore.update(activeRec.id, {
                messageCount: newCount,
                updatedAt: Date.now(),
              });
              sessionRounds.record(newCount, { [AGENT_ID]: catId });
            }
          } catch {
            /* best-effort: messageCount miss won't break invocation */
          }
        }

        // Push completion metrics for frontend status panel
        outputs.push({
          type: 'system_info' as const,
          catId,
          content: JSON.stringify({
            type: 'invocation_metrics',
            kind: 'invocation_complete',
            invocationId,
            durationMs,
            sessionId: msg.metadata?.sessionId,
          }),
          timestamp: Date.now(),
        });

        // F070 Phase 3a: Capture execution digest for external project dispatch (best-effort)
        if (capturedMissionPack && workingDirectory && deps.executionDigestStore) {
          try {
            const { captureExecutionDigest } = await import(
              '../../../../../config/governance/execution-digest-capture.js'
            );
            const digestInput = captureExecutionDigest(
              capturedMissionPack,
              {
                summary: '', // Populated by HandoffDigestGenerator in future enhancement
                filesChanged: [],
                blocked: false,
                hadError: hadStreamError,
              },
              { projectPath: workingDirectory, threadId, catId: catId as string, userId },
            );
            deps.executionDigestStore.create(digestInput);
          } catch {
            /* best-effort: digest capture failure doesn't break invocation */
          }
        }

        const hasRuntimeContextUsage = Boolean(
          params.contextBudget?.historyMode ||
            params.contextBudget?.historyGovernanceDegraded !== undefined ||
            params.contextBudget?.deliveryOnlyMode ||
            budgetGateUsage,
        );
        if (hasRuntimeContextUsage && !msg.metadata) {
          msg.metadata = { provider: provider ?? 'unknown', model: 'unknown', usage: {} };
        } else if (hasRuntimeContextUsage && msg.metadata && !msg.metadata.usage) {
          msg.metadata.usage = {};
        }

        // F8: Push token usage and structured runtime diagnostics for frontend/ledger display.
        if (msg.metadata?.usage) {
          if (promptSourceBreakdown && !msg.metadata.usage.sourceBreakdown) {
            msg.metadata.usage = { ...msg.metadata.usage, sourceBreakdown: promptSourceBreakdown };
          }
          if (
            params.contextBudget &&
            (params.contextBudget.historyMode ||
              params.contextBudget.historyGovernanceDegraded !== undefined ||
              params.contextBudget.deliveryOnlyMode)
          ) {
            msg.metadata.usage = {
              ...msg.metadata.usage,
              ...(params.contextBudget.historyMode ? { historyMode: params.contextBudget.historyMode } : {}),
              ...(params.contextBudget.historyFullTokens != null
                ? { historyFullTokens: params.contextBudget.historyFullTokens }
                : {}),
              ...(params.contextBudget.historySummaryTokens != null
                ? { historySummaryTokens: params.contextBudget.historySummaryTokens }
                : {}),
              ...(params.contextBudget.historyBudgetRatio != null
                ? { historyBudgetRatio: params.contextBudget.historyBudgetRatio }
                : {}),
              ...(params.contextBudget.summarySegmentId
                ? { summarySegmentId: params.contextBudget.summarySegmentId }
                : {}),
              ...(params.contextBudget.historyGovernanceDegraded !== undefined
                ? { historyGovernanceDegraded: params.contextBudget.historyGovernanceDegraded }
                : {}),
              ...(params.contextBudget.deliveryOnlyMode
                ? { deliveryOnlyMode: params.contextBudget.deliveryOnlyMode }
                : {}),
              ...(params.contextBudget.deliveryOnlyDegradedIssue
                ? { deliveryOnlyDegradedIssue: params.contextBudget.deliveryOnlyDegradedIssue }
                : {}),
            };
          }
          if (budgetGateUsage) {
            msg.metadata.usage = {
              ...msg.metadata.usage,
              ...budgetGateUsage,
            };
          }
          // F152: Record OTel token usage + LLM call duration
          const modelBucket = normalizeModel(msg.metadata.model ?? '');
          const providerSystem = provider ?? 'unknown';
          const tokenAttrs = {
            [AGENT_ID]: catId,
            [GENAI_SYSTEM]: providerSystem,
            [GENAI_MODEL]: modelBucket,
            [OPERATION_NAME]: 'invoke',
          };
          if (msg.metadata.usage.inputTokens) {
            tokenUsage.add(msg.metadata.usage.inputTokens, { ...tokenAttrs, [STATUS]: 'input' });
          }
          if (msg.metadata.usage.outputTokens) {
            tokenUsage.add(msg.metadata.usage.outputTokens, { ...tokenAttrs, [STATUS]: 'output' });
          }
          if (msg.metadata.usage.durationApiMs) {
            llmCallDuration.record(msg.metadata.usage.durationApiMs / 1000, tokenAttrs);
          }

          // F153 Phase B: Retrospective LLM call span (created after-the-fact from done event)
          // Only create when durationApiMs is available — providers without timing data
          // (Codex, Gemini, Kimi) would produce misleading 0-duration spans.
          if (invocationSpan && msg.metadata.usage.durationApiMs) {
            recordLlmCallSpan(
              invocationSpan,
              catId,
              providerSystem,
              modelBucket,
              {
                durationApiMs: msg.metadata.usage.durationApiMs,
                inputTokens: msg.metadata.usage.inputTokens,
                outputTokens: msg.metadata.usage.outputTokens,
                cacheReadTokens: msg.metadata.usage.cacheReadTokens,
              },
              invocationId,
            );
          }

          outputs.push({
            type: 'system_info' as const,
            catId,
            content: JSON.stringify({
              type: 'invocation_usage',
              catId,
              usage: msg.metadata.usage,
            }),
            timestamp: Date.now(),
          });

          // F24: Compute and emit context health (only when session chain is enabled)
          if (sessionChainActive) {
            // Use lastTurnInputTokens (per-API-call) for accurate context fill,
            // then fallback to aggregated inputTokens, and finally totalTokens
            // for providers (Gemini CLI) that only expose a total count.
            const windowSize =
              msg.metadata.usage.contextWindowSize ?? getContextWindowFallback(msg.metadata.model ?? '');
            const usedFrom =
              msg.metadata.usage.lastTurnInputTokens != null
                ? 'last_turn'
                : msg.metadata.usage.inputTokens != null
                  ? 'input'
                  : msg.metadata.usage.totalTokens != null
                    ? 'total'
                    : null;
            const usedTokens =
              usedFrom === 'last_turn'
                ? msg.metadata.usage.lastTurnInputTokens!
                : usedFrom === 'input'
                  ? msg.metadata.usage.inputTokens!
                  : usedFrom === 'total'
                    ? msg.metadata.usage.totalTokens!
                    : 0;
            if (windowSize && usedTokens > 0) {
              const source: ContextHealth['source'] =
                msg.metadata.usage.contextWindowSize != null && usedFrom !== 'total' ? 'exact' : 'approx';
              const health: ContextHealth = {
                usedTokens,
                windowTokens: windowSize,
                fillRatio: Math.min(usedTokens / windowSize, 1.0),
                source,
                measuredAt: Date.now(),
              };
              // Update SessionRecord (best-effort): persist health + usage snapshot
              if (deps.sessionChainStore) {
                try {
                  const activeRecord = await deps.sessionChainStore.getActive(catId, threadId);
                  if (activeRecord) {
                    const u = msg.metadata?.usage!;
                    // 理智线 T3 (task #385): reuse the same usedTokens ContextHealth already
                    // computed above; classify against sanityLine (a different, usually much
                    // smaller, threshold than windowTokens — see SessionSanityMonitor.ts).
                    // Only emit a system_info event on tier crossings, not every same-tier turn.
                    const sanityLine =
                      catRegistry.tryGet(catId as string)?.config.sanityLine ?? getSanityLineFallback();
                    const sanityTransition = computeSanityTransition(
                      activeRecord.sanityState,
                      usedTokens,
                      sanityLine,
                      getSanityThresholdsFromEnv(),
                    );
                    if (sanityTransition.event) {
                      outputs.push({
                        type: 'system_info' as const,
                        catId,
                        content: JSON.stringify({
                          type: 'sanity_state_changed',
                          catId,
                          threadId,
                          sanityLine,
                          usedTokens,
                          ratio: sanityTransition.event.ratio,
                          from: sanityTransition.event.from,
                          to: sanityTransition.event.to,
                        }),
                        timestamp: Date.now(),
                      });
                    }
                    // 理智线 T4 (task #386): 只在跨档进入 yellow/red 时生成一次（红→绿的
                    // "恢复"事件不触发——不需要交接包）；跨档判定已经在 T3 做了幂等，这里
                    // 不重复加锁。
                    let sanityHandoff = activeRecord.sanityHandoff;
                    if (
                      sanityTransition.event &&
                      (sanityTransition.event.to === 'yellow' || sanityTransition.event.to === 'red')
                    ) {
                      const generated = await generateAndPersistSanityHandoff(deps, {
                        threadId,
                        catId: catId as CatId,
                        triggerState: sanityTransition.event.to,
                        userId,
                      });
                      if (generated) sanityHandoff = generated;
                    }
                    await deps.sessionChainStore.update(activeRecord.id, {
                      contextHealth: health,
                      sanityState: sanityTransition.state,
                      ...(sanityHandoff ? { sanityHandoff } : {}),
                      lastUsage: {
                        ...(u.inputTokens != null ? { inputTokens: u.inputTokens } : {}),
                        ...(u.outputTokens != null ? { outputTokens: u.outputTokens } : {}),
                        ...(u.cacheReadTokens != null ? { cacheReadTokens: u.cacheReadTokens } : {}),
                        ...(u.costUsd != null ? { costUsd: u.costUsd } : {}),
                      },
                      updatedAt: Date.now(),
                    });

                    // 理智线 T5 (task #387): remember the red trigger for the forced-seal
                    // check below. The actual requestSeal() call happens inside F33's own
                    // block (after skipAutoSealForApproxApiKey/skipAutoSealForApiKeyCompress
                    // are computed) — sanityLine's red decision is derived from the SAME
                    // usedTokens value as F33's fillRatio, so it inherits the same
                    // noisy-telemetry risk on api_key/approx gateways (F062-fix) and must
                    // respect the same skip guard, not a separate one.
                    //
                    // B1 (2026-07-23, found by independent review): this MUST key off
                    // `sanityTransition.state === 'red'` (this turn's classification), not
                    // `sanityTransition.event` (only fires on a fresh tier CROSSING). Once a
                    // session's persisted sanityState is already 'red', a still-red turn
                    // produces event:null (red→red, no crossing) — gating on the event alone
                    // means eligibility to even ATTEMPT a seal never re-arms after the first
                    // turn, so once the B1 cooldown window naturally expires there is nothing
                    // left to re-trigger a seal attempt: a session stuck red would go from
                    // "at most one forced seal per cooldown window" to "permanently exempt".
                    // The handoff-capsule generation above stays event-gated on purpose (must
                    // not regenerate every red turn) — only this eligibility signal changes.
                    if (sanityTransition.state === 'red') {
                      sanityRedTriggerSessionId = activeRecord.id;
                    }
                  }
                } catch {
                  /* best-effort */
                }
              }
              // F-BLOAT: Detect context compression for re-injection on next turn.
              // When usedTokens drops >60% from previous known value, the CLI
              // auto-compacted its context. Flag for systemPrompt re-injection.
              const cKey = `${userId}:${catId as string}:${threadId}`;
              const prevFill = _prevContextFill.get(cKey);
              _prevContextFill.set(cKey, usedTokens);
              if (prevFill && usedTokens < prevFill * 0.4) {
                _needsReinjection.add(cKey);
              }
              outputs.push({
                type: 'system_info' as const,
                catId,
                content: JSON.stringify({ type: 'context_health', catId, health }),
                timestamp: Date.now(),
              });

              // F33: Strategy-driven seal decision (replaces F24 Phase B shouldSeal)
              if (deps.sessionSealer && deps.sessionChainStore) {
                try {
                  // F062-fix:
                  // 1) api_key + approx health can be noisy on third-party gateways
                  // 2) api_key + compress strategy should not be force-sealed here
                  // Keep context_health observability in both cases.
                  const provider = catRegistry.tryGet(catId as string)?.config.clientId;
                  const profileMode = callbackEnv[ANTHROPIC_PROFILE_MODE_KEY];
                  const strategy = getSessionStrategy(catId as string);
                  const isAnthropicApiKey = provider === 'anthropic' && profileMode === ANTHROPIC_PROFILE_MODE_API_KEY;
                  const skipAutoSealForApproxApiKey = isAnthropicApiKey && health.source === 'approx';
                  const skipAutoSealForApiKeyCompress = isAnthropicApiKey && strategy.strategy === 'compress';
                  if (!skipAutoSealForApproxApiKey && !skipAutoSealForApiKeyCompress) {
                    const activeRecord = await deps.sessionChainStore.getActive(catId, threadId);

                    // 理智线 T5 (task #387): forced red-zone seal. Deliberately placed
                    // inside this same api_key/approx noise-guarded scope — sanityLine's
                    // red decision derives from the same (possibly noisy) usedTokens as
                    // F33's fillRatio, so it must respect the same F062-fix skip guard,
                    // not a separate one. If this seal fires, skipping the shouldTakeAction/
                    // switch below is an OPTIMIZATION (nothing left for F33 to do once the
                    // session is no longer 'active') — NOT the safety guarantee. The actual
                    // guarantee is requestSeal()'s own CAS idempotency: calling it again on
                    // an already-sealing/sealed record is a verified no-op (see the dedicated
                    // "N times on an already-sealed session" test).
                    let forcedSealAccepted = false;
                    if (
                      activeRecord &&
                      sanityRedTriggerSessionId === activeRecord.id &&
                      deps.sessionSealer &&
                      isSanitySealEnabled()
                    ) {
                      // B1 (2026-07-23): the (catId, threadId) combo was force-sealed recently —
                      // skip this seal to break the seal→new-session→turn-1-red→seal loop, and
                      // degrade to F33's own shouldTakeAction below (same path as kill-switch off).
                      const cooldownCheck = deps.sanitySealCooldownStore?.check(catId, threadId);
                      if (cooldownCheck?.cooling) {
                        outputs.push({
                          type: 'system_info' as const,
                          catId,
                          content: JSON.stringify({
                            type: 'sanity_seal_cooldown_skipped',
                            catId,
                            threadId,
                            sessionId: activeRecord.id,
                            remainingMs: cooldownCheck.remainingMs,
                          }),
                          timestamp: Date.now(),
                        });
                      } else {
                        // Forced memory writeback: unlike the normal end-of-invocation
                        // writeback (fire-and-forget, swallows errors via .catch()), this
                        // MUST be awaited before sealing so the handoff's assistant-side
                        // memory is durably persisted — and failure MUST be loud (not
                        // swallowed), since a silent failure here means the next shift
                        // loses this turn's memory. We still proceed to seal after logging
                        // a failure — this must not hang the handoff indefinitely.
                        if (!freshnessProtected && !forcedMemoryWritebackDone && assistantTextForMemory.trim()) {
                          try {
                            await autoUpdateAgentMemory({
                              catId,
                              invocationId,
                              threadId,
                              ...(params.currentUserMessageId
                                ? { currentUserMessageId: params.currentUserMessageId }
                                : {}),
                              assistantText: assistantTextForMemory,
                              completedAt: Date.now(),
                            });
                            forcedMemoryWritebackDone = true;
                          } catch (err) {
                            forcedMemoryWritebackDone = true;
                            log.error(
                              { catId, threadId, invocationId, sessionId: activeRecord.id, err },
                              'SANITY_CRITICAL forced memory writeback FAILED — next shift may lose this turn’s memory',
                            );
                            outputs.push({
                              type: 'system_info' as const,
                              catId,
                              content: JSON.stringify({
                                type: 'sanity_forced_writeback_failed',
                                catId,
                                threadId,
                                sessionId: activeRecord.id,
                                error: err instanceof Error ? err.message : String(err),
                              }),
                              timestamp: Date.now(),
                            });
                          }
                        }

                        const forcedSeal = await deps.sessionSealer.requestSeal({
                          sessionId: activeRecord.id,
                          reason: 'sanity_critical',
                        });
                        outputs.push({
                          type: 'system_info' as const,
                          catId,
                          content: JSON.stringify({
                            type: 'sanity_forced_seal',
                            catId,
                            threadId,
                            sessionId: activeRecord.id,
                            accepted: forcedSeal.accepted,
                          }),
                          timestamp: Date.now(),
                        });
                        if (forcedSeal.accepted) {
                          forcedSealAccepted = true;
                          sessionManager.delete(userId, catId, threadId).catch(() => {});
                          deps.sessionSealer.finalize({ sessionId: activeRecord.id }).catch(() => {});
                          deps.sanitySealCooldownStore?.recordSeal(catId, threadId, getSanitySealCooldownMsFromEnv());
                        }
                      }
                    }

                    if (!forcedSealAccepted) {
                      const action = shouldTakeAction(
                        health.fillRatio,
                        health.windowTokens,
                        health.usedTokens,
                        activeRecord?.compressionCount ?? 0,
                        strategy,
                      );

                      switch (action.type) {
                        case 'none':
                          break;
                        case 'warn':
                          // Warn is already emitted via context_health; add a one-shot handoff draft marker.
                          if (activeRecord && !_handoffDraftWindowSessions.has(activeRecord.id)) {
                            _handoffDraftWindowSessions.add(activeRecord.id);
                            outputs.push({
                              type: 'system_info' as const,
                              catId,
                              content: JSON.stringify({
                                type: 'handoff_draft_window',
                                catId,
                                sessionId: activeRecord.id,
                                threadId,
                                healthSnapshot: health,
                                trust: inferResumeTrustForSessionHandoff({
                                  reason: 'warn_threshold',
                                  session: activeRecord,
                                  hasVerifyEvidence: true,
                                }),
                              }),
                              timestamp: Date.now(),
                            });
                          }
                          break;
                        case 'seal':
                        case 'seal_after_compress': {
                          if (activeRecord) {
                            let handoffWrite: Awaited<ReturnType<typeof writeContextHandoffForPromptProjects>>;
                            try {
                              handoffWrite = await writeContextHandoffForPromptProjects({
                                threadId,
                                catId: catId as string,
                                fromSessionId: activeRecord.id,
                                reason: action.reason,
                                trust: inferResumeTrustForSessionHandoff({
                                  reason: action.reason,
                                  session: activeRecord,
                                  hasVerifyEvidence: true,
                                }),
                                health,
                                source: 'runtime-threshold',
                              });
                            } catch (err) {
                              outputs.push({
                                type: 'system_info' as const,
                                catId,
                                content: JSON.stringify({
                                  type: 'session_handoff_write_failed',
                                  catId,
                                  sessionId: activeRecord.id,
                                  threadId,
                                  reason: action.reason,
                                  error: err instanceof Error ? err.message : String(err),
                                }),
                                timestamp: Date.now(),
                              });
                              break;
                            }
                            const sealResult = await deps.sessionSealer.requestSeal({
                              sessionId: activeRecord.id,
                              reason: action.reason,
                            });
                            if (sealResult.accepted) {
                              sessionManager.delete(userId, catId, threadId).catch(() => {});
                              const sealTimestamp = Date.now();
                              const continuityCapsule = params.continuityCapsule
                                ? completeCapsuleForSeal(params.continuityCapsule, {
                                    invocationId,
                                    createdAt: sealTimestamp,
                                    seal: {
                                      sessionId: activeRecord.id,
                                      sessionSeq: activeRecord.seq + 1,
                                      reason: action.reason,
                                      healthSnapshot: health,
                                    },
                                  })
                                : undefined;
                              const sealInfoMessage = {
                                type: 'system_info' as const,
                                catId,
                                content: JSON.stringify({
                                  type: 'session_seal_requested',
                                  catId,
                                  sessionId: activeRecord.id,
                                  sessionSeq: activeRecord.seq + 1,
                                  reason: action.reason,
                                  healthSnapshot: health,
                                  handoffWrite,
                                  ...(continuityCapsule
                                    ? {
                                        continuityCapsule,
                                        continuityDiagnostics: {
                                          source: 'route_state',
                                          boundary: continuityCapsule.continuationReason,
                                          generated: true,
                                          persistedVia: 'session_seal_requested',
                                          threadId,
                                          catId,
                                          invocationId,
                                          sessionId: activeRecord.id,
                                        },
                                      }
                                    : {}),
                                }),
                                timestamp: sealTimestamp,
                              };
                              outputs.push(sealInfoMessage);
                              if (deps.transcriptWriter) {
                                const sessInfo: TranscriptSessionInfo = {
                                  sessionId: activeRecord.id,
                                  threadId,
                                  catId: activeRecord.catId,
                                  cliSessionId: activeRecord.cliSessionId,
                                  seq: activeRecord.seq,
                                };
                                deps.transcriptWriter.appendEvent(
                                  sessInfo,
                                  sealInfoMessage as unknown as Record<string, unknown>,
                                  invocationId,
                                );
                              }
                              deps.sessionSealer.finalize({ sessionId: activeRecord.id }).catch(() => {});
                            }
                          }
                          break;
                        }
                        case 'allow_compress':
                          // Don't seal — let CLI compress. Log for observability.
                          outputs.push({
                            type: 'system_info' as const,
                            catId,
                            content: JSON.stringify({
                              type: 'strategy_allow_compress',
                              catId,
                              strategy: strategy.strategy,
                              compressionCount: activeRecord?.compressionCount ?? 0,
                              healthSnapshot: health,
                            }),
                            timestamp: Date.now(),
                          });
                          break;
                      }
                    }
                  }
                } catch {
                  /* best-effort: strategy failure doesn't break invocation */
                }
              }
            }
          }
        }

        outputs.push({ ...msg, isFinal: isLastCat });
      } else {
        outputs.push(attachInvocationIdToTaskProgress(msg));

        // F153 Phase E: Record tool_use as child span (zero-duration; shows in trace tree with tool name + category)
        if (msg.type === 'tool_use' && msg.toolName && invocationSpan) {
          recordToolUseSpan(invocationSpan, catId, msg.toolName, msg.toolInput as Record<string, unknown>);
        }

        // F26: Detect task management tools and emit task_progress for frontend
        if (msg.type === 'tool_use' && msg.toolName) {
          const progress = extractTaskProgress(msg.toolName, msg.toolInput);
          if (progress) {
            outputs.push({
              type: 'system_info' as const,
              catId,
              content: JSON.stringify({ type: 'task_progress', catId, invocationId, ...progress }),
              timestamp: Date.now(),
            });
          }
        }
      }

      // F24 Phase C: Record event to transcript buffer (best-effort)
      if (!freshnessProtected && deps.transcriptWriter && deps.sessionChainStore && sessionChainActive) {
        try {
          const activeRec = await deps.sessionChainStore.getActive(catId, threadId);
          if (activeRec) {
            const sessInfo: TranscriptSessionInfo = {
              sessionId: activeRec.id,
              threadId,
              catId: activeRec.catId,
              cliSessionId: activeRec.cliSessionId,
              seq: activeRec.seq,
            };
            // Record the raw agent message as a transcript event
            deps.transcriptWriter.appendEvent(sessInfo, msg as unknown as Record<string, unknown>, invocationId);
          }
        } catch {
          /* best-effort */
        }
      }

      return outputs;
    };

    const streamProcessedOutputs = async function* (sourceMsg: AgentMessage | undefined): AsyncIterable<AgentMessage> {
      if (!sourceMsg) return;
      for (const out of await processMessage(sourceMsg)) {
        if (out.type === 'error') {
          hadError = true;
          terminalTaskProgressStatus = 'interrupted';
          terminalInterruptReason = 'error';
        }
        await maybePersistTaskProgress(out);
        if (out.type === 'done' && terminalTaskProgressStatus === null) {
          if (hadError) {
            terminalTaskProgressStatus = 'interrupted';
            terminalInterruptReason = 'error';
          } else if (signal?.aborted) {
            terminalTaskProgressStatus = 'interrupted';
            terminalInterruptReason = 'aborted';
          } else {
            terminalTaskProgressStatus = 'completed';
            terminalInterruptReason = null;
          }
        }
        if (out.type === 'done') {
          await finalizeTaskProgress();
          if (!out.tracing) {
            const sc = invocationSpan.spanContext();
            const parentSid = params.routeSpan?.spanContext().spanId;
            out.tracing = {
              traceId: sc.traceId,
              spanId: sc.spanId,
              ...(parentSid ? { parentSpanId: parentSid } : {}),
            };
          }
        }
        captureAssistantTextForMemory(out);
        yield out;
      }
    };

    // Self-heal policy (at most one retry total):
    // 1) stale --resume session: "No conversation found with session ID ..."
    // 2) poisoned --resume session: "prompt token count ... exceeds the limit ..."
    // 3) transient CLI bootstrap exit: "CLI 异常退出 (code: 1, signal: none)"
    const initialResumeSessionId = sessionId;
    const shouldTrackGeminiResumeFailures = catId === 'gemini' && Boolean(initialResumeSessionId);
    const resumeFailureCounts: Partial<Record<ResumeFailureKind, number>> = {};
    const maxAttempts = 2;

    // Universal debug log: capture everything needed to diagnose invocation issues.
    // This is provider-agnostic — every cat (Claude, Codex, Gemini, OpenCode, etc.)
    // passes through here before service.invoke() is called.
    {
      const maskEnv = (env: Record<string, string>): Record<string, string> => {
        const masked: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
          masked[k] = '***';
        }
        return masked;
      };
      log.debug(
        {
          invocationId,
          catId,
          threadId,
          userId,
          provider: provider ?? 'unknown',
          protocol: effectiveProtocol ?? 'default',
          model: defaultModel ?? 'default',
          accountId: resolvedAccount?.id ?? null,
          accountAuthType: resolvedAccount?.authType ?? null,
          sessionId: sessionId ?? null,
          isResume,
          injectSystemPrompt,
          forceReinjection,
          workingDirectory: workingDirectory ?? null,
          promptLength: effectivePrompt.length,
          systemPromptLength: params.systemPrompt?.length ?? 0,
          callbackEnv: maskEnv(callbackEnv),
          ...(accountEnv ? { accountEnv: maskEnv(accountEnv) } : {}),
        },
        '[invocation] service.invoke() — full context before subprocess launch',
      );
    }

    let allowSessionRetry = Boolean(sessionId);
    let allowTransientRetry = true;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      const options: AgentServiceOptions = {
        ...(sessionId ? { sessionId } : {}),
        ...baseOptions,
      };
      let suppressedMissingSessionError: AgentMessage | undefined;
      let suppressedPromptLimitError: AgentMessage | undefined;
      let suppressedContextOverflowError: AgentMessage | undefined;
      let suppressedTransientCliError: AgentMessage | undefined;
      let suppressedTimeoutError: AgentMessage | undefined;
      let shouldRetryWithoutSession = false;
      let shouldRetryOnTransientCliExit = false;
      let attemptHasContentOutput = false;
      // Substantive = real model output (text/tool), excludes system_info/session_init/error/done.
      // Used for timeout-retry: system_info (e.g. timeout_diagnostics) must NOT block retry.
      let attemptHasSubstantiveOutput = false;

      // F089: Use abortableNext instead of `for await` so the invocation timeout
      // can break out even when the service generator is stuck on an unresolvable await.
      const serviceIter = service.invoke(effectivePrompt, options)[Symbol.asyncIterator]();
      for (;;) {
        const iterResult = await abortableNext(serviceIter, signal);
        if (iterResult.done) break;
        const msg = iterResult.value;
        // F149: provider_signal / liveness_signal must NOT reset timeout — prevents "续命"
        if (msg.type !== 'provider_signal' && msg.type !== 'liveness_signal') resetInvocationTimeout();
        if (shouldTrackGeminiResumeFailures && options.sessionId && msg.type === 'error') {
          const failureKind = classifyResumeFailure(msg.error);
          if (failureKind) {
            resumeFailureCounts[failureKind] = (resumeFailureCounts[failureKind] ?? 0) + 1;
          }
        }

        if (allowSessionRetry && msg.type === 'error' && isMissingClaudeSessionError(msg.error)) {
          suppressedMissingSessionError = msg;
          continue;
        }
        if (
          allowSessionRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          isPromptTokenLimitExceededError(msg.error)
        ) {
          suppressedPromptLimitError = msg;
          continue;
        }
        if (
          allowSessionRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          isContextWindowOverflowError(msg.error)
        ) {
          suppressedContextOverflowError = msg;
          continue;
        }
        if (
          allowTransientRetry &&
          !attemptHasContentOutput &&
          msg.type === 'error' &&
          (isTransientCliExitCode1(msg.error) || isTransientAcpPromptFailure(msg.error))
        ) {
          suppressedTransientCliError = msg;
          continue;
        }
        // #774 self-heal: CLI timeout during session resume with no substantive output
        // → likely stale/unreachable session. Suppress and retry without session.
        // Uses attemptHasSubstantiveOutput (not attemptHasContentOutput) because
        // timeout_diagnostics (system_info) must NOT block the retry path.
        if (
          allowSessionRetry &&
          options.sessionId &&
          !attemptHasSubstantiveOutput &&
          msg.type === 'error' &&
          isCliTimeoutError(msg.error)
        ) {
          suppressedTimeoutError = msg;
          continue;
        }

        if (
          suppressedMissingSessionError ||
          suppressedPromptLimitError ||
          suppressedContextOverflowError ||
          suppressedTransientCliError ||
          suppressedTimeoutError
        ) {
          if (msg.type === 'done') {
            shouldRetryWithoutSession = Boolean(
              suppressedMissingSessionError ||
                suppressedPromptLimitError ||
                suppressedContextOverflowError ||
                suppressedTimeoutError,
            );
            shouldRetryOnTransientCliExit = Boolean(suppressedTransientCliError);
            break;
          }

          if (suppressedMissingSessionError) {
            for await (const out of streamProcessedOutputs(suppressedMissingSessionError)) {
              yield out;
            }
            suppressedMissingSessionError = undefined;
          }
          if (suppressedPromptLimitError) {
            for await (const out of streamProcessedOutputs(suppressedPromptLimitError)) {
              yield out;
            }
            suppressedPromptLimitError = undefined;
          }
          if (suppressedContextOverflowError) {
            for await (const out of streamProcessedOutputs(suppressedContextOverflowError)) {
              yield out;
            }
            suppressedContextOverflowError = undefined;
          }
          if (suppressedTransientCliError) {
            for await (const out of streamProcessedOutputs(suppressedTransientCliError)) {
              yield out;
            }
            suppressedTransientCliError = undefined;
          }
          if (suppressedTimeoutError) {
            for await (const out of streamProcessedOutputs(suppressedTimeoutError)) {
              yield out;
            }
            suppressedTimeoutError = undefined;
          }
        }

        // F149: Map provider_signal / liveness_signal → system_info for frontend delivery
        const deliveryMsg =
          msg.type === 'provider_signal' || msg.type === 'liveness_signal'
            ? { ...msg, type: 'system_info' as const }
            : msg;
        for await (const out of streamProcessedOutputs(deliveryMsg)) {
          yield out;
        }
        if (
          msg.type !== 'error' &&
          msg.type !== 'done' &&
          msg.type !== 'session_init' &&
          msg.type !== 'provider_signal' &&
          msg.type !== 'liveness_signal'
        ) {
          attemptHasContentOutput = true;
          // Substantive = real model output, excludes system_info (e.g. timeout_diagnostics).
          if (msg.type !== 'system_info') {
            attemptHasSubstantiveOutput = true;
          }
          // F118 AC-C6: Reset consecutive restore failure counter on successful content
          if (deps.sessionChainStore && !didResetRestoreFailures) {
            didResetRestoreFailures = true; // only reset once per invocation
            try {
              const activeRec = await deps.sessionChainStore.getActive(catId as CatId, threadId);
              if (activeRec && (activeRec.consecutiveRestoreFailures ?? 0) > 0) {
                await deps.sessionChainStore.update(activeRec.id, {
                  consecutiveRestoreFailures: 0,
                  updatedAt: Date.now(),
                });
              }
            } catch {
              /* best-effort reset */
            }
          }
        }
      }

      if (shouldRetryWithoutSession && attempt + 1 < maxAttempts) {
        const retryReason = suppressedPromptLimitError
          ? 'prompt_token_limit'
          : suppressedContextOverflowError
            ? 'context_window_overflow'
            : suppressedTimeoutError
              ? 'cli_timeout'
              : 'missing_session';
        log.info(
          {
            catId,
            threadId,
            invocationId,
            reason: retryReason,
            retryReason,
            attempt: attempt + 1,
            retryAttempt: attempt + 2,
            elapsedMs: Date.now() - attemptStartedAt,
            hadSessionId: Boolean(options.sessionId),
          },
          'cat retrying invoke (session self-heal)',
        );
        try {
          await sessionManager.delete(userId, catId, threadId);
        } catch {
          // Redis delete failure — best-effort only
        }
        // F118 AC-C6: Increment consecutive restore failure counter
        if (deps.sessionChainStore) {
          try {
            const activeRec = await deps.sessionChainStore.getActive(catId as CatId, threadId);
            if (activeRec) {
              await deps.sessionChainStore.update(activeRec.id, {
                consecutiveRestoreFailures: (activeRec.consecutiveRestoreFailures ?? 0) + 1,
                updatedAt: Date.now(),
              });
            }
          } catch {
            /* best-effort counter update */
          }
        }
        sessionId = undefined;
        // F118 P2-fix: Clear stale cliSessionId so retry diagnostics don't mis-attribute
        delete baseOptions.cliSessionId;
        // F-BLOAT P1: self-heal drops session → retry is now a fresh session.
        // Must re-inject systemPrompt since baseOptions may have omitted it
        // when the original attempt was a resume (injectSystemPrompt=false).
        if (params.systemPrompt && !baseOptions.systemPrompt) {
          baseOptions.systemPrompt = params.systemPrompt;
        }
        allowSessionRetry = false;
        continue;
      }
      if (shouldRetryOnTransientCliExit && attempt + 1 < maxAttempts) {
        log.info(
          {
            catId,
            threadId,
            invocationId,
            reason: 'transient_cli_exit',
            retryReason: 'transient_cli_exit',
            attempt: attempt + 1,
            retryAttempt: attempt + 2,
            elapsedMs: Date.now() - attemptStartedAt,
            hadSessionId: Boolean(options.sessionId),
          },
          'cat retrying invoke (transient CLI exit)',
        );
        allowTransientRetry = false;
        continue;
      }

      if (suppressedMissingSessionError) {
        for await (const out of streamProcessedOutputs(suppressedMissingSessionError)) {
          yield out;
        }
      }
      if (suppressedPromptLimitError) {
        for await (const out of streamProcessedOutputs(suppressedPromptLimitError)) {
          yield out;
        }
      }
      if (suppressedContextOverflowError) {
        for await (const out of streamProcessedOutputs(suppressedContextOverflowError)) {
          yield out;
        }
      }
      if (suppressedTransientCliError) {
        for await (const out of streamProcessedOutputs(suppressedTransientCliError)) {
          yield out;
        }
      }
      break;
    }

    if (shouldTrackGeminiResumeFailures && Object.keys(resumeFailureCounts).length > 0) {
      const total = Object.values(resumeFailureCounts).reduce((sum, count) => sum + (count ?? 0), 0);
      for (const out of await processMessage({
        type: 'system_info' as const,
        catId,
        content: JSON.stringify({
          type: 'resume_failure_stats',
          catId,
          invocationId,
          sessionId: initialResumeSessionId,
          counts: resumeFailureCounts,
          total,
        }),
        timestamp: Date.now(),
      })) {
        await maybePersistTaskProgress(out);
        yield out;
      }
    }
    didComplete = true; // F118 AC-C5: Normal completion reached
  } catch (err) {
    // F152: Record error on invocation span + OTel log
    invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    emitOtelLog('ERROR', 'invocation_error', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);

    // === CAT_ERROR 审计 (fire-and-forget, 缅因猫 review P2-3) ===
    const durationMs = Date.now() - startTime;
    auditLog
      .append({
        type: AuditEventTypes.CAT_ERROR,
        threadId,
        data: {
          catId,
          userId,
          invocationId,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .catch((auditErr) => {
        log.warn({ threadId, invocationId, err: auditErr }, 'CAT_ERROR audit write failed');
      });

    hadError = true;
    didWriteAudit = true; // F118 AC-C5: Catch block wrote audit, don't double-write in finally
    yield {
      type: 'error' as const,
      catId,
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    };
    await finalizeTaskProgress();
    const sc = invocationSpan.spanContext();
    const parentSid = params.routeSpan?.spanContext().spanId;
    yield {
      type: 'done' as const,
      catId,
      isFinal: isLastCat,
      timestamp: Date.now(),
      tracing: { traceId: sc.traceId, spanId: sc.spanId, ...(parentSid ? { parentSpanId: parentSid } : {}) },
    };
  } finally {
    // F089: Clear invocation hard timeout
    if (invocationTimer) clearTimeout(invocationTimer);

    // F118: Release session mutex (idempotent — safe if never acquired)
    sessionMutexRelease?.();

    if (openCodeRuntimeConfigPath) {
      const openCodeRuntimeConfigDir = dirname(openCodeRuntimeConfigPath);
      await rm(openCodeRuntimeConfigDir, { recursive: true, force: true }).catch((err) => {
        log.warn({ invocationId, path: openCodeRuntimeConfigDir, err }, 'Failed to remove OpenCode runtime config dir');
      });
    }

    // F118 AC-C5: Fallback audit for generator .return() path (#99)
    // If generator was force-returned (e.g. AbortController, client disconnect)
    // and the catch block didn't fire, write a fallback CAT_ERROR audit entry.
    if (!didWriteAudit && !hadError && !didComplete) {
      const durationMs = Date.now() - startTime;
      auditLog
        .append({
          type: AuditEventTypes.CAT_ERROR,
          threadId,
          data: {
            catId,
            userId,
            invocationId,
            durationMs,
            error: 'generator_returned_without_completion',
          },
        })
        .catch((auditErr) => {
          log.warn({ threadId, invocationId, err: auditErr }, 'Finally fallback CAT_ERROR audit write failed');
        });
    }

    await finalizeTaskProgress();

    // F152: Record invocation duration and decrement active count
    const finalDurationMs = Date.now() - startTime;
    const wasAbortedWithoutError = !didWriteAudit && !hadError && !didComplete;
    const otelStatus = hadError || wasAbortedWithoutError ? 'error' : 'ok';
    const otelAttrs = { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke', [STATUS]: otelStatus };
    invocationDuration.record(finalDurationMs / 1000, otelAttrs);
    activeInvocations.add(-1, { [AGENT_ID]: catId, [OPERATION_NAME]: 'invoke' });

    // F153: Product-level instruments
    invocationCompleted.add(1, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    catResponseDuration.record(finalDurationMs / 1000, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    if (threadCreatedAt) {
      threadDuration.record((Date.now() - threadCreatedAt) / 1000, { [AGENT_ID]: catId, [STATUS]: otelStatus });
    }

    if (
      !freshnessProtected &&
      !forcedMemoryWritebackDone &&
      !params.deferMemoryWriteback &&
      otelStatus === 'ok' &&
      assistantTextForMemory.trim()
    ) {
      autoUpdateAgentMemory({
        catId,
        invocationId,
        threadId,
        ...(params.currentUserMessageId ? { currentUserMessageId: params.currentUserMessageId } : {}),
        assistantText: assistantTextForMemory,
        completedAt: Date.now(),
      }).catch((err) => {
        log.warn({ catId, threadId, invocationId, err }, 'memory auto-update failed (non-blocking)');
      });
    }

    // F-G (PRD-memory-upgrade 批次 3): rotation happened for this invocation's
    // would-be --resume session. autoUpdateAgentMemory needs invocation-complete
    // state (a non-empty assistantText) to write anything, but the rotation
    // decision fires before the CLI subprocess even starts — there's no "this
    // turn's" content yet at that point. Per docs/research/memory-absorption.md
    // §3 item 2 ("若该机制需要 invocation 完成态才跑，就改为轮转事件后补一次蒸馏
    // 调用"), the distillation call is placed here instead — after completion —
    // using a distinct invocationId suffix so it can never collide with / overwrite
    // the real turn's own "最近验证" line above (updateRecentValidationBody in
    // AgentMemoryAutoWriter.ts dedupes by exact invocationId substring match).
    // `force: true` only bypasses the 60s rate limit (MEMORY_AUTO_WRITE_MIN_INTERVAL_MS)
    // — the write still goes through the same promotion gate as any other memory
    // write (off/shadow/enforce), never a bypass of that review discipline.
    // Skipped when deferMemoryWriteback is set: that flag means the route layer
    // owns memory-writeback timing for this invocation, and firing a second writer
    // here would race its architecture rather than support it.
    if (rotationEvent?.rotated && !params.deferMemoryWriteback) {
      const sizeMb = rotationEvent.sizeBytes != null ? (rotationEvent.sizeBytes / (1024 * 1024)).toFixed(1) : '?';
      const rotationSummary =
        assistantTextForMemory.trim() ||
        `CLI 原生 session 因超限已轮转：旧 session ${rotationEvent.sessionId ?? '?'}（约 ${sizeMb} MB）已归档为 ${rotationEvent.archivedPath ?? '?'}，本轮新开会话。`;
      autoUpdateAgentMemory(
        {
          catId,
          invocationId: `${invocationId}:cli-session-rotation`,
          threadId,
          assistantText: rotationSummary,
          completedAt: Date.now(),
        },
        { force: true },
      ).catch((err) => {
        log.warn({ catId, threadId, invocationId, err }, 'CLI session rotation distillation write failed (non-blocking)');
      });
    }

    // F089: Mark agent pane status when invocation completes
    if (deps.agentPaneRegistry?.getByInvocation(invocationId)) {
      if (hadError || wasAbortedWithoutError) {
        deps.agentPaneRegistry.markCrashed(invocationId, null);
      } else {
        deps.agentPaneRegistry.markDone(invocationId, 0);
      }
    }

    // F152: End invocation span + emit completion/error log through OTel
    // Three paths: (1) catch already handled, (2) yielded-error, (3) abort, (4) ok
    if (hadError && !didWriteAudit) {
      // Yielded-error path — catch didn't fire, so emit error here
      invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'invocation completed with error' });
      emitOtelLog('ERROR', 'invocation_error', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);
    } else if (wasAbortedWithoutError) {
      // Abort path — generator .return()'d without completion, consistent with audit CAT_ERROR
      invocationSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'generator_returned_without_completion' });
      emitOtelLog('ERROR', 'invocation_aborted', { [AGENT_ID]: catId, [STATUS]: 'error' }, invocationSpan);
    } else if (didComplete) {
      invocationSpan.setStatus({ code: SpanStatusCode.OK });
      emitOtelLog('INFO', 'invocation_completed', { [AGENT_ID]: catId, [STATUS]: 'ok' }, invocationSpan);
    }
    invocationSpan.end();
  }
}
