/**
 * Messages API Routes
 * POST /api/messages - 发送消息 (JSON or multipart with images)
 * GET /api/messages - 获取历史消息
 *
 * IMPORTANT: threadId 约束
 * 生产代码应显式包含 threadId（sendMessageSchema 字段 threadId）。
 * 兼容行为：未传 threadId 时会降级到 'default' thread（历史行为）。
 * 跨线程鉴权、InvocationTracker、消息存储都依赖正确的 threadId。
 * 前端应先确保 thread 存在（POST /api/threads）再发消息。
 *
 * ADR-008 S1: 消息写入与猫调用执行解耦。
 * POST 流程: 原子创建 InvocationRecord → 写入用户消息 → 回填 → reply 202 → background 执行
 */

import { randomUUID } from 'node:crypto';
import {
  type CatId,
  catRegistry,
  type MessageContent,
  parseThreadAddressToken,
  THREAD_ADDRESS_ROOT_ID_RE,
} from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDefaultCatId } from '../config/cat-config-loader.js';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import {
  buildA2AIdempotencyKey,
  PENDING_MENTION_TTL_MS,
} from '../domains/cats/services/agents/invocation/a2a-idempotency.js';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromAgentMessage,
} from '../domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import { isParallelDispatchEnabled } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type {
  ConsumedContinuationToken,
  SessionContinuationCoordinator,
} from '../domains/cats/services/agents/invocation/SessionContinuationCoordinator.js';
import {
  type PersistenceContext,
  persistA2APendingNotice,
} from '../domains/cats/services/agents/routing/route-helpers.js';
import { resetStreak } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import {
  accumulateTextParts,
  flattenTextParts,
  flattenTurnTextParts,
} from '../domains/cats/services/agents/text-aggregation.js';
import { createGameDriver } from '../domains/cats/services/game/createGameDriver.js';
import type { GameDriver } from '../domains/cats/services/game/GameDriver.js';
import { GameOrchestrator } from '../domains/cats/services/game/GameOrchestrator.js';
import { WerewolfLobby } from '../domains/cats/services/game/werewolf/WerewolfLobby.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import { getPushNotificationService } from '../domains/cats/services/push/PushNotificationService.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../domains/cats/services/stores/ports/DraftStore.js';
import type { IGameStore } from '../domains/cats/services/stores/ports/GameStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  type IMessageStore,
  isDelivered,
  type StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISummaryStore } from '../domains/cats/services/stores/ports/SummaryStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { isThreadFirstRoutingEnabled, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isSystemUserMessage } from '../domains/cats/services/stores/visibility.js';
import type { AgentMessage } from '../domains/cats/services/types.js';
import { mergeTokenUsage, type TokenUsage } from '../domains/cats/services/types.js';
import { buildThreadDeepLink } from '../infrastructure/connectors/connector-command-helpers.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { buildCancelMessages, type SocketManager } from '../infrastructure/websocket/index.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

/** F088 ISSUE-15: Minimal outbound delivery interface — avoids importing full OutboundDeliveryHook. */
interface OutboundDeliveryHookLike {
  deliver(
    threadId: string,
    content: string,
    catId?: string,
    richBlocks?: unknown[],
    threadMeta?: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string },
    origin?: string,
    triggerMessageId?: string,
  ): Promise<void>;
}

/** F088 ISSUE-15: Minimal streaming hook interface. */
interface StreamingHookLike {
  onStreamStart(
    threadId: string,
    catId?: string,
    invocationId?: string,
    senderHint?: { id: string; name?: string },
  ): Promise<void>;
  onStreamChunk(threadId: string, accumulatedText: string, invocationId?: string): Promise<void>;
  onStreamEnd(threadId: string, finalText: string, invocationId?: string): Promise<void>;
  onStreamHold?(threadId: string, invocationId?: string): Promise<void>;
  cleanupPlaceholders?(threadId: string, invocationId?: string): Promise<void>;
  /** F151: Signal adapters that an invocation's delivery batch is complete. */
  notifyDeliveryBatchDone?(threadId: string, chainDone: boolean): Promise<void>;
}

interface CatSupervisorLike {
  markProcessing(catIds: string | readonly string[]): Promise<void> | void;
  markIdle(catIds: string | readonly string[]): Promise<void> | void;
}

import { normalizeErrorMessage } from '../utils/normalize-error.js';
import { resolveUserId } from '../utils/request-identity.js';
import { buildGameSeats, parseGameCommand, sanitizeCatIds } from './game-command-interceptor.js';
import type { HoldBallCancelDeps } from './hold-ball-cancel.js';
import { cancelPendingHoldsForThread } from './hold-ball-cancel.js';
import { sendMessageSchema } from './messages.schema.js';
import { parseMultipart } from './parse-multipart.js';
import { ensureMessageAnchoredThread } from './task-discussion-thread.js';
import { isThreadAddressRoutingEnabled, resolveThreadAddress } from './thread-address.js';
import { deriveThreadReplySummary, type ThreadReplySummary } from './thread-reply-summary.js';
import { classifyWorkAdmission, forceCreateFromMessage } from './work-admission.js';
import { admitWorkMessage, type ExecutionRouteV1, isAutoTaskThreadRoutingEnabled } from './work-admission-service.js';

const STREAM_START_TIMEOUT_MS = 5_000;
const DEFAULT_ORPHAN_DRAFT_CLEANUP_GRACE_MS = 30_000;
const ORPHAN_DRAFT_CLEANUP_GRACE_MS = Math.max(
  0,
  Number(process.env.CAT_CAFE_ORPHAN_DRAFT_CLEANUP_GRACE_MS) || DEFAULT_ORPHAN_DRAFT_CLEANUP_GRACE_MS,
);

const DEFAULT_MESSAGE_BATCH_WINDOW_MS = 10_000;

export function resolveMessageBatchWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.CAT_CAFE_MESSAGE_BATCH_WINDOW_MS);
  if (!Number.isFinite(configured)) return DEFAULT_MESSAGE_BATCH_WINDOW_MS;
  return Math.min(10_000, Math.max(5_000, Math.trunc(configured)));
}

export function isMessageBatchCanaryThread(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CAT_CAFE_MESSAGE_BATCHING_THREADS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(threadId);
}

/**
 * Dependencies injected via Fastify plugin options.
 * socketManager is injected to avoid circular import from index.ts.
 */
export interface MessagesRoutesOptions {
  registry: InvocationRegistry;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router: AgentRouter;
  sessionStore?: SessionStore;
  deliveryCursorStore?: DeliveryCursorStore;
  threadStore?: IThreadStore;
  /** F194: durable work admission and task-thread routing. */
  taskStore?: ITaskStore;
  uploadDir?: string;
  invocationTracker?: InvocationTracker;
  invocationRecordStore?: IInvocationRecordStore;

  summaryStore?: ISummaryStore;
  /** #80: Streaming draft store for F5 recovery */
  draftStore?: IDraftStore;
  /** F39: Message queue for delivery-mode routing */
  invocationQueue?: InvocationQueue;
  /** F39: Queue processor for auto-dequeue on invocation complete */
  queueProcessor?: QueueProcessor;
  /** F101: Game store for /game command interception */
  gameStore?: IGameStore;
  /** F101: Injectable auto-player for lifecycle-safe teardown in tests/routes */
  autoPlayer?: Pick<GameDriver, 'startLoop' | 'stopLoop' | 'stopAllLoops'>;
  /** F088 ISSUE-15: Outbound delivery hook for connector platforms (late-bound after gateway bootstrap) */
  outboundHook?: OutboundDeliveryHookLike;
  /** F088 ISSUE-15: Streaming hook for connector platforms (late-bound after gateway bootstrap) */
  streamingHook?: StreamingHookLike;
  /** F167 Phase J: deps for auto-cancelling pending hold-ball tasks on user message */
  holdBallCancelDeps?: HoldBallCancelDeps;
  /** Task #112: lightweight always-online status supervisor. */
  catSupervisor?: CatSupervisorLike;
  /** F224: passive session continuation lifecycle for immediate invocations. */
  sessionContinuationCoordinator?: Pick<
    SessionContinuationCoordinator,
    'prepareInvocationContext' | 'commitInvocationOutcome'
  >;
}

const log = createModuleLogger('routes/messages');

function withExecutionCrossPostAudit(
  message: AgentMessage,
  executionRoute: ExecutionRouteV1 | undefined,
  invocationId: string,
): AgentMessage {
  if (executionRoute?.mode !== 'explicit_cross_thread') return message;
  return {
    ...message,
    extra: {
      ...(message.extra ?? {}),
      crossPost: {
        sourceThreadId: executionRoute.sourceThreadId,
        sourceInvocationId: invocationId,
      },
    },
  };
}

function tryAutoCancelPendingHolds(threadId: string, deps: HoldBallCancelDeps | undefined): void {
  if (!deps) return;
  try {
    const cancelled = cancelPendingHoldsForThread(threadId, deps);
    if (cancelled.length > 0) {
      log.info(
        { threadId, cancelledCount: cancelled.length, taskIds: cancelled.map((t) => t.id) },
        'F167 Phase J: auto-cancelled pending hold-ball tasks on user message',
      );
    }
  } catch (err) {
    log.warn({ threadId, err }, 'F167 Phase J: failed to auto-cancel pending holds');
  }
}

async function resolveOutboundThreadMeta(
  threadId: string,
  opts: Pick<MessagesRoutesOptions, 'threadStore'>,
): Promise<{ threadShortId: string; threadTitle?: string; deepLinkUrl?: string } | undefined> {
  try {
    const LOOKUP_TIMEOUT_MS = 2000;
    const thread = opts.threadStore?.get(threadId);
    if (!thread) return undefined;

    const lookupPromise = Promise.resolve(thread).catch(() => undefined);
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS));
    const resolved = await Promise.race([lookupPromise, timeout]);
    if (!resolved) return undefined;

    const frontendBase = resolveFrontendBaseUrl(process.env);
    return {
      threadShortId: threadId.slice(0, 15),
      threadTitle: resolved.title ?? undefined,
      deepLinkUrl: buildThreadDeepLink(frontendBase, threadId),
    };
  } catch {
    log.warn({ threadId }, '[messages] threadMeta lookup failed');
    return undefined;
  }
}

/**
 * Sync a human Web message in a connector-bound thread back to the external chat.
 * For normal Clowder threads OutboundDeliveryHook sees no binding and no-ops.
 */
export async function deliverWebUserMessageToConnector(
  threadId: string,
  content: string,
  messageId: string,
  opts: Pick<MessagesRoutesOptions, 'outboundHook' | 'threadStore'>,
  logger: typeof log,
  options?: { visibility?: 'whisper' | undefined },
): Promise<void> {
  if (!opts.outboundHook || !content.trim()) return;
  if (options?.visibility === 'whisper') return;

  const threadMeta = await resolveOutboundThreadMeta(threadId, opts);
  try {
    await opts.outboundHook.deliver(threadId, content, undefined, undefined, threadMeta, undefined, messageId);
  } catch (err) {
    logger.error({ err, threadId, messageId }, '[messages] Web user outbound delivery failed');
  }
}

async function persistA2ARoutingMessage(
  messageStore: IMessageStore,
  msg: { content?: string; timestamp: number },
  threadId: string,
): Promise<string | undefined> {
  if (!msg.content) return undefined;
  try {
    const stored = await messageStore.append({
      userId: 'system',
      catId: null,
      content: msg.content,
      mentions: [],
      timestamp: msg.timestamp,
      threadId,
      extra: { systemKind: 'a2a_routing' },
    });
    return stored.id;
  } catch (err) {
    log.warn({ err, threadId }, 'Failed to persist a2a_handoff');
    return undefined;
  }
}

const getMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(50),
  /** Cursor: "timestamp:id" or legacy plain timestamp */
  before: z.string().optional(),
  /** Center the first page around a search result. */
  around: z.string().min(1).max(100).optional(),
  threadId: z.string().min(1).max(100).optional(),
});

const searchMessagesSchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const MAX_FILE_SIZE = 25 * 1024 * 1024; // multipart transport cap; image-specific validation remains 10MB
const MAX_FILES = 5;

const DECISION_NOTIFICATION_RE = /\b(review|lgtm|merge|pr)\b/i;

function isMessageVisibleToUser(message: StoredMessage, userId: string): boolean {
  if (message.deletedAt) return false;
  if (message.userId === userId || isSystemUserMessage(message)) return true;
  // Agent / connector messages are visible in shared Clowder threads even when
  // the persisted userId is not the active browser session.
  return Boolean(message.catId || message.source);
}

async function resolveThreadTitle(
  threadStore: IThreadStore | undefined,
  threadId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(threadId);
  if (cached) return cached;

  const thread = await Promise.resolve(threadStore?.get(threadId)).catch(() => null);
  const title = thread?.title || (threadId === 'default' ? '大厅' : '未命名对话');
  cache.set(threadId, title);
  return title;
}

export function shouldMarkDecisionNotification(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    DECISION_NOTIFICATION_RE.test(content) ||
    content.includes('合入') ||
    content.includes('审批') ||
    content.includes('批准') ||
    content.includes('决策') ||
    content.includes('请确认') ||
    content.includes('是否允许') ||
    lower.includes('can merge')
  );
}

export const messagesRoutes: FastifyPluginAsync<MessagesRoutesOptions> = async (app, opts) => {
  const uploadDir = getDefaultUploadDir(opts.uploadDir ?? process.env.UPLOAD_DIR);

  // Register multipart parser for image uploads
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  });

  // Shared AgentRouter injected via opts (created in index.ts)
  const router = opts.router;
  const gameOrchestrator = opts.gameStore
    ? new GameOrchestrator({
        gameStore: opts.gameStore,
        socketManager: opts.socketManager,
        messageStore: opts.messageStore,
      })
    : null;
  const gameAutoPlayer = gameOrchestrator
    ? (opts.autoPlayer ??
      createGameDriver({
        gameNarratorEnabled: false,
        legacyDeps: {
          gameStore: opts.gameStore!,
          orchestrator: gameOrchestrator,
          messageStore: opts.messageStore,
        },
      }))
    : null;

  if (gameAutoPlayer) {
    app.addHook('onClose', async () => {
      gameAutoPlayer.stopAllLoops();
    });
  }

  // POST /api/messages - 发送消息（WebSocket 广播）
  app.post('/api/messages', async (request, reply) => {
    let content: string;
    let legacyUserId: string | undefined;
    let threadId: string | undefined;
    let replyTo: string | undefined;
    let contentBlocks: MessageContent[] | undefined;
    let idempotencyKey: string | undefined;
    // F35: Whisper fields
    let whisperVisibility: 'whisper' | undefined;
    let whisperRecipients: readonly CatId[] | undefined;

    // F39: Delivery mode
    let deliveryMode: 'immediate' | 'queue' | 'force' | undefined;

    // F194 §3 step 3: "As Task" explicit declaration (Raft's per-message checkbox).
    let asTask = false;

    if (request.isMultipart()) {
      // Parse multipart: text fields + image files
      const parsed = await parseMultipart(request, uploadDir);
      if ('error' in parsed) {
        reply.status(400);
        return { error: parsed.error };
      }
      ({ content, userId: legacyUserId, threadId, replyTo, contentBlocks } = parsed);
      if ('idempotencyKey' in parsed && parsed.idempotencyKey) {
        idempotencyKey = parsed.idempotencyKey;
      }
      // F35: Extract whisper fields from multipart
      if (parsed.visibility === 'whisper' && parsed.whisperTo) {
        whisperVisibility = 'whisper';
        whisperRecipients = parsed.whisperTo as CatId[];
      }
      // F39: Extract deliveryMode from multipart
      if (parsed.deliveryMode) {
        deliveryMode = parsed.deliveryMode;
      }
      if (parsed.asTask) {
        asTask = true;
      }
    } else {
      // JSON mode (backwards compatible)
      const parseResult = sendMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parseResult.error.issues };
      }
      ({ content, userId: legacyUserId, threadId, replyTo, idempotencyKey } = parseResult.data);
      deliveryMode = parseResult.data.deliveryMode;
      asTask = parseResult.data.asTask === true;
      // F35: Extract whisper fields from parsed body
      if (parseResult.data.visibility === 'whisper') {
        whisperVisibility = 'whisper';
        whisperRecipients = parseResult.data.whisperTo as CatId[] | undefined;
      }
    }

    const userId = resolveUserId(request, {
      fallbackUserId: legacyUserId,
      defaultUserId: 'default-user',
    });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    // Default to 'default' thread for lobby (prevents global broadcast)
    const resolvedThreadId = threadId ?? 'default';

    // F167 L1 AC-A3: user message is a fresh turn — clear any in-flight ping-pong
    // streak on this thread's active worklist (no-op if none).
    resetStreak(resolvedThreadId);

    // Ensure thread exists and auto-title on first message
    if (resolvedThreadId !== 'default' && opts.threadStore) {
      const thread = await opts.threadStore.get(resolvedThreadId);

      if (!thread || thread.deletedAt) {
        // Thread doesn't exist or soft-deleted — reject to prevent orphaned messages (#21 + Phase D)
        reply.status(400);
        return {
          error: '对话不存在',
          detail: '请先创建对话后再发送消息。如果对话已被删除，请新建一个。',
          code: 'THREAD_NOT_FOUND',
        };
      } else if (thread.title === null) {
        // Auto-title existing untitled thread
        const autoTitle = content.length > 30 ? `${content.slice(0, 30)}...` : content;
        await opts.threadStore.updateTitle(resolvedThreadId, autoTitle);
        opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'thread_updated', {
          threadId: resolvedThreadId,
          title: autoTitle,
        });
      }
    }

    // Delete guard check (read-only, no side effects — safe before idempotency check)
    if (opts.invocationTracker?.isDeleting(resolvedThreadId)) {
      reply.status(409);
      return {
        error: '对话正在删除中',
        detail: '请稍后重试，或新建一个对话继续',
        code: 'THREAD_DELETING',
      };
    }

    // F101: /game command interception — start game directly, skip AI routing
    const parsedGame = parseGameCommand(content);
    if (parsedGame && opts.gameStore && opts.threadStore) {
      if (!gameOrchestrator || !gameAutoPlayer) {
        throw new Error('game auto-player is unavailable');
      }

      const DEFAULT_PLAYER_COUNT = 7;
      const allCatIds = catRegistry.getAllIds();
      const sanitized = parsedGame.catIds ? sanitizeCatIds(parsedGame.catIds, allCatIds) : [];
      // Fallback to all cats if sanitize filtered everything out (or no catIds provided)
      const catIds = sanitized.length > 0 ? sanitized : [...allCatIds];
      if (catIds.length === 0) {
        reply.status(400);
        return { error: '没有可用的猫猫成员，请先在设置中添加一只猫猫', code: 'NO_TARGETS' };
      }
      const playerCount = parsedGame.playerCount ?? DEFAULT_PLAYER_COUNT;
      const seats = buildGameSeats({
        humanRole: parsedGame.humanRole,
        userId,
        catIds,
        playerCount,
      });

      // Phase D: Create independent game thread with project categorization
      const ts = new Date()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
        .replace(' ', '-')
        .replaceAll(':', '');
      const gameTitle = `狼人杀 — ${playerCount}人局 (${ts})`;
      const gameThread = await opts.threadStore.create(userId, gameTitle, `games/${parsedGame.gameType}`);
      const gameThreadId = gameThread.id;
      await opts.threadStore.updatePin(gameThreadId, true);

      // Notify source thread about the new game thread (include initiator for frontend guard)
      opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'game:thread_created', {
        gameThreadId,
        gameTitle,
        initiatorUserId: userId,
        timestamp: Date.now(),
      });

      // Store user message in the game thread
      const userMessage = await opts.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: gameThreadId,
      });

      // Use WerewolfLobby for role assignment, then orchestrator for persistence + broadcast
      const lobby = new WerewolfLobby();
      const lobbyRuntime = lobby.createLobby({
        threadId: gameThreadId,
        playerCount,
        players: seats.map((s) => ({ actorType: s.actorType, actorId: s.actorId })),
      });
      lobby.startGame(lobbyRuntime);

      let gameRuntime;
      try {
        gameRuntime = await gameOrchestrator.startGame({
          threadId: gameThreadId,
          definition: lobbyRuntime.definition,
          seats: lobbyRuntime.seats,
          config: {
            timeoutMs: 30000,
            voiceMode: parsedGame.voiceMode,
            humanRole: parsedGame.humanRole,
            ...(parsedGame.humanRole === 'player' ? { humanSeat: 'P1' } : {}),
            observerUserId: userId, // H2 fix: messageStore dual-write needs userId for thread visibility
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('already has an active game')) {
          reply.status(409);
          return { error: message };
        }
        throw err;
      }

      // Broadcast scoped views so frontend receives game:state_update
      await gameOrchestrator.broadcastGameState(gameRuntime.gameId);

      // AC-C3: Start AI auto-play loop — cats submit actions asynchronously
      gameAutoPlayer.startLoop(gameRuntime.gameId);

      return {
        status: 'game_started',
        gameId: gameRuntime.gameId,
        gameThreadId,
        userMessageId: userMessage.id,
      };
    }

    const parsedThreadAddress = isThreadAddressRoutingEnabled(resolvedThreadId)
      ? parseThreadAddressToken(content)
      : ({ kind: 'none' } as const);
    if (parsedThreadAddress.kind === 'invalid') {
      reply.status(400);
      return {
        error: '线程地址无效或无权限，本次未启动执行',
        code: 'THREAD_ADDRESS_INVALID',
      };
    }

    let explicitThreadAddress:
      | { ok: true; sourceThreadId: string; rootMessageId: string; replyTargetThreadId: string }
      | undefined;
    if (parsedThreadAddress.kind === 'valid') {
      if (!opts.threadStore || !opts.invocationRecordStore) {
        reply.status(400);
        return { error: '线程地址无效或无权限，本次未启动执行', code: 'THREAD_ADDRESS_INVALID' };
      }
      const resolvedAddress = await resolveThreadAddress(parsedThreadAddress, {
        sourceThreadId: resolvedThreadId,
        userId,
        messageStore: opts.messageStore,
        threadStore: opts.threadStore,
      });
      if (!resolvedAddress.ok) {
        reply.status(400);
        return { error: '线程地址无效或无权限，本次未启动执行', code: resolvedAddress.code };
      }
      explicitThreadAddress = resolvedAddress;
    }

    const routingThreadId = explicitThreadAddress?.replyTargetThreadId ?? resolvedThreadId;
    let validatedReplyTo: string | undefined;
    if (replyTo) {
      const parentMsg = await opts.messageStore.getById(replyTo);
      if (parentMsg && parentMsg.threadId === routingThreadId) {
        validatedReplyTo = replyTo;
      } else {
        log.warn(
          { replyTo, threadId: routingThreadId, parentThreadId: parentMsg?.threadId },
          '[messages] replyTo rejected: not found or wrong thread',
        );
        if (explicitThreadAddress) {
          reply.status(400);
          return { error: '线程地址无效或无权限，本次未启动执行', code: 'THREAD_ADDRESS_INVALID' };
        }
      }
    }
    if (routingThreadId !== resolvedThreadId) resetStreak(routingThreadId);

    // ADR-008 S1: Pre-resolve targets + intent, persisting @mentions as participants
    log.debug(
      { threadId: routingThreadId, sourceThreadId: resolvedThreadId, contentLen: content.length },
      'Resolving targets and intent',
    );
    const {
      targetCats: resolvedTargetCats,
      intent,
      hasMentions,
    } = await router.resolveTargetsAndIntent(content, routingThreadId, {
      persist: true,
    });
    // F35: When sending a whisper, override routing targets to only whisperTo recipients.
    // This prevents non-recipient cats from being invoked and seeing whisper content.
    const targetCats =
      whisperVisibility === 'whisper' && whisperRecipients?.length
        ? [...new Set(whisperRecipients)]
        : [...resolvedTargetCats];
    if (targetCats.length === 0) {
      reply.status(400);
      return { error: '没有可用的猫猫成员，请先在设置中添加一只猫猫', code: 'NO_TARGETS' };
    }
    const primaryCat = targetCats[0] ?? 'unknown';

    // Server-generated idempotency key if client didn't provide one
    const resolvedIdempotencyKey = idempotencyKey ?? randomUUID();

    let executionThreadId = routingThreadId;
    let executionMessageId: string | undefined;
    let rootUserMessage: StoredMessage | undefined;
    let executionRoute: ExecutionRouteV1 | undefined;
    let admittedInvocation: { outcome: string; invocationId: string } | undefined;

    if (explicitThreadAddress) {
      rootUserMessage = await opts.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: targetCats,
        timestamp: Date.now(),
        threadId: resolvedThreadId,
        idempotencyKey: resolvedIdempotencyKey,
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(whisperVisibility && whisperRecipients
          ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
          : {}),
      });
      const executionMessage = await opts.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: targetCats,
        timestamp: rootUserMessage.timestamp,
        threadId: explicitThreadAddress.replyTargetThreadId,
        idempotencyKey: resolvedIdempotencyKey,
        extra: { crossPost: { sourceThreadId: resolvedThreadId } },
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(whisperVisibility && whisperRecipients
          ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
          : {}),
      });
      executionMessageId = executionMessage.id;
      executionRoute = {
        version: 1,
        sourceThreadId: resolvedThreadId,
        rootMessageId: rootUserMessage.id,
        replyTargetThreadId: explicitThreadAddress.replyTargetThreadId,
        executionMessageId: executionMessage.id,
        mode: 'explicit_cross_thread',
      };
      try {
        admittedInvocation = await opts.invocationRecordStore!.create({
          threadId: explicitThreadAddress.replyTargetThreadId,
          userId,
          targetCats,
          intent: intent.intent,
          idempotencyKey: resolvedIdempotencyKey,
        });
      } catch (err) {
        log.error(
          { err, sourceThreadId: resolvedThreadId, replyTargetThreadId: explicitThreadAddress.replyTargetThreadId },
          '[F194] explicit thread address invocation admission failed',
        );
        reply.status(503);
        return {
          error: '线程路由建立失败，未启动执行',
          code: 'THREAD_ADDRESS_ADMISSION_FAILED',
          userMessageId: rootUserMessage.id,
        };
      }
      if (admittedInvocation.outcome === 'duplicate') {
        reply.status(200);
        return {
          status: 'duplicate',
          invocationId: admittedInvocation.invocationId,
          userMessageId: rootUserMessage.id,
        };
      }
      void deliverWebUserMessageToConnector(
        explicitThreadAddress.replyTargetThreadId,
        content,
        executionMessage.id,
        opts,
        log,
        { visibility: whisperVisibility },
      );
    }

    // F194 §3 step 2 (thread-first routing): in a thread that opted into
    // routingPolicy.mode='thread-first', every @mention message — including
    // plain questions classifyWorkAdmission would never admit — routes its
    // reply to the message's own anchored branch thread. The main thread
    // keeps only the source message; thread_reply_count_updated (batch 1)
    // is what makes the reply count visible there.
    //
    // Item 2 "judge retirement": classifyWorkAdmission (or the forced "As
    // Task" declaration) no longer decides *where the reply goes* here — it
    // only decides "create a task card as a bonus?". A false negative now
    // costs one missing card, never a misrouted reply.
    if (!executionRoute && hasMentions && !validatedReplyTo && opts.threadStore) {
      const routingThread = resolvedThreadId === 'default' ? null : await opts.threadStore.get(resolvedThreadId);
      if (isThreadFirstRoutingEnabled(routingThread)) {
        rootUserMessage = await opts.messageStore.append({
          userId,
          catId: null,
          content,
          mentions: targetCats,
          timestamp: Date.now(),
          threadId: resolvedThreadId,
          idempotencyKey: resolvedIdempotencyKey,
          ...(contentBlocks ? { contentBlocks } : {}),
          ...(whisperVisibility && whisperRecipients
            ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
            : {}),
        });
        void deliverWebUserMessageToConnector(resolvedThreadId, content, rootUserMessage.id, opts, log, {
          visibility: whisperVisibility,
        });

        const anchor = await ensureMessageAnchoredThread(
          rootUserMessage,
          { threadStore: opts.threadStore, messageStore: opts.messageStore },
          { userId },
        );
        executionThreadId = anchor.threadId;
        executionMessageId = anchor.anchorMessage.id;
        executionRoute = {
          version: 1,
          sourceThreadId: resolvedThreadId,
          rootMessageId: rootUserMessage.id,
          replyTargetThreadId: anchor.threadId,
          executionMessageId: anchor.anchorMessage.id,
          mode: 'message_anchor',
        };
        if (anchor.created) {
          opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'thread_branched', {
            sourceThreadId: resolvedThreadId,
            newThreadId: anchor.threadId,
            fromMessageId: rootUserMessage.id,
          });
        }

        // Decorative task-card judgment only — never gates routing above.
        if (opts.taskStore) {
          const cardDecision = asTask
            ? forceCreateFromMessage({ content, targetCatIds: targetCats })
            : classifyWorkAdmission({ content, targetCatIds: targetCats });
          if (cardDecision.kind !== 'reply_only') {
            try {
              const admitted = await admitWorkMessage({
                decision: cardDecision,
                sourceMessage: rootUserMessage,
                userId,
                deps: {
                  taskStore: opts.taskStore,
                  threadStore: opts.threadStore,
                  messageStore: opts.messageStore,
                  socketManager: opts.socketManager,
                },
              });
              // Routing is already settled above — ensureTaskDiscussionThread
              // reuses the same anchor branch (task-discussion-thread.ts),
              // so only the task bookkeeping fields are worth carrying forward.
              executionRoute = {
                ...executionRoute,
                ...(admitted.route.taskId ? { taskId: admitted.route.taskId } : {}),
                ...(admitted.route.ownerCatId ? { ownerCatId: admitted.route.ownerCatId } : {}),
              };
            } catch (err) {
              log.error(
                { err, threadId: resolvedThreadId, messageId: rootUserMessage.id },
                '[F194 thread-first] task card creation failed (non-fatal — reply routing unaffected)',
              );
            }
          }
        }
      }
    }

    // F194 §3 step 3: "As Task" forces admission regardless of the
    // classifier's verdict — one of Raft's three explicit-declaration
    // entrances (docs/research/clowder-raft-thread-task-design.md §5.3).
    // Non-thread-first channels otherwise keep the existing canary-gated
    // classifier behavior byte-for-byte.
    const autoTaskDecision =
      !executionRoute && opts.taskStore && opts.threadStore && opts.invocationRecordStore && !validatedReplyTo
        ? asTask
          ? forceCreateFromMessage({ content, targetCatIds: hasMentions ? targetCats : [] })
          : isAutoTaskThreadRoutingEnabled(resolvedThreadId)
            ? classifyWorkAdmission({
                content,
                targetCatIds: hasMentions ? targetCats : [],
              })
            : { kind: 'reply_only' as const, reason: 'rollout_or_dependencies_unavailable' }
        : { kind: 'reply_only' as const, reason: 'rollout_or_dependencies_unavailable' };

    if (autoTaskDecision.kind !== 'reply_only' && opts.taskStore && opts.threadStore) {
      rootUserMessage = await opts.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: targetCats,
        timestamp: Date.now(),
        threadId: resolvedThreadId,
        idempotencyKey: resolvedIdempotencyKey,
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(whisperVisibility && whisperRecipients
          ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
          : {}),
      });
      void deliverWebUserMessageToConnector(resolvedThreadId, content, rootUserMessage.id, opts, log, {
        visibility: whisperVisibility,
      });
      try {
        const admitted = await admitWorkMessage({
          decision: autoTaskDecision,
          sourceMessage: rootUserMessage,
          userId,
          deps: {
            taskStore: opts.taskStore,
            threadStore: opts.threadStore,
            messageStore: opts.messageStore,
            socketManager: opts.socketManager,
          },
        });
        executionRoute = admitted.route;
        executionThreadId = admitted.route.replyTargetThreadId;
        executionMessageId = admitted.route.executionMessageId;

        if (!admitted.route.ownerCatId) {
          reply.status(202);
          return {
            status: 'task_created',
            taskId: admitted.task.id,
            userMessageId: rootUserMessage.id,
            threadId: admitted.route.replyTargetThreadId,
          };
        }

        // F194: acquire the durable invocation idempotency key before the in-memory
        // slot. Concurrent HTTP replays therefore cannot fall into the queue path
        // while the first request is between slot acquisition and record creation.
        admittedInvocation = await opts.invocationRecordStore!.create({
          threadId: executionThreadId,
          userId,
          targetCats,
          intent: intent.intent,
          idempotencyKey: resolvedIdempotencyKey,
        });
        if (admittedInvocation.outcome === 'duplicate') {
          reply.status(200);
          return {
            status: 'duplicate',
            invocationId: admittedInvocation.invocationId,
            userMessageId: rootUserMessage.id,
          };
        }
      } catch (err) {
        log.error({ err, threadId: resolvedThreadId, messageId: rootUserMessage.id }, '[F194] work admission failed');
        reply.status(503);
        return {
          error: '任务线程创建失败，未启动执行',
          detail: '消息已保留，请稍后重试或手动转为任务。',
          code: 'WORK_ADMISSION_FAILED',
          userMessageId: rootUserMessage.id,
        };
      }
    }

    // F39+F108B: Slot-aware delivery mode routing
    // Whisper → check target cat's slot (side-dispatch to idle cat)
    // Broadcast with explicit @mention → any target busy = queue (P1 review fix)
    // Broadcast without @mention → thread-level check (any active → queue)
    // #555: Cover the gap between one invocation ending (tracker cleared) and the
    // next starting from queue (tracker not yet registered).
    // Whisper / @mention use cat-specific isCatBusy; broadcast uses active execution,
    // not queued leftovers, to avoid enqueue-only dead ends.
    const hasActive = (() => {
      if (!opts.invocationTracker) {
        return opts.queueProcessor?.hasActiveExecution?.(executionThreadId) ?? false;
      }
      if (whisperVisibility === 'whisper' && primaryCat !== 'unknown') {
        return (
          opts.invocationTracker.has(executionThreadId, primaryCat) ||
          (opts.queueProcessor?.isCatBusy?.(executionThreadId, primaryCat) ?? false)
        );
      }
      if (hasMentions) {
        return targetCats.some(
          (cat) =>
            cat !== 'unknown' &&
            (opts.invocationTracker!.has(executionThreadId, cat) ||
              (opts.queueProcessor?.isCatBusy?.(executionThreadId, cat) ?? false)),
        );
      }
      return (
        opts.invocationTracker.has(executionThreadId) ||
        (opts.queueProcessor?.hasActiveExecution?.(executionThreadId) ?? false)
      );
    })();
    // Design four canary: eligible messages enter the same queue even while idle,
    // so the first message can own a fixed 5–10s batching window. Structured
    // overrides and complex/whisper payloads remain hard bypasses.
    const batchEligible =
      !executionRoute &&
      isMessageBatchCanaryThread(resolvedThreadId) &&
      deliveryMode !== 'immediate' &&
      deliveryMode !== 'force' &&
      whisperVisibility !== 'whisper' &&
      !validatedReplyTo &&
      !contentBlocks?.length;
    const mode = executionRoute ? 'immediate' : (deliveryMode ?? (hasActive || batchEligible ? 'queue' : 'immediate'));
    log.debug(
      {
        threadId: executionThreadId,
        sourceThreadId: resolvedThreadId,
        targetCats,
        intent: intent.intent,
        mode,
        hasActive,
      },
      'Dispatch decision',
    );

    if (mode === 'queue' && (hasActive || batchEligible) && opts.invocationQueue) {
      // ① Enqueue first (sync, capacity gatekeeper) — messageId is null at this point
      const enqueueResult = opts.invocationQueue.enqueue({
        threadId: resolvedThreadId,
        userId,
        idempotencyKey: resolvedIdempotencyKey,
        content,
        source: 'user',
        targetCats,
        intent: intent.intent,
      });

      if (enqueueResult.outcome === 'resetting') {
        reply.status(409);
        return { error: '上下文正在重置，请稍后重试', code: 'CONTEXT_RESET_BUSY' };
      }

      // Queue full → 429, no message written (no ghost message)
      if (enqueueResult.outcome === 'full') {
        opts.socketManager.emitToUser(userId, 'queue_full_warning', {
          threadId: resolvedThreadId,
          source: 'user',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
          queue: opts.invocationQueue.list(resolvedThreadId, userId),
        });
        reply.status(429);
        return {
          error: '消息队列已满',
          code: 'QUEUE_FULL',
          queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
        };
      }

      let storedUserMessageId: string | null = enqueueResult.entry?.messageId ?? null;

      // ② Write user message (F117: mark as queued — invisible until dequeue)
      // If enqueue returned a deduped active entry, reuse existing messageId and skip append.
      if (!enqueueResult.deduped) {
        try {
          const userMessage = await opts.messageStore.append({
            userId,
            catId: null,
            content,
            mentions: targetCats,
            timestamp: Date.now(),
            threadId: resolvedThreadId,
            idempotencyKey: resolvedIdempotencyKey,
            deliveryStatus: 'queued', // F117: not visible in history/context/mentions until delivered
            ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
            ...(contentBlocks ? { contentBlocks } : {}),
            ...(whisperVisibility && whisperRecipients
              ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
              : {}),
          });
          storedUserMessageId = userMessage.id;

          const queueEntryId = enqueueResult.entry?.id;
          if (queueEntryId) {
            opts.invocationQueue.backfillMessageEnvelope(resolvedThreadId, userId, queueEntryId, {
              messageId: userMessage.id,
              senderType: 'user',
              content: userMessage.content,
              mentions: [...userMessage.mentions],
              timestamp: userMessage.timestamp,
            });
          }
          if (enqueueResult.entry) {
            // [thread-task-design] §2 root cause 1 / F194: user-sourced queue entries
            // previously never hit the durability journal, so a restart silently
            // dropped queued user messages. Mirror the A2A path's admission barrier
            // (persistEntry after enqueue succeeds, before reporting 202 to caller).
            await opts.invocationQueue.persistEntry(enqueueResult.entry);
          }
          void deliverWebUserMessageToConnector(resolvedThreadId, content, userMessage.id, opts, log, {
            visibility: whisperVisibility,
          });
        } catch (err) {
          const queueEntryId = enqueueResult.entry?.id;
          if (queueEntryId) {
            opts.invocationQueue.rollbackEnqueue(resolvedThreadId, userId, queueEntryId);
          }
          throw err;
        }
      }

      // Emit queue update to this user only (privacy: scopeKey isolation)
      opts.socketManager.emitToUser(userId, 'queue_updated', {
        threadId: resolvedThreadId,
        queue: opts.invocationQueue.list(resolvedThreadId, userId),
        action: enqueueResult.outcome,
      });
      if (batchEligible && opts.queueProcessor) {
        opts.queueProcessor.scheduleUserBatchFlush({
          threadId: resolvedThreadId,
          userId,
          targetCats,
          intent: intent.intent,
          windowMs: resolveMessageBatchWindowMs(),
        });
      } else if (isParallelDispatchEnabled()) {
        void opts.queueProcessor?.processNext(resolvedThreadId, userId).catch((err) => {
          log.error({ err, threadId: resolvedThreadId, userId }, 'Parallel dispatch after enqueue failed');
        });
      }

      tryAutoCancelPendingHolds(resolvedThreadId, opts.holdBallCancelDeps);

      reply.status(202);
      return {
        status: 'queued',
        queuePosition: enqueueResult.queuePosition,
        entryId: enqueueResult.entry?.id,
        merged: false,
        ...(storedUserMessageId ? { userMessageId: storedUserMessageId } : {}),
      };
    }

    if (mode === 'force' && hasActive) {
      // Cancel current invocation (same logic as WS cancel)
      const cancelResult = opts.invocationTracker?.cancel(resolvedThreadId, primaryCat, userId);
      if (cancelResult?.cancelled) {
        for (const m of buildCancelMessages(cancelResult)) {
          opts.socketManager.broadcastAgentMessage(m, resolvedThreadId);
        }
      }
      // F39 bugfix: Prevent QueueProcessor state poisoning — the old invocation's
      // async cleanup will call onInvocationComplete('failed'/'canceled') which pauses
      // the thread. Clear that preemptively since we're about to start a new invocation.
      opts.queueProcessor?.clearPause(resolvedThreadId, primaryCat);

      // F39 bugfix: Notify frontend that force-cancel happened (clear stale queue UI)
      if (opts.invocationQueue) {
        opts.socketManager.emitToUser(userId, 'queue_updated', {
          threadId: resolvedThreadId,
          queue: opts.invocationQueue.list(resolvedThreadId, userId),
          action: 'force_cleared',
        });
      }
      // Fall through to immediate execution below
    }

    // ① F122 A.1: Occupy tracker slot BEFORE creating InvocationRecord to close TOCTOU window.
    // Non-force paths use tryStartThread (non-preemptive); force uses start() (preemptive, already cancelled above).
    if (opts.invocationRecordStore) {
      let controller: AbortController | undefined;

      if (mode !== 'force' && opts.invocationTracker) {
        // F122 AC-A8 + task #81: atomic per-target busy gate + slot registration.
        // Explicit @mention dispatch should only queue when the requested cat slot
        // is busy; other cats may keep running in the same thread.
        const tryResult = opts.invocationTracker.tryStartThreadAll(executionThreadId, targetCats, userId);
        if (tryResult === null) {
          if (admittedInvocation) {
            await opts.invocationRecordStore.update(admittedInvocation.invocationId, {
              status: 'failed',
              error: 'Task execution thread became busy before dispatch',
            });
            reply.status(409);
            return { error: '任务线程正在执行其他请求，本次未重复排队', code: 'WORK_ROUTE_BUSY' };
          }
          // TOCTOU: one requested target became busy between has() and here — degrade to queue
          if (opts.invocationQueue) {
            const enqueueResult = opts.invocationQueue.enqueue({
              threadId: resolvedThreadId,
              userId,
              idempotencyKey: resolvedIdempotencyKey,
              content,
              source: 'user',
              targetCats,
              intent: intent.intent,
            });
            if (enqueueResult.outcome === 'resetting') {
              reply.status(409);
              return { error: '上下文正在重置，请稍后重试', code: 'CONTEXT_RESET_BUSY' };
            }
            if (enqueueResult.outcome === 'full') {
              opts.socketManager.emitToUser(userId, 'queue_full_warning', {
                threadId: resolvedThreadId,
                source: 'user',
                queueSize: opts.invocationQueue.size(resolvedThreadId, userId),
                queue: opts.invocationQueue.list(resolvedThreadId, userId),
              });
              reply.status(429);
              return { error: '消息队列已满', code: 'QUEUE_FULL' };
            }
            // F122 R1-gpt52 P1-1: Wrap append+backfill in try/catch with rollback,
            // matching original queue path (lines 340-374) to prevent ghost queue entries.
            let toctouUserMessageId: string | null = enqueueResult.entry?.messageId ?? null;
            if (!enqueueResult.deduped) {
              try {
                const toctouUserMessage = await opts.messageStore.append({
                  userId,
                  catId: null,
                  content,
                  mentions: targetCats,
                  timestamp: Date.now(),
                  threadId: resolvedThreadId,
                  idempotencyKey: resolvedIdempotencyKey,
                  deliveryStatus: 'queued',
                  ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
                  ...(contentBlocks ? { contentBlocks } : {}),
                  ...(whisperVisibility && whisperRecipients
                    ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
                    : {}),
                });
                toctouUserMessageId = toctouUserMessage.id;
                const queueEntryId = enqueueResult.entry?.id;
                if (queueEntryId) {
                  opts.invocationQueue.backfillMessageId(resolvedThreadId, userId, queueEntryId, toctouUserMessage.id);
                }
                if (enqueueResult.entry) {
                  // [thread-task-design] §2 root cause 1: same durability barrier as the
                  // primary queue path — this TOCTOU fallback also enqueues real user work.
                  await opts.invocationQueue.persistEntry(enqueueResult.entry);
                }
                void deliverWebUserMessageToConnector(resolvedThreadId, content, toctouUserMessage.id, opts, log, {
                  visibility: whisperVisibility,
                });
              } catch (err) {
                const queueEntryId = enqueueResult.entry?.id;
                if (queueEntryId) {
                  opts.invocationQueue.rollbackEnqueue(resolvedThreadId, userId, queueEntryId);
                }
                throw err;
              }
            }
            opts.socketManager.emitToUser(userId, 'queue_updated', {
              threadId: resolvedThreadId,
              queue: opts.invocationQueue.list(resolvedThreadId, userId),
              action: enqueueResult.outcome,
            });
            if (isParallelDispatchEnabled()) {
              void opts.queueProcessor?.processNext(resolvedThreadId, userId).catch((err) => {
                log.error({ err, threadId: resolvedThreadId, userId }, 'Parallel dispatch after TOCTOU enqueue failed');
              });
            }
            tryAutoCancelPendingHolds(resolvedThreadId, opts.holdBallCancelDeps);
            reply.status(202);
            return {
              status: 'queued',
              queuePosition: enqueueResult.queuePosition,
              entryId: enqueueResult.entry?.id,
              merged: false,
              ...(toctouUserMessageId ? { userMessageId: toctouUserMessageId } : {}),
            };
          }
          // No queue available — thread is busy but we can't queue. Reject.
          reply.status(409);
          return { error: '猫猫正在忙', code: 'THREAD_BUSY' };
        }
        controller = tryResult;
      }

      // F122 R1 P1: Wrap create/update/append in try/catch to release slot on error.
      // The background coroutine has its own finally for normal completion, but if we
      // throw before entering it, the slot would leak (thread stuck as "busy").
      let createResult: { outcome: string; invocationId: string };
      if (admittedInvocation) {
        createResult = admittedInvocation;
      } else {
        try {
          createResult = await opts.invocationRecordStore.create({
            threadId: executionThreadId,
            userId,
            targetCats,
            intent: intent.intent,
            idempotencyKey: resolvedIdempotencyKey,
          });
        } catch (createErr) {
          // Release slots occupied by tryStartThreadAll — prevent "假忙" leak
          if (controller) {
            opts.invocationTracker?.completeAll(executionThreadId, targetCats, controller);
          }
          throw createErr;
        }
      }

      if (createResult.outcome === 'duplicate') {
        // AC-A11: tryStartThreadAll succeeded but create returned duplicate — release slots
        if (controller) {
          opts.invocationTracker?.completeAll(executionThreadId, targetCats, controller);
        }
        const duplicateRecord = await Promise.resolve(opts.invocationRecordStore.get(createResult.invocationId)).catch(
          (error) => {
            log.warn(
              { err: error, invocationId: createResult.invocationId },
              '[messages] Failed to load duplicate invocation record',
            );
            return null;
          },
        );
        reply.status(200);
        return {
          status: 'duplicate',
          invocationId: createResult.invocationId,
          ...(rootUserMessage?.id
            ? { userMessageId: rootUserMessage.id }
            : duplicateRecord?.userMessageId
              ? { userMessageId: duplicateRecord.userMessageId }
              : {}),
        };
      }

      // Force path: still uses startAll() (preemptive — cancel already happened above)
      if (!controller) {
        controller = opts.invocationTracker?.startAll(executionThreadId, targetCats, userId);
      }

      // Race: thread entered deleting between isDeleting() and start()
      if (controller?.signal.aborted) {
        await opts.invocationRecordStore.update(createResult.invocationId, {
          status: 'canceled',
        });
        reply.status(409);
        return {
          error: '对话正在删除中',
          detail: '请稍后重试，或新建一个对话继续',
          code: 'THREAD_DELETING',
        };
      }

      // F122 R1 P1 cont: wrap message write + update before background coroutine.
      // If any of these throw, release the slot to prevent "假忙" leak.
      let storedUserMessage: { id: string };
      try {
        // ② Write user message (decoupled from cat execution)
        storedUserMessage =
          rootUserMessage ??
          (await opts.messageStore.append({
            userId,
            catId: null,
            content,
            mentions: targetCats,
            timestamp: Date.now(),
            threadId: resolvedThreadId,
            ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
            ...(contentBlocks ? { contentBlocks } : {}),
            ...(whisperVisibility && whisperRecipients
              ? { visibility: whisperVisibility, whisperTo: whisperRecipients }
              : {}),
          }));

        // ③ Backfill InvocationRecord.userMessageId
        await opts.invocationRecordStore.update(createResult.invocationId, {
          userMessageId: executionMessageId ?? storedUserMessage.id,
        });
        if (!rootUserMessage) {
          void deliverWebUserMessageToConnector(resolvedThreadId, content, storedUserMessage.id, opts, log, {
            visibility: whisperVisibility,
          });
        }
      } catch (preExecErr) {
        // Release slots — we haven't entered background coroutine yet
        opts.invocationTracker?.completeAll(executionThreadId, targetCats, controller);
        // Mark record as failed if it was created
        try {
          await opts.invocationRecordStore?.update(createResult.invocationId, { status: 'failed' });
        } catch {
          /* best-effort cleanup */
        }
        throw preExecErr;
      }

      // ④ Reply with invocationId
      reply.send({
        status: 'processing',
        invocationId: createResult.invocationId,
        userMessageId: storedUserMessage.id,
        timestamp: Date.now(),
      });

      tryAutoCancelPendingHolds(executionThreadId, opts.holdBallCancelDeps);

      // ⑤ Background: execute cat invocation via routeExecution
      void (async () => {
        const HEARTBEAT_INTERVAL_MS = 30_000;
        const heartbeatInterval = setInterval(() => {
          opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'heartbeat', {
            threadId: executionThreadId,
            timestamp: Date.now(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        // F39: Track final status for queue auto-dequeue
        let finalStatus: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user' = 'failed';

        // F088 ISSUE-15: Hoisted so catch/abort branches can clean up streaming sessions
        let streamStartPromise: Promise<void> | undefined;

        // F148 fix: Hoisted so abort/catch branches can ack completed cats' cursors
        const cursorBoundaries = new Map<string, string>();
        const continuationCapsules = new Map<string, CollaborationContinuityCapsuleV1>();
        let consumedContinuation: ConsumedContinuationToken | undefined;

        try {
          await opts.invocationRecordStore?.update(createResult.invocationId, {
            status: 'running',
            phase: 'context_building',
          });

          // #768: intent_mode deferred to first CLI event (avoid "replying" when CLI never starts)
          let intentModeBroadcast = false;
          // P1-2: track persistence failures across generator boundary
          const persistenceContext: PersistenceContext = { failed: false, errors: [] };
          // F8: collect per-cat token usage from done events
          const collectedUsage = new Map<string, TokenUsage>();
          // F070: track governance block errorCode for recoverable failure marking
          let governanceErrorCode: string | undefined;
          // Provider services may terminate with an error event and no done.errorCode.
          // Keep that terminal truth separate from thrown/canceled/governance paths.
          const pendingProviderErrors = new Map<string, string>();

          // F088 ISSUE-15: Collect per-turn content for outbound delivery to connector platforms
          const outboundTurns: Array<{
            catId: string;
            textParts: string[];
            richBlocks?: unknown[];
          }> = [];
          let currentTurnCatId: string | undefined;
          const collectedTextParts: string[] = [];

          // F088 ISSUE-15: Start streaming placeholder on external platforms
          if (opts.streamingHook) {
            streamStartPromise = opts.streamingHook
              .onStreamStart(executionThreadId, primaryCat, createResult.invocationId)
              .catch((err) => {
                log.warn({ err, threadId: executionThreadId }, '[messages] StreamingHook.onStreamStart failed');
              });
          }

          // User stop can win the race before CLI produces the first event.
          // Do not re-arm frontend state with spawn_started/intent_mode after abort.
          if (controller?.signal.aborted) {
            finalStatus = controller.signal.reason === 'user_cancel' ? 'canceled_by_user' : 'canceled';
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'canceled',
            });
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
            return;
          }

          if (opts.sessionContinuationCoordinator && targetCats.length === 1) {
            const singleCatId = targetCats[0]!;
            try {
              const prepared = await opts.sessionContinuationCoordinator.prepareInvocationContext({
                threadId: executionThreadId,
                catId: singleCatId,
                userId,
                content,
              });
              content = prepared.content;
              consumedContinuation = prepared.consumedContinuation;
            } catch (err) {
              log.warn(
                { err, threadId: executionThreadId, catId: singleCatId },
                '[messages] F224: prepareInvocationContext failed, proceeding without continuation context',
              );
            }
          }

          // F118 D2: Broadcast spawn_started immediately — fills the intent_mode blind spot.
          // intent_mode only fires after the first CLI NDJSON event (0–2 min delay).
          // spawn_started fires here, before routeExecution, so the UI can show
          // per-cat "spawning" indicators without waiting for CLI to come alive.
          opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'spawn_started', {
            threadId: executionThreadId,
            targetCats,
            invocationId: createResult.invocationId,
          });
          await opts.invocationRecordStore?.update(createResult.invocationId, { phase: 'runtime_starting' });
          opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'invocation_phase', {
            threadId: executionThreadId,
            invocationId: createResult.invocationId,
            targetCats,
            phase: 'runtime_starting',
          });
          void opts.catSupervisor?.markProcessing(targetCats);

          await opts.invocationRecordStore?.update(createResult.invocationId, { phase: 'first_token_waiting' });
          opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'invocation_phase', {
            threadId: executionThreadId,
            invocationId: createResult.invocationId,
            targetCats,
            phase: 'first_token_waiting',
          });

          for await (const msg of router.routeExecution(
            userId,
            content,
            executionThreadId,
            executionMessageId ?? storedUserMessage.id,
            targetCats,
            intent,
            {
              ...(contentBlocks ? { contentBlocks } : {}),
              uploadDir,
              ...(controller?.signal ? { signal: controller.signal } : {}),
              ...(validatedReplyTo ? { replyToMessageId: storedUserMessage.id } : {}),
              ...(opts.invocationQueue
                ? {
                    queueHasQueuedMessages: (tid: string) =>
                      opts.invocationQueue?.hasQueuedUserMessagesForThread(tid) ?? false,
                    hasQueuedOrActiveAgentForCat: (tid: string, catId: string) =>
                      opts.invocationQueue?.hasActiveOrQueuedAgentForCat(tid, catId) ?? false,
                    enqueueA2ATargets: async (handoff: {
                      threadId: string;
                      userId: string;
                      callerCatId: CatId;
                      targetCats: CatId[];
                      content: string;
                      triggerMessageId?: string;
                      sourceUserMessageId?: string;
                      waitedForQueuedUserMessages?: true;
                      freshnessProtected?: true;
                    }) => {
                      const enqueued: CatId[] = [];
                      for (const targetCat of handoff.targetCats) {
                        const wasBusy =
                          opts.invocationTracker?.has(handoff.threadId, targetCat) === true ||
                          opts.invocationQueue?.hasQueuedOrProcessingForCat(handoff.threadId, targetCat) === true;
                        const pendingMentionId = handoff.triggerMessageId
                          ? buildA2AIdempotencyKey({
                              triggerMessageId: handoff.triggerMessageId,
                              callerCatId: handoff.callerCatId,
                              targetCatId: targetCat,
                            })
                          : undefined;
                        const result = opts.invocationQueue?.enqueue({
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
                          messageEnvelope: handoff.triggerMessageId
                            ? {
                                messageId: handoff.triggerMessageId,
                                senderType: 'agent',
                                content: handoff.content,
                                mentions: [targetCat],
                                timestamp: Date.now(),
                              }
                            : undefined,
                          source: 'agent',
                          sourceCategory: 'a2a',
                          targetCats: [targetCat],
                          intent: 'execute',
                          autoExecute: true,
                          callerCatId: handoff.callerCatId,
                          a2aTriggerMessageId: handoff.triggerMessageId,
                          a2aSourceUserMessageId: handoff.sourceUserMessageId,
                          a2aWaitedForQueuedUserMessages: handoff.waitedForQueuedUserMessages,
                          pendingMentionId,
                          expiresAt: pendingMentionId ? Date.now() + PENDING_MENTION_TTL_MS : undefined,
                          freshnessProtected: handoff.freshnessProtected,
                        });
                        if (result?.outcome !== 'enqueued' || !result.entry) continue;
                        if (handoff.triggerMessageId) {
                          opts.invocationQueue?.backfillMessageId(
                            handoff.threadId,
                            handoff.userId,
                            result.entry.id,
                            handoff.triggerMessageId,
                          );
                        }
                        await opts.invocationQueue?.persistEntry(result.entry);
                        if (wasBusy && result.entry.expiresAt) {
                          await persistA2APendingNotice(opts, {
                            threadId: handoff.threadId,
                            targetCatId: targetCat,
                            queueEntryId: result.entry.id,
                            expiresAt: result.entry.expiresAt,
                          });
                        }
                        enqueued.push(targetCat);
                      }
                      if (enqueued.length > 0) {
                        opts.socketManager.emitToUser(handoff.userId, 'queue_updated', {
                          threadId: handoff.threadId,
                          queue: opts.invocationQueue?.list(handoff.threadId, handoff.userId) ?? [],
                          action: 'enqueued',
                        });
                        await opts.queueProcessor?.tryAutoExecute(handoff.threadId);
                      }
                      return enqueued;
                    },
                  }
                : {}),
              ...(controller ? { invocationController: controller } : {}),
              trackA2ASlot: (tid: string, catId: string, uid: string, ctrl: AbortController) => {
                opts.invocationTracker?.trackExternalSlot(tid, catId, ctrl, uid, [catId]);
              },
              completeA2ASlots: (tid: string, catIds: readonly string[], ctrl: AbortController) => {
                for (const catId of catIds) opts.invocationTracker?.completeSlot?.(tid, catId, ctrl);
              },
              cursorBoundaries,
              persistenceContext,
              parentInvocationId: createResult.invocationId,
              ...(executionRoute?.mode === 'explicit_cross_thread'
                ? { crossPostSourceThreadId: executionRoute.sourceThreadId }
                : {}),
            },
          )) {
            if (controller?.signal.aborted) {
              break;
            }
            if (msg.type === 'tool_use') {
              await opts.invocationRecordStore?.update(createResult.invocationId, { phase: 'tool_calling' });
              opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'invocation_phase', {
                threadId: executionThreadId,
                invocationId: createResult.invocationId,
                targetCats,
                phase: 'tool_calling',
              });
            }
            // #768: Broadcast intent_mode on first CLI event — proves CLI is alive.
            if (!intentModeBroadcast) {
              opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'intent_mode', {
                threadId: executionThreadId,
                mode: intent.intent,
                targetCats,
                invocationId: createResult.invocationId,
              });
              intentModeBroadcast = true;
              // Push participants to sidebar. resolveTargets only calls addParticipants
              // for @mention flows; non-mention routing (preferredCats/default) skips it.
              // Merge stored participants with targetCats so sidebar always gets the
              // responding cats, regardless of how they were resolved.
              const existingParticipants = (await opts.threadStore?.get(executionThreadId))?.participants ?? [];
              const mergedParticipants = [...new Set([...existingParticipants, ...targetCats])];
              opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'thread_updated', {
                threadId: executionThreadId,
                participants: mergedParticipants,
              });
            }
            // F39 bugfix: stop broadcasting after cancel (drain pipe buffer silently)
            if (controller?.signal.aborted) break;
            const continuationCapsule = extractContinuityCapsuleFromAgentMessage(msg);
            if (continuationCapsule) {
              continuationCapsules.set(continuationCapsule.catId, continuationCapsule);
            }
            if ((msg.type === 'done' || msg.type === 'error') && msg.catId && msg.metadata?.usage) {
              collectedUsage.set(msg.catId, mergeTokenUsage(collectedUsage.get(msg.catId), msg.metadata.usage));
            }
            if (msg.type === 'error' && msg.catId) {
              pendingProviderErrors.set(
                msg.catId,
                typeof msg.error === 'string' && msg.error.trim() ? msg.error : 'Provider error',
              );
            }
            if (msg.type === 'text' && msg.catId && typeof msg.content === 'string' && msg.content.trim()) {
              // Some providers emit a recoverable tool-level error, then continue with a valid answer.
              // Only an error with no later same-cat text remains terminal.
              pendingProviderErrors.delete(msg.catId);
            }
            if (msg.type === 'done' && msg.errorCode) {
              governanceErrorCode = msg.errorCode;
            }
            if ((msg.type === 'done' || msg.type === 'error') && msg.catId) {
              opts.invocationTracker?.completeSlot?.(executionThreadId, msg.catId, controller);
            }

            // F088 ISSUE-15: Collect outbound turns (same pattern as QueueProcessor)
            if (msg.type === 'done' && msg.catId) {
              const egressDisposition = persistenceContext.egressByCat?.[msg.catId]?.disposition;
              if (egressDisposition === 'held' || egressDisposition === 'discarded') {
                persistenceContext.richBlocks = undefined;
              } else if (persistenceContext.richBlocks) {
                const turn = outboundTurns[outboundTurns.length - 1];
                if (turn && turn.catId === msg.catId && currentTurnCatId === msg.catId) {
                  turn.richBlocks = [...persistenceContext.richBlocks];
                } else {
                  outboundTurns.push({
                    catId: msg.catId,
                    textParts: [],
                    richBlocks: [...persistenceContext.richBlocks],
                  });
                }
                persistenceContext.richBlocks = undefined;
              }
              currentTurnCatId = undefined;
            }
            if (msg.type === 'text' && typeof (msg as unknown as Record<string, unknown>).content === 'string') {
              const textContent = (msg as unknown as Record<string, unknown>).content as string;
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
              // F088 ISSUE-15: Forward streaming chunks to external platforms
              if (opts.streamingHook) {
                const accumulated =
                  outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts);
                opts.streamingHook
                  .onStreamChunk(executionThreadId, accumulated, createResult.invocationId)
                  .catch((streamErr) => {
                    log.warn(
                      { err: streamErr, threadId: executionThreadId },
                      '[messages] StreamingHook.onStreamChunk failed',
                    );
                  });
              }
            }

            const broadcastPayload = withExecutionCrossPostAudit(
              { ...msg, invocationId: createResult.invocationId },
              executionRoute,
              createResult.invocationId,
            );

            if (msg.type === 'a2a_handoff') {
              const storedId = await persistA2ARoutingMessage(opts.messageStore, msg, executionThreadId);
              if (storedId) broadcastPayload.messageId = storedId;
            }

            opts.socketManager.broadcastAgentMessage(broadcastPayload, executionThreadId);
          }

          // F39 P1 fix (砚砚 R1): abort guard after loop — when signal is aborted
          // and the generator ends normally (no throw), the break exits the loop but
          // post-loop code would still run ack+succeeded. Guard explicitly.
          if (controller?.signal.aborted) {
            finalStatus = controller.signal.reason === 'user_cancel' ? 'canceled_by_user' : 'canceled';
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'canceled',
              phase: 'done',
            });
            // Bugfix: silent-exit P2 — only broadcast diagnostic when preempted by
            // a newer invocation (reason='preempted'). User-initiated cancel already
            // broadcasts its own messages via buildCancelMessages; adding another here
            // would cause a duplicate with misleading text.
            if (controller.signal.reason === 'preempted') {
              opts.socketManager.broadcastAgentMessage(
                withExecutionCrossPostAudit(
                  {
                    type: 'system_info',
                    catId: targetCats[0] ?? getDefaultCatId(),
                    content: JSON.stringify({
                      type: 'invocation_preempted',
                      detail: 'This response was superseded by a newer request.',
                      invocationId: createResult.invocationId,
                    }),
                    timestamp: Date.now(),
                  },
                  executionRoute,
                  createResult.invocationId,
                ),
                executionThreadId,
              );
            }
            // F148 fix: ack cursors for cats that completed before abort (monotonic CAS, safe to call)
            if (cursorBoundaries.size > 0) {
              await router.ackCollectedCursors(userId, executionThreadId, cursorBoundaries);
            }
            // P1 fix: finalize streaming session on abort so external placeholders are cleaned up
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } else if (persistenceContext.failed) {
            const errorDetail = persistenceContext.errors.map((e) => `${e.catId}: ${e.error}`).join('; ');
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              phase: 'done',
              error: `Message delivered but persistence failed: ${errorDetail}`,
            });
            opts.socketManager.broadcastAgentMessage(
              withExecutionCrossPostAudit(
                {
                  type: 'error',
                  catId: getDefaultCatId(),
                  error: '消息已发送但未能保存，刷新后可能丢失。可点击重试。',
                  timestamp: Date.now(),
                },
                executionRoute,
                createResult.invocationId,
              ),
              executionThreadId,
            );

            const pushSvcErr = getPushNotificationService();
            if (pushSvcErr) {
              pushSvcErr
                .notifyUser(userId, {
                  title: '猫猫消息保存失败',
                  body: '消息已发送但未能保存，请检查',
                  tag: `cat-error-${executionThreadId}`,
                  data: { threadId: executionThreadId, url: `/?thread=${executionThreadId}` },
                })
                .catch(() => {});
            }
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } else if (governanceErrorCode) {
            // F070: Governance gate blocked — mark as failed with errorCode for retry
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              phase: 'done',
              error: governanceErrorCode,
              ...(collectedUsage.size > 0
                ? {
                    usageByCat: Object.fromEntries(collectedUsage),
                  }
                : {}),
            });
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } else if (pendingProviderErrors.size > 0) {
            const providerErrorText = [...pendingProviderErrors.values()].join('\n');
            if (cursorBoundaries.size > 0) {
              await router.ackCollectedCursors(userId, executionThreadId, cursorBoundaries);
            }
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              phase: 'done',
              error: providerErrorText,
              ...(collectedUsage.size > 0
                ? {
                    usageByCat: Object.fromEntries(collectedUsage),
                  }
                : {}),
            });
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } else {
            await opts.invocationRecordStore?.update(createResult.invocationId, { phase: 'persisting' });
            opts.socketManager.broadcastToRoom(`thread:${executionThreadId}`, 'invocation_phase', {
              threadId: executionThreadId,
              invocationId: createResult.invocationId,
              targetCats,
              phase: 'persisting',
            });
            // ADR-008 S3: ack cursors before marking succeeded so that if ack
            // throws, the catch block sees running→failed (valid transition).
            await router.ackCollectedCursors(userId, executionThreadId, cursorBoundaries);

            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'succeeded',
              phase: 'done',
              ...(collectedUsage.size > 0
                ? {
                    usageByCat: Object.fromEntries(collectedUsage),
                  }
                : {}),
            });
            finalStatus = 'succeeded';

            enqueueFreshnessReviewsFromPersistence(persistenceContext, opts.queueProcessor);

            for (const continuationCapsule of continuationCapsules.values()) {
              if (isNewFreshnessPublicationForCat(persistenceContext, continuationCapsule.catId)) {
                opts.queueProcessor?.enqueueContinuation({
                  threadId: executionThreadId,
                  userId,
                  catId: continuationCapsule.catId,
                  capsule: continuationCapsule,
                });
              }
            }

            // Push notification: cat(s) finished responding
            const pushSvc = getPushNotificationService();
            if (pushSvc && hasNewFreshnessPublication(persistenceContext)) {
              const catNames = targetCats.join(', ');
              const assistantText = (
                outboundTurns.length > 0 ? flattenTurnTextParts(outboundTurns) : flattenTextParts(collectedTextParts)
              ).trim();
              const needsDecision = assistantText.length > 0 ? shouldMarkDecisionNotification(assistantText) : false;
              const pushBodySource = assistantText || '猫猫已处理，请打开会话查看详情';
              pushSvc
                .notifyUser(userId, {
                  title: needsDecision ? `${catNames} 需要你决策` : `${catNames} 回复了`,
                  body: pushBodySource.slice(0, 80),
                  icon: targetCats.length === 1 ? `/avatars/${targetCats[0]}.png` : '/icons/icon-192x192.png',
                  tag: `${needsDecision ? 'cat-decision' : 'cat-reply'}-${executionThreadId}`,
                  data: {
                    threadId: executionThreadId,
                    url: `/?thread=${executionThreadId}`,
                    ...(needsDecision ? { requiresDecision: true } : {}),
                  },
                })
                .catch(() => {
                  /* best-effort */
                });
            }

            // F088 ISSUE-15: Outbound delivery to connector platforms (Feishu/Telegram)
            // P2 fix: fire-and-forget so delivery latency doesn't block invocationTracker.complete()
            deliverOutboundFromWeb(
              executionThreadId,
              primaryCat,
              createResult.invocationId,
              collectedTextParts,
              outboundTurns,
              persistenceContext,
              streamStartPromise,
              opts,
              log,
            ).catch((deliverErr) => {
              log.error({ err: deliverErr, threadId: executionThreadId }, '[messages] deliverOutboundFromWeb failed');
            });
          }
        } catch (err) {
          // F39 bugfix: detect abort (cancel/force) vs real failure
          if (controller?.signal.aborted) {
            finalStatus = controller.signal.reason === 'user_cancel' ? 'canceled_by_user' : 'canceled';
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'canceled',
              phase: 'done',
            });
            // F148 fix: ack cursors for cats that completed before the exception
            if (cursorBoundaries.size > 0) {
              try {
                await router.ackCollectedCursors(userId, executionThreadId, cursorBoundaries);
              } catch {
                /* best-effort — don't mask the original error */
              }
            }
            // Don't broadcast error for intentional cancel
            // P1-A fix: clean up streaming placeholder even on abort/cancel
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } else {
            // F148 fix: ack cursors for cats that completed before the exception
            if (cursorBoundaries.size > 0) {
              try {
                await router.ackCollectedCursors(userId, executionThreadId, cursorBoundaries);
              } catch {
                /* best-effort — don't mask the original error */
              }
            }
            log.error({ err, invocationId: createResult.invocationId }, 'Background processing error');
            const errorMsg = normalizeErrorMessage(err);
            await opts.invocationRecordStore?.update(createResult.invocationId, {
              status: 'failed',
              phase: 'done',
              error: errorMsg,
            });
            opts.socketManager.broadcastAgentMessage(
              withExecutionCrossPostAudit(
                {
                  type: 'error',
                  catId: getDefaultCatId(),
                  error: errorMsg,
                  isFinal: true,
                  timestamp: Date.now(),
                },
                executionRoute,
                createResult.invocationId,
              ),
              executionThreadId,
            );

            const pushSvcCatch = getPushNotificationService();
            if (pushSvcCatch) {
              pushSvcCatch
                .notifyUser(userId, {
                  title: '猫猫出错了',
                  body: errorMsg.slice(0, 100),
                  tag: `cat-error-${executionThreadId}`,
                  data: { threadId: executionThreadId, url: `/?thread=${executionThreadId}` },
                })
                .catch(() => {});
            }
            await cleanupStreamingOnFailure(
              executionThreadId,
              createResult.invocationId,
              streamStartPromise,
              opts,
              log,
            );
          } // end else (non-abort error)
        } finally {
          clearInterval(heartbeatInterval);
          void opts.catSupervisor?.markIdle(targetCats);
          if (opts.sessionContinuationCoordinator) {
            try {
              await opts.sessionContinuationCoordinator.commitInvocationOutcome({
                finalStatus,
                threadId: executionThreadId,
                catId: primaryCat,
                userId,
                consumedContinuation,
                producedCapsules: continuationCapsules.values(),
              });
            } catch (err) {
              log.warn(
                { err, threadId: executionThreadId, targetCats },
                '[messages] F224: commitInvocationOutcome failed',
              );
            }
          }
          opts.invocationTracker?.completeAll(executionThreadId, targetCats, controller);
          // F39: Notify queue processor for auto-dequeue chain
          opts.queueProcessor?.onInvocationComplete(executionThreadId, primaryCat, finalStatus).catch((err) => {
            log.error(
              { err, threadId: executionThreadId, catId: primaryCat, finalStatus },
              '[messages] onInvocationComplete failed — queued messages may be stuck (#595)',
            );
          });
        }
      })();
    } else {
      // Fallback: no invocationRecordStore (legacy path, uses route())
      // F122 A.1: Try non-preemptive first. Legacy path has no InvocationQueue so it
      // cannot degrade to queue — fall back to preemptive startAll() as temporary compat.
      // TODO(F122 Phase B): Legacy path should be removed or given queue support.
      let controller: AbortController | undefined;
      if (mode !== 'force' && opts.invocationTracker) {
        controller =
          opts.invocationTracker.tryStartThreadAll(resolvedThreadId, targetCats, userId) ??
          opts.invocationTracker.startAll(resolvedThreadId, targetCats, userId);
      } else {
        controller = opts.invocationTracker?.startAll(resolvedThreadId, targetCats, userId);
      }
      if (controller?.signal.aborted) {
        reply.status(409);
        return {
          error: '对话正在删除中',
          detail: '请稍后重试，或新建一个对话继续',
          code: 'THREAD_DELETING',
        };
      }

      reply.send({ status: 'processing', timestamp: Date.now() });

      void (async () => {
        const HEARTBEAT_INTERVAL_MS = 30_000;
        const heartbeatInterval = setInterval(() => {
          opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'heartbeat', {
            threadId: resolvedThreadId,
            timestamp: Date.now(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        try {
          void opts.catSupervisor?.markProcessing(targetCats);
          // #768: intent_mode deferred to first CLI event (legacy path)
          let intentModeBroadcast = false;

          for await (const msg of router.route(
            userId,
            content,
            resolvedThreadId,
            contentBlocks,
            uploadDir,
            controller?.signal,
          )) {
            // #768: Broadcast intent_mode on first CLI event (legacy path)
            if (!intentModeBroadcast) {
              opts.socketManager.broadcastToRoom(`thread:${resolvedThreadId}`, 'intent_mode', {
                threadId: resolvedThreadId,
                mode: intent.intent,
                targetCats,
                // Legacy path: no invocationId (no InvocationRecord). Frontend falls back gracefully.
              });
              intentModeBroadcast = true;
            }
            const legacyPayload = { ...msg };
            if (msg.type === 'a2a_handoff') {
              const storedId = await persistA2ARoutingMessage(opts.messageStore, msg, resolvedThreadId);
              if (storedId) legacyPayload.messageId = storedId;
            }
            opts.socketManager.broadcastAgentMessage(legacyPayload, resolvedThreadId);
          }
        } catch (err) {
          log.error({ err }, 'Background processing error');
          opts.socketManager.broadcastAgentMessage(
            {
              type: 'error',
              catId: getDefaultCatId(),
              error: normalizeErrorMessage(err),
              isFinal: true,
              timestamp: Date.now(),
            },
            resolvedThreadId,
          );
        } finally {
          clearInterval(heartbeatInterval);
          void opts.catSupervisor?.markIdle(targetCats);
          opts.invocationTracker?.completeAll(resolvedThreadId, targetCats, controller);
        }
      })();
    }
  });

  app.get('/api/thread-address/resolve', async (request, reply) => {
    const query = z
      .object({
        rootMessageId: z.string().regex(THREAD_ADDRESS_ROOT_ID_RE),
        sourceThreadId: z.string().min(1).max(100),
      })
      .safeParse(request.query);
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!query.success || !userId || !opts.threadStore || !isThreadAddressRoutingEnabled(query.data.sourceThreadId)) {
      reply.status(404);
      return { error: '线程地址不可用', code: 'THREAD_ADDRESS_INVALID' };
    }
    const resolution = await resolveThreadAddress(
      {
        kind: 'valid',
        token: `#Thread:${query.data.rootMessageId}`,
        label: 'Thread',
        rootMessageId: query.data.rootMessageId,
      },
      {
        sourceThreadId: query.data.sourceThreadId,
        userId,
        messageStore: opts.messageStore,
        threadStore: opts.threadStore,
      },
    );
    if (!resolution.ok) {
      reply.status(404);
      return { error: '线程地址不可用', code: resolution.code };
    }
    return {
      rootMessageId: resolution.rootMessageId,
      threadId: resolution.replyTargetThreadId,
    };
  });

  // POST /api/messages/:id/convert-to-task — Raft 三显式入口之一（右键"转为任务"，
  // 批次2 集成：契约与前端 MessageActions.handleConvertToTask 对齐 {userId,title?,why?}
  // → {task, created}）。仅顶层消息可转：消息所在 thread 带 relation（即本身是分支）时拒绝。
  app.post('/api/messages/:id/convert-to-task', async (request, reply) => {
    const { id: messageId } = request.params as { id: string };
    const body = (request.body ?? {}) as { userId?: string; title?: string; why?: string };
    if (!body.userId || typeof body.userId !== 'string') {
      reply.status(400);
      return { error: 'userId is required' };
    }
    if (!opts.taskStore || !opts.threadStore) {
      reply.status(503);
      return { error: 'Task system unavailable' };
    }
    const sourceMessage = await opts.messageStore.getById(messageId);
    if (!sourceMessage) {
      reply.status(404);
      return { error: 'Message not found' };
    }
    const thread = await opts.threadStore.get(sourceMessage.threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (thread.relation) {
      reply.status(409);
      return { error: 'Only top-level messages can be converted to a task', code: 'NOT_TOP_LEVEL' };
    }
    const decision = forceCreateFromMessage({
      content: body.title?.trim() || sourceMessage.content,
      targetCatIds: sourceMessage.mentions ? [...sourceMessage.mentions] : [],
    });
    try {
      const admitted = await admitWorkMessage({
        decision,
        sourceMessage,
        userId: body.userId,
        deps: {
          taskStore: opts.taskStore,
          threadStore: opts.threadStore,
          messageStore: opts.messageStore,
          socketManager: opts.socketManager,
        },
      });
      return { task: admitted.task, created: admitted.created };
    } catch (err) {
      log.error({ err, messageId }, '[convert-to-task] admission failed');
      reply.status(500);
      return { error: 'Failed to convert message to task' };
    }
  });

  // GET /api/messages/search - 全文搜索消息内容
  app.get('/api/messages/search', async (request) => {
    const parseResult = searchMessagesSchema.safeParse(request.query);
    if (!parseResult.success) {
      return { messages: [] };
    }

    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      return { messages: [] };
    }

    const { q, limit } = parseResult.data;
    const normalizedQuery = q.toLowerCase();
    const threadTitleCache = new Map<string, string>();
    const recentMessages = await opts.messageStore.getRecent(10000);
    const rawMatches = recentMessages
      .filter((m) => {
        if (!isMessageVisibleToUser(m, userId)) return false;
        if (!m.content?.trim()) return false;
        return m.content.toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
    const matches = await Promise.all(
      rawMatches.map(async (m) => ({
        id: m.id,
        threadId: m.threadId,
        threadTitle: await resolveThreadTitle(opts.threadStore, m.threadId, threadTitleCache),
        content: m.content,
        timestamp: m.timestamp,
        catId: m.catId,
        ...(m.editedAt ? { editedAt: m.editedAt } : {}),
        type: (m.catId
          ? isSystemUserMessage(m)
            ? 'system'
            : 'assistant'
          : m.source
            ? 'connector'
            : isSystemUserMessage(m)
              ? 'system'
              : 'user') as 'user' | 'assistant' | 'connector' | 'system',
      })),
    );

    return { messages: matches };
  });

  // GET /api/messages - 获取历史消息
  app.get('/api/messages', async (request) => {
    const parseResult = getMessagesSchema.safeParse(request.query);
    if (!parseResult.success) {
      return { messages: [], hasMore: false };
    }
    const { limit, before, around, threadId } = parseResult.data;
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      return { messages: [], hasMore: false };
    }

    // Parse composite cursor "timestamp:id" or legacy plain timestamp
    let beforeTs: number | undefined;
    let beforeId: string | undefined;
    if (before) {
      const colonIdx = before.indexOf(':');
      if (colonIdx > 0) {
        beforeTs = parseInt(before.slice(0, colonIdx), 10);
        beforeId = before.slice(colonIdx + 1);
      } else {
        beforeTs = parseInt(before, 10);
      }
      if (!Number.isFinite(beforeTs!)) {
        return { messages: [], hasMore: false };
      }
    }

    // Always thread-scoped — default to 'default' thread for lobby
    const resolvedThreadId = threadId ?? 'default';
    let hasMore = false;
    let page: StoredMessage[] = [];

    if (around && beforeTs == null) {
      const target = await opts.messageStore.getById(around);
      if (target?.threadId === resolvedThreadId && isDelivered(target) && isMessageVisibleToUser(target, userId)) {
        const beforeLimit = Math.max(1, Math.floor((limit - 1) / 2));
        const afterLimit = Math.max(0, limit - beforeLimit - 1);
        const beforePage = await opts.messageStore.getByThreadBefore(
          resolvedThreadId,
          target.timestamp,
          beforeLimit + 1,
          target.id,
          userId,
        );
        const afterPage = await opts.messageStore.getByThreadAfter(resolvedThreadId, target.id, afterLimit, userId);
        hasMore = beforePage.length > beforeLimit;
        page = [...beforePage.slice(-beforeLimit), target, ...afterPage.slice(0, afterLimit)];
      }
    }

    if (page.length === 0) {
      const messages =
        beforeTs != null
          ? await opts.messageStore.getByThreadBefore(resolvedThreadId, beforeTs, limit + 1, beforeId, userId)
          : await opts.messageStore.getByThread(resolvedThreadId, limit + 1, userId);

      // Fetch limit+1 to determine hasMore; drop oldest (first) probe item
      hasMore = messages.length > limit;
      page = hasMore ? messages.slice(1) : messages;
    }

    // Thread 回复仍物理隔离在 branch；主频道响应只派生一个轻量折叠摘要。
    // 这里复用既有 extra.slockThread，不写新的持久化结构。
    const threadReplySummaries = new Map<string, ThreadReplySummary>();
    await Promise.all(
      page.map(async (message) => {
        const link = message.extra?.slockThread;
        if (!link) return;
        const branchMessages = await opts.messageStore.getByThread(link.branchThreadId, 10000, userId);
        threadReplySummaries.set(message.id, deriveThreadReplySummary(message, branchMessages, { type: 'user' }));
      }),
    );

    // Map chat messages (union type allows summary items to be pushed later)
    type TimelineItem = {
      id: string;
      type: 'user' | 'assistant' | 'connector' | 'summary' | 'system';
      catId: string | null;
      content: string;
      timestamp: number;
      summary?: { id: string; topic: string; conclusions: string[]; openQuestions: string[]; createdBy: string };
      [key: string]: unknown;
    };
    const chatItems: TimelineItem[] = page.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      type: (m.catId
        ? isSystemUserMessage(m)
          ? 'system'
          : 'assistant'
        : m.source
          ? 'connector'
          : isSystemUserMessage(m)
            ? 'system'
            : 'user') as TimelineItem['type'],
      catId: m.catId,
      content: m.content,
      ...(m.editedAt ? { editedAt: m.editedAt } : {}),
      ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
      ...(m.toolEvents ? { toolEvents: m.toolEvents } : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(m.origin ? { origin: m.origin } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.extra?.rich ||
      m.extra?.crossPost ||
      m.extra?.stream ||
      m.extra?.targetCats ||
      m.extra?.scheduler ||
      m.extra?.systemKind ||
      m.extra?.agentCommunication ||
      m.extra?.slockThread ||
      m.extra?.reactions
        ? {
            extra: {
              ...(m.extra.rich ? { rich: m.extra.rich } : {}),
              ...(m.extra.crossPost ? { crossPost: m.extra.crossPost } : {}),
              ...(m.extra.stream ? { stream: m.extra.stream } : {}),
              ...(m.extra.targetCats ? { targetCats: m.extra.targetCats } : {}),
              ...(m.extra.scheduler ? { scheduler: m.extra.scheduler } : {}),
              ...(m.extra.systemKind ? { systemKind: m.extra.systemKind } : {}),
              ...(m.extra.agentCommunication ? { agentCommunication: m.extra.agentCommunication } : {}),
              ...(m.extra.slockThread
                ? {
                    slockThread: {
                      ...m.extra.slockThread,
                      ...(threadReplySummaries.get(m.id) ?? {}),
                      replyCount: threadReplySummaries.get(m.id)?.replyCount ?? m.extra.slockThread.replyCount,
                    },
                  }
                : {}),
              ...(m.extra.reactions ? { reactions: m.extra.reactions } : {}),
            },
          }
        : {}),
      ...(m.visibility ? { visibility: m.visibility } : {}),
      ...(m.mentions.length > 0 ? { mentions: [...m.mentions] } : {}),
      ...(m.whisperTo ? { whisperTo: m.whisperTo } : {}),
      ...(m.revealedAt ? { revealedAt: m.revealedAt } : {}),
      ...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
      // 批次1-C 集成收尾：历史接口下发 deliveryStatus，页面刷新后排队徽标可恢复
      // （前端 useChatHistory.ts 已有 forward-compat 透传分支）。
      ...(m.deliveryStatus ? { deliveryStatus: m.deliveryStatus } : {}),
      ...(m.source
        ? {
            source: {
              connector: m.source.connector,
              label: m.source.label,
              icon: m.source.icon,
              ...(m.source.url ? { url: m.source.url } : {}),
              ...(m.source.meta ? { meta: m.source.meta } : {}),
            },
          }
        : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      timestamp: m.timestamp,
    }));

    // F121: Hydrate reply previews for messages with replyTo
    const replyItems = chatItems.filter((item) => item.replyTo);
    if (replyItems.length > 0) {
      const { hydrateReplyPreview } = await import('../domains/cats/services/stores/ports/MessageStore.js');
      await Promise.all(
        replyItems.map(async (item) => {
          // whisper-hygiene: this is a GET /api/messages REST response for the web client,
          // never a cat's context — {type:'user'} is correct (web=owner=authorized).
          const preview = await hydrateReplyPreview(opts.messageStore, item.replyTo as string, { type: 'user' });
          if (preview) {
            item.replyPreview = preview;
          }
        }),
      );
    }

    // #80: Merge active streaming drafts (first page only — no before cursor)
    if (!before && opts.draftStore) {
      const draftStore = opts.draftStore;
      const drafts = (await draftStore.getByThread(userId, resolvedThreadId)).filter(
        (draft) => draft.exposure !== 'private',
      );
      // #80 fix-B diagnostic: trace draft merge for F5 recovery verification
      if (drafts.length > 0) {
        request.log.info(
          { threadId: resolvedThreadId, draftCount: drafts.length, draftIds: drafts.map((d) => d.invocationId) },
          '#80 draft merge: found active drafts',
        );
        // P1-2 dedup: filter out drafts whose invocationId matches a formal message.
        // Build invocationId set from current page first (fast path).
        const formalInvocationIds = new Set(
          page.map((m) => m.extra?.stream?.invocationId).filter((id): id is string => !!id),
        );
        let activeDrafts = drafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        // Cloud R4 P2: if drafts survive page-level dedup, widen the check to cover
        // formal messages pushed off the first page (race window: TTL > page depth).
        // Cloud R5 P2: wider window must always exceed page limit (limit max=200 → worst case 800).
        if (activeDrafts.length > 0 && page.length >= limit) {
          const widerLimit = Math.max(200, limit * 4);
          const wider = await opts.messageStore.getByThread(resolvedThreadId, widerLimit, userId);
          for (const m of wider) {
            const invId = m.extra?.stream?.invocationId;
            if (invId) formalInvocationIds.add(invId);
          }
          activeDrafts = activeDrafts.filter((d) => !formalInvocationIds.has(d.invocationId));
        }
        // F173 Phase A hotfix3 / stream-catchup repair:
        // Draft persistence can outlive its invocation record when an invocation
        // crashes or is replaced before a formal message is written. Filter those
        // orphan drafts from the response. Once the draft is older than the short
        // race window, delete it too so canceled/stuck invocations do not keep
        // reappearing in the first-page merge until the full DraftStore TTL.
        const recoveredDrafts: typeof activeDrafts = [];
        if (activeDrafts.length > 0 && opts.invocationRecordStore) {
          const invocationRecordStore = opts.invocationRecordStore;
          const orphanDrafts: typeof activeDrafts = [];
          const orphanDetails: Array<Record<string, unknown>> = [];
          const checkedActiveDrafts: typeof activeDrafts = [];
          for (const draft of activeDrafts) {
            let record;
            try {
              record = await invocationRecordStore.get(draft.invocationId);
            } catch (error) {
              request.log.warn(
                { err: error, threadId: resolvedThreadId, draftId: draft.invocationId },
                '#80 draft merge: invocation liveness lookup failed',
              );
              checkedActiveDrafts.push(draft);
              continue;
            }
            const recordActive =
              record?.status === 'running' && record.threadId === resolvedThreadId && record.userId === userId;
            let trackerActive = false;
            let trackerSlotStartedAt: number | null = null;
            let trackerUserId: string | null = null;
            if (!recordActive && opts.invocationTracker) {
              try {
                const draftCreatedAt = draft.createdAt ?? draft.updatedAt;
                const trackerSlot = opts.invocationTracker
                  .getActiveSlots(resolvedThreadId)
                  .find((slot) => slot.catId === draft.catId && slot.startedAt <= draftCreatedAt);
                if (trackerSlot) {
                  trackerSlotStartedAt = trackerSlot.startedAt;
                  trackerUserId = opts.invocationTracker.getUserId(resolvedThreadId, draft.catId);
                  trackerActive = trackerUserId === userId;
                }
              } catch (error) {
                request.log.warn(
                  { err: error, threadId: resolvedThreadId, draftId: draft.invocationId, catId: draft.catId },
                  '#80 draft merge: tracker liveness lookup failed',
                );
                checkedActiveDrafts.push(draft);
                continue;
              }
            }
            if (recordActive || trackerActive) {
              checkedActiveDrafts.push(draft);
            } else if (
              record?.status === 'failed' &&
              record.error === 'process_restart' &&
              record.threadId === resolvedThreadId &&
              record.userId === userId
            ) {
              // The process died after the route layer had already persisted
              // streaming content. Surface the recovered draft as a normal
              // assistant message instead of hiding it and asking the user to
              // send the same prompt again.
              recoveredDrafts.push(draft);
            } else {
              orphanDrafts.push(draft);
              orphanDetails.push({
                draftId: draft.invocationId,
                catId: draft.catId,
                draftCreatedAt: draft.createdAt ?? draft.updatedAt,
                draftUpdatedAt: draft.updatedAt,
                recordStatus: record?.status ?? null,
                recordThreadId: record?.threadId ?? null,
                recordUserId: record?.userId ?? null,
                trackerSlotStartedAt,
                trackerUserId,
              });
            }
          }
          activeDrafts = checkedActiveDrafts;

          if (orphanDrafts.length > 0) {
            const now = Date.now();
            const staleOrphanDrafts = orphanDrafts.filter((draft) => {
              const createdAt = draft.createdAt ?? draft.updatedAt;
              return now - createdAt >= ORPHAN_DRAFT_CLEANUP_GRACE_MS;
            });
            if (staleOrphanDrafts.length > 0) {
              const cleanupResults = await Promise.allSettled(
                staleOrphanDrafts.map((draft) => draftStore.delete(userId, resolvedThreadId, draft.invocationId)),
              );
              const cleanupFailureCount = cleanupResults.filter((result) => result.status === 'rejected').length;
              if (cleanupFailureCount > 0) {
                request.log.warn(
                  {
                    threadId: resolvedThreadId,
                    cleanupFailureCount,
                    draftIds: staleOrphanDrafts.map((d) => d.invocationId),
                  },
                  '#80 draft merge: stale orphan draft cleanup had failures',
                );
              }
            }
            const logPayload = {
              threadId: resolvedThreadId,
              orphanCount: orphanDrafts.length,
              draftIds: orphanDrafts.map((d) => d.invocationId),
              orphanDetails,
              cleanup: staleOrphanDrafts.length > 0 ? 'stale_deleted' : 'ttl_or_completion',
              cleanupDeletedCount: staleOrphanDrafts.length,
            };
            request.log.info(logPayload, '#80 draft merge: filtered orphan drafts');
          }
        }
        recoveredDrafts.sort((a, b) => a.updatedAt - b.updatedAt);
        if (recoveredDrafts.length > 0) {
          request.log.info(
            {
              threadId: resolvedThreadId,
              recoveredCount: recoveredDrafts.length,
              draftIds: recoveredDrafts.map((d) => d.invocationId),
            },
            '#134 draft merge: recovered process-restart drafts',
          );
        }
        for (const d of recoveredDrafts) {
          chatItems.push({
            id: `recovered-draft-${d.invocationId}`,
            type: 'assistant',
            catId: d.catId as string | null,
            content: d.content,
            timestamp: d.updatedAt,
            origin: 'stream',
            extra: { stream: { invocationId: d.invocationId }, recoveredDraft: { reason: 'process_restart' } },
            ...(d.toolEvents ? { toolEvents: d.toolEvents } : {}),
            ...(d.thinking ? { thinking: d.thinking } : {}),
          });
        }
        // P2: stable sort by updatedAt for parallel multi-cat drafts
        activeDrafts.sort((a, b) => a.updatedAt - b.updatedAt);
        if (activeDrafts.length > 0) {
          request.log.info(
            { threadId: resolvedThreadId, mergedCount: activeDrafts.length, cats: activeDrafts.map((d) => d.catId) },
            '#80 draft merge: merging drafts into response',
          );
        }
        for (const d of activeDrafts) {
          chatItems.push({
            id: `draft-${d.invocationId}`,
            type: 'assistant',
            catId: d.catId as string | null,
            content: d.content,
            timestamp: d.updatedAt,
            isDraft: true,
            origin: 'stream',
            extra: { stream: { invocationId: d.invocationId } },
            ...(d.toolEvents ? { toolEvents: d.toolEvents } : {}),
            ...(d.thinking ? { thinking: d.thinking } : {}),
          });
        }
      }
    }

    // Auto-summary disabled (clowder-ai#343): regex-based summaries removed from chat flow.
    // Scheduled compaction (SummaryCompactionTask) continues for memory infrastructure.

    return {
      messages: chatItems,
      hasMore,
    };
  });
};

/** Hold the invocation-level placeholder only when no cat produced a published turn. */
export function hasFreshnessHold(persistenceContext: Pick<PersistenceContext, 'egressByCat'>): boolean {
  const entries = Object.values(persistenceContext.egressByCat ?? {});
  return (
    entries.some((entry) => entry.disposition === 'held') &&
    !entries.some((entry) => entry.disposition === 'published' && !entry.replayed)
  );
}

/** Allow invocation-wide fanout only for legacy output or at least one newly published turn. */
export function hasNewFreshnessPublication(persistenceContext: Pick<PersistenceContext, 'egressByCat'>): boolean {
  const entries = Object.values(persistenceContext.egressByCat ?? {});
  return entries.length === 0 || entries.some((entry) => entry.disposition === 'published' && !entry.replayed);
}

/** Allow per-cat side effects only when that cat is legacy or produced a new publication. */
export function isNewFreshnessPublicationForCat(
  persistenceContext: Pick<PersistenceContext, 'egressByCat'>,
  catId: string,
): boolean {
  const verdict = persistenceContext.egressByCat?.[catId];
  return !verdict || (verdict.disposition === 'published' && !verdict.replayed);
}

/** Schedule only actionable stdout reviews; terminal holds remain visible for manual attention. */
export function enqueueFreshnessReviewsFromPersistence(
  persistenceContext: Pick<PersistenceContext, 'egressByCat'>,
  queueProcessor: Pick<QueueProcessor, 'enqueueFreshnessReview'> | undefined,
): number {
  if (!queueProcessor) return 0;
  let enqueued = 0;
  for (const egress of Object.values(persistenceContext.egressByCat ?? {})) {
    if (
      egress.disposition !== 'held' ||
      egress.holdStatus !== 'held' ||
      !egress.freshnessReview ||
      egress.freshnessReview.status !== 'held'
    ) {
      continue;
    }
    if (queueProcessor.enqueueFreshnessReview(egress.freshnessReview).outcome === 'enqueued') enqueued += 1;
  }
  return enqueued;
}

/** @internal exported for testing — do not use outside of test. */
export async function cleanupStreamingOnFailure(
  threadId: string,
  invocationId: string,
  streamStartPromise: Promise<void> | undefined,
  opts: MessagesRoutesOptions,
  logger: typeof log,
): Promise<void> {
  if (!opts.streamingHook) return;
  try {
    if (streamStartPromise) {
      await Promise.race([streamStartPromise, new Promise<void>((r) => setTimeout(r, STREAM_START_TIMEOUT_MS))]);
    }
    await opts.streamingHook.onStreamEnd(threadId, '', invocationId);
    await opts.streamingHook.cleanupPlaceholders?.(threadId, invocationId);
  } catch (err) {
    logger.warn({ err, threadId }, '[messages] cleanupStreamingOnFailure failed');
  }
}

/** @internal exported for testing — do not use outside of test. */
export async function deliverOutboundFromWeb(
  threadId: string,
  primaryCat: string,
  invocationId: string,
  collectedTextParts: string[],
  outboundTurns: Array<{ catId: string; textParts: string[]; richBlocks?: unknown[] }>,
  persistenceContext: PersistenceContext,
  streamStartPromise: Promise<void> | undefined,
  opts: MessagesRoutesOptions,
  logger: typeof log,
): Promise<void> {
  const egressEntries = Object.values(persistenceContext.egressByCat ?? {});
  const hasNewPublication = egressEntries.some((entry) => entry.disposition === 'published' && !entry.replayed);
  const fullySuppressed =
    egressEntries.length > 0 &&
    !hasNewPublication &&
    egressEntries.some((entry) => entry.disposition === 'held' || entry.disposition === 'discarded' || entry.replayed);
  const deliverableTurns = outboundTurns.filter((turn) => {
    const verdict = persistenceContext.egressByCat?.[turn.catId];
    return !verdict || (verdict.disposition === 'published' && !verdict.replayed);
  });
  const finalContent =
    outboundTurns.length > 0 ? flattenTurnTextParts(deliverableTurns) : flattenTextParts(collectedTextParts);

  if (opts.streamingHook) {
    if (streamStartPromise) {
      await Promise.race([
        streamStartPromise,
        new Promise<void>((resolve) => setTimeout(resolve, STREAM_START_TIMEOUT_MS)),
      ]);
    }
  }

  if (hasFreshnessHold(persistenceContext)) {
    await opts.streamingHook?.onStreamHold?.(threadId, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.onStreamHold failed');
    });
    return;
  }
  if (fullySuppressed) {
    await opts.streamingHook?.cleanupPlaceholders?.(threadId, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.cleanupPlaceholders failed (suppressed)');
    });
    return;
  }

  if (opts.streamingHook) {
    await opts.streamingHook.onStreamEnd(threadId, finalContent, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.onStreamEnd failed');
    });
  }

  const hasContent = collectedTextParts.length > 0 || deliverableTurns.length > 0;
  if (!opts.outboundHook || !hasContent) {
    if (opts.streamingHook?.cleanupPlaceholders) {
      await opts.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
        logger.warn({ err, threadId }, '[messages] StreamingHook.cleanupPlaceholders failed (silent)');
      });
    }
    return;
  }

  let threadMeta: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string } | undefined;
  try {
    const LOOKUP_TIMEOUT_MS = 2000;
    const thread = opts.threadStore?.get(threadId);
    if (thread) {
      const lookupPromise = Promise.resolve(thread).catch(() => undefined);
      const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS));
      const resolved = await Promise.race([lookupPromise, timeout]);
      if (resolved) {
        const frontendBase = resolveFrontendBaseUrl(process.env);
        threadMeta = {
          threadShortId: threadId.slice(0, 15),
          threadTitle: resolved.title ?? undefined,
          deepLinkUrl: buildThreadDeepLink(frontendBase, threadId),
        };
      }
    }
  } catch {
    logger.warn({ threadId }, '[messages] threadMeta lookup failed');
  }

  const DELIVER_TIMEOUT_MS = 10_000;
  const nonEmptyTurns = deliverableTurns.filter(
    (t) => t.textParts.length > 0 || (t.richBlocks && t.richBlocks.length > 0),
  );

  let deliveryFailed = false;
  const inflightDeliverPromises: Promise<void>[] = [];

  if (nonEmptyTurns.length > 1) {
    for (const turn of nonEmptyTurns) {
      const turnContent = turn.textParts.join('');
      const deliverPromise = opts.outboundHook.deliver(threadId, turnContent, turn.catId, turn.richBlocks, threadMeta);
      inflightDeliverPromises.push(deliverPromise);
      try {
        await Promise.race([
          deliverPromise,
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
        ]);
      } catch (err) {
        deliveryFailed = true;
        logger.error({ err, threadId, catId: turn.catId }, '[messages] Outbound delivery error');
      }
    }
  } else if (nonEmptyTurns.length === 1) {
    const turn = nonEmptyTurns[0];
    const richBlocks = persistenceContext.richBlocks ?? turn.richBlocks;
    const deliverPromise = opts.outboundHook.deliver(threadId, finalContent, turn.catId, richBlocks, threadMeta);
    inflightDeliverPromises.push(deliverPromise);
    try {
      await Promise.race([
        deliverPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
      ]);
    } catch (err) {
      deliveryFailed = true;
      logger.error({ err, threadId }, '[messages] Outbound delivery error');
    }
  } else {
    const richBlocks = persistenceContext.richBlocks;
    if (richBlocks) {
      const deliverPromise = opts.outboundHook.deliver(threadId, finalContent, primaryCat, richBlocks, threadMeta);
      inflightDeliverPromises.push(deliverPromise);
      try {
        await Promise.race([
          deliverPromise,
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('deliver timeout')), DELIVER_TIMEOUT_MS)),
        ]);
      } catch (err) {
        deliveryFailed = true;
        logger.error({ err, threadId }, '[messages] Outbound delivery error');
      }
    }
  }

  if (!deliveryFailed && opts.streamingHook?.cleanupPlaceholders) {
    await opts.streamingHook.cleanupPlaceholders(threadId, invocationId).catch((err) => {
      logger.warn({ err, threadId }, '[messages] StreamingHook.cleanupPlaceholders failed');
    });
  } else if (deliveryFailed && opts.streamingHook?.cleanupPlaceholders) {
    const cleanupFn = opts.streamingHook.cleanupPlaceholders.bind(opts.streamingHook);
    Promise.allSettled(inflightDeliverPromises).then((results) => {
      if (results.every((r) => r.status === 'fulfilled')) {
        cleanupFn(threadId, invocationId).catch((err) => {
          logger.warn({ err, threadId }, '[messages] Late-success placeholder cleanup failed');
        });
      }
    });
  }

  // F151: Signal adapters that this invocation's delivery batch is complete.
  // chainDone = no more active or queued invocations for this thread.
  if (opts.streamingHook?.notifyDeliveryBatchDone) {
    const threadStillBusy =
      (opts.invocationTracker?.has(threadId) ?? false) || (opts.queueProcessor?.isThreadBusy(threadId) ?? false);
    await opts.streamingHook.notifyDeliveryBatchDone(threadId, !threadStillBusy).catch((err) => {
      logger.warn({ err, threadId }, '[messages] notifyDeliveryBatchDone failed');
    });
  }
}
