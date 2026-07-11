/**
 * Message Store
 * 内存消息存储，供 MCP 回传工具 get_thread_context / get_pending_mentions 使用
 *
 * 有界数组实现，超过 MAX_MESSAGES 时丢弃最旧消息。
 */

import { randomUUID } from 'node:crypto';
import type {
  CatId,
  ConnectorSource,
  MessageContent,
  ReplyPreview,
  RichMessageExtra,
  SchedulerMessageExtra,
} from '@cat-cafe/shared';
import type { MessageMetadata } from '../../types.js';
import { isSystemUserMessage } from '../visibility.js';
// Single source of truth: ThreadStore.ts owns DEFAULT_THREAD_ID
import { DEFAULT_THREAD_ID } from './ThreadStore.js';
export { DEFAULT_THREAD_ID };

/**
 * F117: Check if a message should be visible in timeline/history/context.
 * Legacy messages (no deliveryStatus) are treated as delivered.
 */
export function isDelivered(msg: StoredMessage): boolean {
  return !msg.deliveryStatus || msg.deliveryStatus === 'delivered';
}

/**
 * A tool event recorded during agent invocation (tool_use / tool_result).
 * Persisted alongside the assistant message so history reload can display them.
 */
export interface StoredToolEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  timestamp: number;
}

/**
 * Monotonic per-thread append sequence used by Freshness Hold.
 *
 * The value is intentionally opaque outside MessageStore. Callers must pass it
 * back unchanged instead of comparing it as a JavaScript number.
 */
export type ThreadAppendWatermark = string & { readonly __brand: 'ThreadAppendWatermark' };

export type MessageClass = 'substantive' | 'status';

export interface FreshnessAudience {
  readonly kind: 'cat';
  readonly catId: CatId;
}

export interface FreshnessDelta {
  readonly observedWatermark: ThreadAppendWatermark;
  readonly messages: readonly StoredMessage[];
  readonly truncated: boolean;
}

export type ConditionalAppendResult =
  | {
      readonly outcome: 'appended';
      readonly message: StoredMessage;
      readonly committedWatermark: ThreadAppendWatermark;
      /** The idempotency index returned a previously committed message. */
      readonly replayed?: true;
    }
  | {
      readonly outcome: 'stale';
      readonly baseline: ThreadAppendWatermark;
      readonly observedWatermark: ThreadAppendWatermark;
    };

/**
 * A stored message entry (after append — threadId always present)
 */
export interface StoredMessage {
  id: string;
  /** Thread this message belongs to (always set after append) */
  threadId: string;
  userId: string;
  /** null = user message, CatId = cat message */
  catId: CatId | null;
  content: string;
  /** Freshness classification. Undefined is substantive for backward compatibility. */
  messageClass?: MessageClass;
  /** Per-thread append sequence assigned only to freshness-relevant messages. */
  appendWatermark?: ThreadAppendWatermark;
  /** Rich content blocks (text, images, code). When absent, use content string. */
  contentBlocks?: readonly MessageContent[];
  /** Tool events recorded during agent invocation (for history replay). */
  toolEvents?: readonly StoredToolEvent[];
  /** Provider/model metadata (for cat messages) */
  metadata?: MessageMetadata;
  /** F022+F052+F098-C1+F153-F: Extensible extra data (rich blocks, stream metadata, cross-post origin, explicit targets, tracing pointers) */
  extra?: {
    rich?: RichMessageExtra;
    stream?: { invocationId: string };
    crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
    targetCats?: string[];
    scheduler?: SchedulerMessageExtra['scheduler'];
    tracing?: { traceId: string; spanId: string; parentSpanId?: string };
    systemKind?: 'a2a_routing' | 'progress_heartbeat';
    /** Slock 归档导入：批次消息对应的 thread 回复分支。 */
    slockThread?: { branchThreadId: string; replyCount: number };
    /** P2-3: Aggregated emoji reactions for this message. */
    reactions?: { emoji: string; users: string[]; updatedAt: number }[];
  };
  /** CatIds mentioned in this message */
  mentions: readonly CatId[];
  /** F057-C2: Whether this message mentions the user (@user / @铲屎官) */
  mentionsUser?: boolean;
  timestamp: number;
  /** Timestamp when a user message was edited in place. */
  editedAt?: number;
  /** F045: Extended thinking content (accumulated from CLI thinking blocks). Persisted for F5 recovery. */
  thinking?: string;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech), briefing = F148 Phase E context briefing (non-routing) */
  origin?: 'stream' | 'callback' | 'briefing';
  /** F35: Message visibility. Default 'public' (undefined = public for backward compat) */
  visibility?: 'public' | 'whisper';
  /** F35: Whisper recipients. Only meaningful when visibility='whisper' */
  whisperTo?: readonly CatId[];
  /** F35: Timestamp when a whisper was revealed (made public). Present = revealed */
  revealedAt?: number;
  /** F097: External connector source. Present = connector message (not user/cat) */
  source?: ConnectorSource;
  /** F098-D: Timestamp when a queued message was actually dequeued and processed by a cat */
  deliveredAt?: number;
  /** F117: Delivery lifecycle status. undefined = legacy (treated as delivered) */
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
  /** F121: ID of the message this is replying to (same thread only) */
  replyTo?: string;
  /** ADR-008 D3: Soft delete timestamp (present = deleted) */
  deletedAt?: number;
  /** ADR-008 D3: Who deleted this message */
  deletedBy?: string;
  /** ADR-008 D3: Hard delete marker — content wiped, skeleton only */
  _tombstone?: true;
}

/**
 * Input for appending a message. threadId is optional (defaults to 'default').
 */
export type AppendMessageInput = Omit<StoredMessage, 'id' | 'threadId'> & {
  threadId?: string;
  /**
   * Optional idempotency token scoped to (userId + threadId + key).
   * Reusing the same token returns the original stored message.
   */
  idempotencyKey?: string;
  /** Internal append-only marker for the private queued half of a hold-release transition. */
  freshnessReviewPublication?: true;
};

/**
 * Stream-only metadata collected by route-serial after a callback message was
 * already persisted. It may augment the callback bubble, but must not replace
 * its canonical content/origin.
 */
export interface StreamMetadataAugmentInput {
  toolEvents?: readonly StoredToolEvent[];
  metadata?: MessageMetadata;
  thinking?: string;
  replyTo?: string;
  mentionsUser?: boolean;
  extra?: NonNullable<StoredMessage['extra']>;
}

function richBlockDedupeKey(block: unknown, index: number): string {
  if (block && typeof block === 'object' && 'id' in block) {
    const id = (block as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return `id:${id}`;
  }
  try {
    return `json:${JSON.stringify(block)}`;
  } catch {
    return `index:${index}`;
  }
}

function mergeRichExtra(existing?: RichMessageExtra, incoming?: RichMessageExtra): RichMessageExtra | undefined {
  if (!existing && !incoming) return undefined;
  const blocks = [...(existing?.blocks ?? [])];
  const seen = new Set(blocks.map((block, index) => richBlockDedupeKey(block, index)));
  for (const block of incoming?.blocks ?? []) {
    const key = richBlockDedupeKey(block, blocks.length);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }
  return { v: 1, blocks };
}

export function mergeMessageExtra(
  existing: StoredMessage['extra'] | undefined,
  incoming: StoredMessage['extra'] | undefined,
): StoredMessage['extra'] | undefined {
  if (!existing && !incoming) return undefined;
  const merged = { ...(existing ?? {}), ...(incoming ?? {}) };
  const rich = mergeRichExtra(existing?.rich, incoming?.rich);
  if (rich) merged.rich = rich;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeStoredToolEvents(
  existing: readonly StoredToolEvent[] | undefined,
  incoming: readonly StoredToolEvent[] | undefined,
): readonly StoredToolEvent[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  if (!existing || existing.length === 0) return [...incoming];
  const merged = [...existing];
  const seen = new Set(merged.map((event) => event.id));
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export function applyStreamMetadataAugment(msg: StoredMessage, patch: StreamMetadataAugmentInput): StoredMessage {
  if (patch.thinking && patch.thinking.trim().length > 0) {
    msg.thinking = patch.thinking;
  }
  if (patch.metadata) {
    msg.metadata = { ...(msg.metadata ?? {}), ...patch.metadata };
  }
  if (patch.toolEvents && patch.toolEvents.length > 0) {
    msg.toolEvents = mergeStoredToolEvents(msg.toolEvents, patch.toolEvents);
  }
  if (patch.replyTo && !msg.replyTo) {
    msg.replyTo = patch.replyTo;
  }
  if (patch.mentionsUser) {
    msg.mentionsUser = true;
  }
  if (patch.extra) {
    const mergedExtra = mergeMessageExtra(msg.extra, patch.extra);
    if (mergedExtra) msg.extra = mergedExtra;
  }
  return msg;
}

/**
 * Common interface for message stores (in-memory and Redis).
 * Methods that may hit Redis are async; in-memory returns immediately.
 */
export interface IMessageStore {
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
  append(msg: AppendMessageInput): StoredMessage | Promise<StoredMessage>;
  /** Capture the latest active substantive append visible to this audience. */
  captureFreshnessWatermark(
    threadId: string,
    audience: FreshnessAudience,
  ): ThreadAppendWatermark | Promise<ThreadAppendWatermark>;
  /** Read active substantive messages appended after a previously captured watermark. */
  getFreshnessDelta(
    threadId: string,
    audience: FreshnessAudience,
    after: ThreadAppendWatermark,
    through?: ThreadAppendWatermark,
    limit?: number,
  ): FreshnessDelta | Promise<FreshnessDelta>;
  /** Compare the audience watermark and append in one linearization point. */
  appendIfFresh(
    msg: AppendMessageInput,
    gate: { baseline: ThreadAppendWatermark; audience: FreshnessAudience; groupId?: string },
  ): ConditionalAppendResult | Promise<ConditionalAppendResult>;
  /** Get a single message by its ID. Returns null if not found. */
  getById(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** Internal capability: raw lookup reserved for recovering a hold's released publication. */
  getByIdForFreshnessRelease(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  getRecent(limit?: number, userId?: string): StoredMessage[] | Promise<StoredMessage[]>;
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest). */
  getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getBefore(
    timestamp: number,
    limit?: number,
    userId?: string,
    beforeId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThread(threadId: string, limit?: number, userId?: string): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Delete all messages in a thread (cascade delete support) */
  deleteByThread(threadId: string): number | Promise<number>;
  /** ADR-008 D3: Soft delete — set deletedAt/deletedBy. Returns null if not found. */
  softDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Hard delete — wipe content, keep tombstone. Returns null if not found. */
  hardDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Restore a soft-deleted message. Rejects tombstones. Returns null if not found/not deleted. */
  restore(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** F35: Reveal whispers in a thread sent by userId (set revealedAt). Returns count revealed. */
  revealWhispers(threadId: string, userId: string): number | Promise<number>;
  /** F096: Update message extra data (for interactive block state persistence). Returns null if not found. */
  updateExtra(
    id: string,
    extra: NonNullable<StoredMessage['extra']>,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** Update plain-text message content in place. Returns null if not found. */
  updateContent(id: string, content: string, editedAt: number): StoredMessage | null | Promise<StoredMessage | null>;
  /** #1462: augment callback-persisted messages with metadata collected only on the stream path. */
  augmentStreamMetadata(
    id: string,
    patch: StreamMetadataAugmentInput,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** F098-D: Mark a queued message as delivered (set deliveredAt). Returns null if not found. */
  markDelivered(id: string, deliveredAt: number): StoredMessage | null | Promise<StoredMessage | null>;
  /** Deliver the private queued half of a freshness hold only after the hold release CAS succeeds. */
  releaseFreshnessReviewPublication(
    id: string,
    deliveredAt: number,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** F117: Mark a queued message as canceled (withdraw/clear). Returns null if not found. */
  markCanceled(id: string): StoredMessage | null | Promise<StoredMessage | null>;
}

/** Max messages to keep in memory */
const MAX_MESSAGES = 2000;

/** Default limit for queries */
const DEFAULT_LIMIT = 50;

function watermarkFromBigInt(value: bigint): ThreadAppendWatermark {
  return value.toString(10) as ThreadAppendWatermark;
}

function parseWatermark(value: ThreadAppendWatermark): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid freshness watermark: ${value}`);
  }
  return BigInt(value);
}

/** Structural freshness classification. Content text is deliberately ignored. */
export function isFreshnessProtectedPublication(
  msg: Pick<
    StoredMessage,
    'userId' | 'catId' | 'messageClass' | 'origin' | 'extra' | 'deliveryStatus' | 'deletedAt' | '_tombstone'
  >,
): boolean {
  if (msg.messageClass === 'status') return false;
  if (msg.deliveryStatus === 'canceled') return false;
  if (msg.deletedAt || msg._tombstone) return false;
  if (isSystemUserMessage(msg)) return false;
  if (msg.origin === 'briefing') return false;
  if (msg.extra?.systemKind) return false;
  return true;
}

export function isFreshnessRelevantMessage(
  msg: Pick<
    StoredMessage,
    'userId' | 'catId' | 'messageClass' | 'origin' | 'extra' | 'deliveryStatus' | 'deletedAt' | '_tombstone'
  >,
): boolean {
  return isFreshnessProtectedPublication(msg);
}

/** A review publication remains a delta barrier until its hold release CAS delivers it. */
export function isPendingFreshnessReviewPublication(
  deliveryStatus: StoredMessage['deliveryStatus'],
  freshnessReviewPublication: boolean,
): boolean {
  return deliveryStatus === 'queued' && freshnessReviewPublication;
}

function freshnessGroupId(msg: Pick<StoredMessage, 'extra'>): string | undefined {
  const groupId = msg.extra?.stream?.invocationId?.trim();
  return groupId || undefined;
}

/**
 * In-memory bounded message store.
 */
/**
 * Generate a sortable message ID: zero-padded timestamp + sequence + UUID suffix.
 * Lexicographic order matches insertion order even within the same millisecond.
 */
let _seq = 0;
export function generateSortableId(timestamp: number): string {
  const ts = String(timestamp).padStart(16, '0');
  const seq = String(_seq++).padStart(6, '0');
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${seq}-${suffix}`;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private readonly maxMessages: number;
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly freshnessSequenceByThread = new Map<string, bigint>();
  private readonly freshnessPublicByThread = new Map<string, Map<string, bigint>>();
  private readonly freshnessWhisperByThread = new Map<string, Map<string, Map<string, bigint>>>();
  private readonly freshnessReviewPublicationIds = new Set<string>();
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;

  constructor(options?: {
    maxMessages?: number;
    onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
  }) {
    this.maxMessages = options?.maxMessages ?? MAX_MESSAGES;
    this.onAppend = options?.onAppend;
  }

  private notifyAppend(stored: StoredMessage): void {
    if (!this.onAppend) return;
    try {
      void Promise.resolve(this.onAppend(stored)).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  private buildIdempotencyIndexKey(userId: string, threadId: string, idempotencyKey?: string): string | null {
    if (!idempotencyKey) return null;
    return `${userId}:${threadId}:${idempotencyKey}`;
  }

  private pruneIdempotencyIndexForMessageIds(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const removedIds = new Set(messageIds);
    for (const [key, value] of this.idempotencyIndex.entries()) {
      if (removedIds.has(value)) {
        this.idempotencyIndex.delete(key);
      }
    }
  }

  private nextFreshnessWatermark(threadId: string): ThreadAppendWatermark {
    const next = (this.freshnessSequenceByThread.get(threadId) ?? 0n) + 1n;
    this.freshnessSequenceByThread.set(threadId, next);
    return watermarkFromBigInt(next);
  }

  private indexFreshnessMessage(msg: StoredMessage): void {
    if (!msg.appendWatermark || !isFreshnessRelevantMessage(msg)) return;
    const revision = parseWatermark(msg.appendWatermark);
    if (msg.visibility === 'whisper' && !msg.revealedAt) {
      const byCat = this.freshnessWhisperByThread.get(msg.threadId) ?? new Map<string, Map<string, bigint>>();
      this.freshnessWhisperByThread.set(msg.threadId, byCat);
      for (const catId of msg.whisperTo ?? []) {
        const entries = byCat.get(catId) ?? new Map<string, bigint>();
        byCat.set(catId, entries);
        entries.set(msg.id, revision);
      }
      return;
    }

    const entries = this.freshnessPublicByThread.get(msg.threadId) ?? new Map<string, bigint>();
    this.freshnessPublicByThread.set(msg.threadId, entries);
    entries.set(msg.id, revision);
  }

  private removeFreshnessMessage(msg: StoredMessage): void {
    this.freshnessPublicByThread.get(msg.threadId)?.delete(msg.id);
    const byCat = this.freshnessWhisperByThread.get(msg.threadId);
    if (!byCat) return;
    for (const entries of byCat.values()) entries.delete(msg.id);
  }

  private freshnessEntries(threadId: string, audience: FreshnessAudience): Map<string, bigint> {
    const entries = new Map<string, bigint>();
    for (const [id, revision] of this.freshnessPublicByThread.get(threadId) ?? []) {
      entries.set(id, revision);
    }
    if (audience.kind === 'cat') {
      for (const [id, revision] of this.freshnessWhisperByThread.get(threadId)?.get(audience.catId) ?? []) {
        entries.set(id, revision);
      }
    }
    return entries;
  }

  captureFreshnessWatermark(threadId: string, audience: FreshnessAudience): ThreadAppendWatermark {
    let latest = 0n;
    for (const revision of this.freshnessEntries(threadId, audience).values()) {
      if (revision > latest) latest = revision;
    }
    return watermarkFromBigInt(latest);
  }

  getFreshnessDelta(
    threadId: string,
    audience: FreshnessAudience,
    after: ThreadAppendWatermark,
    through?: ThreadAppendWatermark,
    limit: number = DEFAULT_LIMIT,
  ): FreshnessDelta {
    const afterRevision = parseWatermark(after);
    const requestedWatermark = through ?? this.captureFreshnessWatermark(threadId, audience);
    const throughRevision = parseWatermark(requestedWatermark);
    const candidates = [...this.freshnessEntries(threadId, audience).entries()]
      .filter(([, revision]) => revision > afterRevision && revision <= throughRevision)
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const messages: StoredMessage[] = [];
    let privateBarrier = false;
    for (const [id] of candidates) {
      const message = this.getByIdRaw(id);
      if (!message || !isFreshnessRelevantMessage(message)) continue;
      if (isPendingFreshnessReviewPublication(message.deliveryStatus, this.freshnessReviewPublicationIds.has(id))) {
        privateBarrier = true;
        break;
      }
      messages.push(message);
      if (messages.length >= safeLimit) break;
    }
    const lastReturned = messages[messages.length - 1];
    return {
      // Never advance a review cursor past a message that was not returned.
      observedWatermark: lastReturned?.appendWatermark ?? after,
      messages,
      truncated: privateBarrier || candidates.length > messages.length,
    };
  }

  appendIfFresh(
    msg: AppendMessageInput,
    gate: { baseline: ThreadAppendWatermark; audience: FreshnessAudience; groupId?: string },
  ): ConditionalAppendResult {
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(msg.userId, threadId, msg.idempotencyKey);
    if (idempotencyIndexKey) {
      const existingId = this.idempotencyIndex.get(idempotencyIndexKey);
      const existing = existingId ? this.getByIdRaw(existingId) : null;
      if (existing) {
        return {
          outcome: 'appended',
          message: existing,
          committedWatermark: existing.appendWatermark ?? this.captureFreshnessWatermark(threadId, gate.audience),
          replayed: true,
        };
      }
    }

    if (isFreshnessProtectedPublication(msg)) {
      const observedWatermark = this.captureFreshnessWatermark(threadId, gate.audience);
      if (parseWatermark(observedWatermark) > parseWatermark(gate.baseline)) {
        const baseline = parseWatermark(gate.baseline);
        const hasIndependentAppend = [...this.freshnessEntries(threadId, gate.audience).entries()].some(
          ([id, revision]) => {
            if (revision <= baseline) return false;
            const existing = this.getByIdRaw(id);
            return !gate.groupId || !existing || freshnessGroupId(existing) !== gate.groupId;
          },
        );
        if (hasIndependentAppend) {
          return {
            outcome: 'stale',
            baseline: gate.baseline,
            observedWatermark,
          };
        }
      }
    }

    const message = this.append(msg);
    return {
      outcome: 'appended',
      message,
      committedWatermark: message.appendWatermark ?? this.captureFreshnessWatermark(threadId, gate.audience),
    };
  }

  /**
   * Append a message to the store. Returns the stored message with generated id.
   */
  append(msg: AppendMessageInput): StoredMessage {
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(msg.userId, threadId, msg.idempotencyKey);
    if (idempotencyIndexKey) {
      const existingId = this.idempotencyIndex.get(idempotencyIndexKey);
      if (existingId) {
        const existing = this.getByIdRaw(existingId);
        if (existing) {
          return existing;
        }
        this.idempotencyIndex.delete(idempotencyIndexKey);
      }
    }

    const { idempotencyKey, appendWatermark: _ignoredAppendWatermark, freshnessReviewPublication, ...payload } = msg;
    void idempotencyKey;
    void _ignoredAppendWatermark;
    const stored: StoredMessage = {
      ...payload,
      id: generateSortableId(msg.timestamp),
      threadId,
    };
    if (isFreshnessRelevantMessage(stored)) {
      stored.appendWatermark = this.nextFreshnessWatermark(threadId);
    }
    this.messages.push(stored);
    if (freshnessReviewPublication) this.freshnessReviewPublicationIds.add(stored.id);
    this.indexFreshnessMessage(stored);
    if (idempotencyIndexKey) {
      this.idempotencyIndex.set(idempotencyIndexKey, stored.id);
    }

    // Trim oldest if over capacity
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.maxMessages);
      this.messages = this.messages.slice(-this.maxMessages);
      for (const entry of removed) {
        this.removeFreshnessMessage(entry);
        this.freshnessReviewPublicationIds.delete(entry.id);
      }
      this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    }

    // Queued review publications are private until markDelivered completes.
    if (isDelivered(stored)) this.notifyAppend(stored);

    return stored;
  }

  /**
   * Get a single message by its ID. Returns null if not found.
   */
  getById(id: string): StoredMessage | null {
    const message = this.getByIdRaw(id);
    if (
      message &&
      isPendingFreshnessReviewPublication(message.deliveryStatus, this.freshnessReviewPublicationIds.has(message.id))
    ) {
      return null;
    }
    return message;
  }

  getByIdForFreshnessRelease(id: string): StoredMessage | null {
    return this.getByIdRaw(id);
  }

  private getByIdRaw(id: string): StoredMessage | null {
    return this.messages.find((message) => message.id === id) ?? null;
  }

  /**
   * Get the most recent N messages.
   * When userId is provided, only returns messages from that user's session.
   */
  getRecent(limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue;
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get mentions for a specific cat, ascending (oldest first after cursor).
   * When afterMessageId is provided, only returns mentions with id > afterMessageId.
   * Returns the oldest N matches (ascending) — R4 P1 contract.
   */
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk forward (ascending) to collect oldest-first after cursor
    for (let i = 0; i < this.messages.length && matches.length < n; i++) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (afterMessageId && msg.id <= afterMessageId) continue;
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches; // Already ascending
  }

  /**
   * Get mentions for a specific cat, taking the most recent N matches.
   * Returns ascending order (oldest→newest) within the returned window.
   */
  getRecentMentionsFor(catId: CatId, limit?: number, userId?: string, threadId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches.reverse();
  }

  /**
   * Get messages before a given cursor (cursor-based pagination).
   * When beforeId is provided, also excludes messages at the same timestamp
   * with id >= beforeId (composite cursor to handle same-millisecond messages).
   * Returns messages in chronological order (oldest first).
   */
  getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk backwards from most recent, collecting messages before the cursor
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (msg.timestamp > timestamp) continue;
      if (msg.timestamp === timestamp) {
        // Same timestamp: use id as tiebreaker (skip if id >= beforeId)
        if (!beforeId || msg.id >= beforeId) continue;
      }
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }

    // Reverse so oldest first
    return matches.reverse();
  }

  /**
   * Get the most recent N messages in a specific thread.
   */
  getByThread(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get messages in a thread after a specific message ID (exclusive), oldest first.
   * If afterId is undefined, returns messages from thread start.
   * If limit is undefined, returns all matches.
   */
  getByThreadAfter(threadId: string, afterId?: string, limit?: number, userId?: string): StoredMessage[] {
    const bounded = Number.isFinite(limit as number) && (limit as number) > 0;
    const max = bounded ? (limit as number) : Number.MAX_SAFE_INTEGER;
    const matches: StoredMessage[] = [];

    for (let i = 0; i < this.messages.length && matches.length < max; i++) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (afterId && msg.id <= afterId) continue;
      if (!isDelivered(msg)) continue;
      matches.push(msg);
    }

    return matches;
  }

  /**
   * Get messages in a thread before a given cursor (cursor-based pagination).
   */
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (msg.timestamp > timestamp) continue;
      if (msg.timestamp === timestamp) {
        if (!beforeId || msg.id >= beforeId) continue;
      }
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  deleteByThread(threadId: string): number {
    const removed = this.messages.filter((m) => m.threadId === threadId);
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.threadId !== threadId);
    this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    for (const entry of removed) this.freshnessReviewPublicationIds.delete(entry.id);
    // Keep the monotonic sequence as an ABA tombstone. A still-running old
    // invocation must not become fresh again if the same thread id is reused.
    this.freshnessPublicByThread.delete(threadId);
    this.freshnessWhisperByThread.delete(threadId);
    return before - this.messages.length;
  }

  /**
   * ADR-008 D3: Soft delete — mark a message as deleted without removing it.
   * Returns the updated message or null if not found.
   */
  softDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    this.removeFreshnessMessage(msg);
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   * Irreversible: content is permanently lost.
   */
  hardDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    delete msg.editedAt;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    this.removeFreshnessMessage(msg);
    this.freshnessReviewPublicationIds.delete(id);
    this.pruneIdempotencyIndexForMessageIds([id]);
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message.
   * Rejects tombstones (hard-deleted) — those are irreversible.
   */
  restore(id: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    delete msg.deletedAt;
    delete msg.deletedBy;
    if (isFreshnessRelevantMessage(msg)) {
      msg.appendWatermark = this.nextFreshnessWatermark(msg.threadId);
      this.indexFreshnessMessage(msg);
    }
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  revealWhispers(threadId: string, userId: string): number {
    const now = Date.now();
    let count = 0;
    for (const msg of this.messages) {
      if (msg.threadId !== threadId) continue;
      if (msg.userId !== userId) continue;
      if (msg.visibility === 'whisper' && !msg.revealedAt) {
        this.removeFreshnessMessage(msg);
        msg.revealedAt = now;
        if (isFreshnessRelevantMessage(msg)) {
          msg.appendWatermark = this.nextFreshnessWatermark(msg.threadId);
          this.indexFreshnessMessage(msg);
        }
        count++;
      }
    }
    return count;
  }

  /**
   * F096: Update message extra data (for interactive block state persistence).
   */
  updateExtra(id: string, extra: NonNullable<StoredMessage['extra']>): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.extra = extra;
    return msg;
  }

  updateContent(id: string, content: string, editedAt: number): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.content = content;
    msg.editedAt = editedAt;
    return msg;
  }

  augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    return applyStreamMetadataAugment(msg, patch);
  }

  /**
   * F098-D: Mark a queued message as delivered (set deliveredAt timestamp).
   */
  markDelivered(id: string, deliveredAt: number): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return msg; // only transition queued → delivered
    if (this.freshnessReviewPublicationIds.has(id)) return msg;
    return this.deliverQueuedMessage(msg, deliveredAt);
  }

  releaseFreshnessReviewPublication(id: string, deliveredAt: number): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return msg;
    if (!this.freshnessReviewPublicationIds.has(id)) return msg;
    return this.deliverQueuedMessage(msg, deliveredAt);
  }

  private deliverQueuedMessage(msg: StoredMessage, deliveredAt: number): StoredMessage {
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    this.freshnessReviewPublicationIds.delete(msg.id);
    this.notifyAppend(msg);
    return msg;
  }

  /** F117: Mark a queued message as canceled (withdraw/clear). */
  markCanceled(id: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.deliveryStatus = 'canceled';
    this.freshnessReviewPublicationIds.delete(id);
    this.removeFreshnessMessage(msg);
    return msg;
  }

  /**
   * Current message count (for testing)
   */
  get size(): number {
    return this.messages.length;
  }
}

const PREVIEW_MAX_LENGTH = 80;

/**
 * F121: Hydrate a reply preview from message store.
 * Returns null if the referenced message doesn't exist.
 * Returns { deleted: true } if the parent was soft/hard-deleted.
 */
export async function hydrateReplyPreview(store: IMessageStore, replyToId: string): Promise<ReplyPreview | null> {
  const parent = await store.getById(replyToId);
  if (!parent || !isDelivered(parent)) return null;

  if (parent.deletedAt || parent._tombstone) {
    return { senderCatId: parent.catId, content: '', deleted: true };
  }

  const truncated =
    parent.content.length > PREVIEW_MAX_LENGTH ? parent.content.slice(0, PREVIEW_MAX_LENGTH) : parent.content;

  return {
    senderCatId: parent.catId,
    content: truncated,
    ...(parent.extra?.scheduler?.hiddenTrigger ? { kind: 'scheduler_trigger' as const } : {}),
  };
}
