import type Database from 'better-sqlite3';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isSummaryCompactionEligibleMessage } from '../cats/services/stores/visibility.js';
import { getAbstractiveSummaryModelId } from './AbstractiveSummaryClient.js';
import { hasHighValueSignal, SUMMARY_CONFIG } from './summary-config.js';

interface SummaryStateRow {
  thread_id: string;
  last_summarized_message_id: string | null;
  pending_message_count: number;
  pending_token_count: number;
  pending_signal_flags: number;
  summary_type: string;
  last_abstractive_at: string | null;
  abstractive_token_count: number | null;
  carry_over: number; // 1 = has backlog from previous batch, bypasses cooldown
}

interface ThreadLastActivity {
  threadId: string;
  lastMessageAt: number; // epoch ms
}

export interface SummaryCompactionMessage {
  id: string;
  content: string;
  catId?: string;
  timestamp: number;
}

/**
 * 扫描结果与模型输入分离：watermark 必须覆盖被隐私规则排除的消息，
 * 否则全 whisper 批次会在每次调度时被无限重扫。
 */
export interface SummaryCompactionBatch {
  messages: SummaryCompactionMessage[];
  scannedThroughMessageId: string | null;
  excludedPrivateCount: number;
}

/** Build the privacy-safe model input while retaining the raw scan cursor. */
export function buildSummaryCompactionBatch(messages: readonly StoredMessage[]): SummaryCompactionBatch {
  return {
    messages: messages.filter(isSummaryCompactionEligibleMessage).map((message) => ({
      id: message.id,
      content: message.content,
      catId: message.catId ?? undefined,
      timestamp: message.timestamp,
    })),
    scannedThroughMessageId: messages.at(-1)?.id ?? null,
    excludedPrivateCount: messages.filter(
      (message) => message.visibility === 'whisper' && !message.revealedAt,
    ).length,
  };
}

export interface SummaryCompactionDeps {
  /** SQLite database (evidence.sqlite) */
  db: Database.Database;
  /** Feature flag check */
  enabled: () => boolean;
  /** Get last message timestamp for a thread (for quiet window check) */
  getThreadLastActivity: (threadId: string) => Promise<ThreadLastActivity | null>;
  /** Get messages after watermark for a thread */
  getMessagesAfterWatermark: (
    threadId: string,
    afterMessageId: string | null,
    limit: number,
  ) => Promise<SummaryCompactionBatch>;
  /** Call Opus API to generate abstractive summary + candidates */
  generateAbstractive: (input: {
    previousSummary: string | null;
    messages: SummaryCompactionMessage[];
    threadId: string;
  }) => Promise<{
    segments: Array<{
      summary: string;
      topicKey: string;
      topicLabel: string;
      boundaryReason: string;
      boundaryConfidence: 'high' | 'medium' | 'low';
      fromMessageId: string;
      toMessageId: string;
      messageCount: number;
      relatedSegmentIds?: string[];
      candidates?: unknown[];
    }>;
  } | null>;
  /** Re-embed a thread after summary update (for semantic search). Optional — fail-open. */
  reEmbed?: (anchor: string, text: string) => Promise<void>;
  /** H-3: Submit durable candidate to MarkerQueue for knowledge emergence pipeline. Optional — fail-open. */
  submitCandidate?: (candidate: {
    kind: string;
    title: string;
    claim: string;
    confidence: string;
    threadId: string;
  }) => Promise<void>;
  /**
   * Optional thread allowlist for safe canary rollout.
   * null/empty means all eligible threads.
   */
  getThreadAllowlist?: () => ReadonlySet<string> | null;
  /** Logger */
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

/** Check eligibility rule (KD-43 unified): quietWindow AND (count OR tokens OR signal) AND (cooldown OR signal-bypass) */
function isEligible(
  state: SummaryStateRow,
  lastActivity: ThreadLastActivity | null,
  config: typeof SUMMARY_CONFIG,
): boolean {
  const now = Date.now();

  // Quiet window check: thread must be idle
  if (lastActivity) {
    const quietMs = now - lastActivity.lastMessageAt;
    if (quietMs < config.quietWindowMinutes * 60 * 1000) return false;
  }

  const highSignal = hasHighValueSignal(state.pending_signal_flags);

  // P1 R4 fix (砚砚 review): carry_over is a "backlog continuation" total bypass —
  // skips BOTH volume gate AND cooldown. A tail of 5 messages from a 205-message
  // batch should not be blocked by the 20-message threshold.
  const isCarryOver = state.carry_over === 1;

  // Volume or signal check (carry-over bypasses)
  const volumeOk =
    isCarryOver ||
    state.pending_message_count >= config.pendingMessageThreshold ||
    state.pending_token_count >= config.pendingTokenThreshold ||
    highSignal;
  if (!volumeOk) return false;

  // Cooldown check (high-signal OR carry-over bypasses)
  const bypassCooldown = highSignal || isCarryOver;
  if (!bypassCooldown && state.last_abstractive_at) {
    const hoursSince = (now - new Date(state.last_abstractive_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < config.cooldownHours) return false;
  }

  return true;
}

/** Exported for F139 SummaryCompactionTaskSpec to reuse per-thread processing */
export async function processThread(
  state: SummaryStateRow,
  deps: SummaryCompactionDeps,
  config: typeof SUMMARY_CONFIG,
): Promise<boolean> {
  // Full eligibility check (with async lastActivity)
  const lastActivity = await deps.getThreadLastActivity(state.thread_id);
  if (!isEligible(state, lastActivity, config)) return false;

  // Get messages after watermark
  const batch = await deps.getMessagesAfterWatermark(state.thread_id, state.last_summarized_message_id, 200);
  const { messages, scannedThroughMessageId, excludedPrivateCount } = batch;
  if (!scannedThroughMessageId) return false;

  // 全部消息都被过滤时也推进扫描水位；绝不调用摘要模型，也不生成空摘要段。
  if (messages.length === 0) {
    deps.db
      .prepare(
        `UPDATE summary_state SET
         last_summarized_message_id = ?,
         pending_message_count = 0,
         pending_token_count = 0,
         pending_signal_flags = 0,
         carry_over = 0
         WHERE thread_id = ?`,
      )
      .run(scannedThroughMessageId, state.thread_id);

    await refreshCarryOver(state.thread_id, scannedThroughMessageId, deps);
    deps.logger.info(
      `[summary-compaction] thread ${state.thread_id}: no public messages, watermark → ${scannedThroughMessageId}`,
    );
    return true;
  }

  // Get current summary from evidence_docs (read model)
  const evidenceRow = deps.db
    .prepare('SELECT summary FROM evidence_docs WHERE anchor = ?')
    .get(`thread-${state.thread_id}`) as { summary: string | null } | undefined;

  // Call Opus API
  const result = await deps.generateAbstractive({
    previousSummary: evidenceRow?.summary ?? null,
    messages,
    threadId: state.thread_id,
  });

  if (!result) {
    deps.logger.info(`[summary-compaction] thread ${state.thread_id}: Opus returned null (fail-open)`);
    return false;
  }

  // Dual-write: INSERT segments + UPDATE evidence_docs
  const now = new Date().toISOString();
  const privateExclusionNotice = '（部分私密消息未纳入摘要）';
  const segments = result.segments.map((segment) => ({
    ...segment,
    summary:
      excludedPrivateCount > 0 && !segment.summary.trimEnd().endsWith(privateExclusionNotice)
        ? `${segment.summary.trimEnd()}\n\n${privateExclusionNotice}`
        : segment.summary,
  }));
  const mergedSummary = segments.map((s) => s.summary).join('\n\n');
  const totalTokens = mergedSummary.length / 4;
  const modelId = getAbstractiveSummaryModelId();

  const insertSegment = deps.db.prepare(`
    INSERT INTO summary_segments
    (id, thread_id, level, from_message_id, to_message_id, message_count,
     summary, topic_key, topic_label, boundary_reason, boundary_confidence,
     related_segment_ids, candidates, model_id, prompt_version, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = deps.db.transaction(() => {
    // 1. INSERT summary_segments (append-only)
    for (const seg of segments) {
      const segId = `seg-${state.thread_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertSegment.run(
        segId,
        state.thread_id,
        1, // L1
        seg.fromMessageId,
        seg.toMessageId,
        seg.messageCount,
        seg.summary,
        seg.topicKey,
        seg.topicLabel,
        seg.boundaryReason,
        seg.boundaryConfidence,
        seg.relatedSegmentIds ? JSON.stringify(seg.relatedSegmentIds) : null,
        seg.candidates ? JSON.stringify(seg.candidates) : null,
        modelId,
        'g2-thread-abstract-v1',
        now,
      );
    }

    // 2. UPSERT evidence_docs.summary (read model)
    // Some old/high-cost threads may not have an evidence_docs row yet. The
    // summary segment is still useful for route context, so create the read
    // model instead of letting UPDATE silently affect zero rows.
    deps.db
      .prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_hash, updated_at)
       VALUES (?, 'thread', 'active', ?, ?, ?, ?)
       ON CONFLICT(anchor) DO UPDATE SET
         summary = excluded.summary,
         source_hash = excluded.source_hash,
         updated_at = excluded.updated_at`,
      )
      .run(
        `thread-${state.thread_id}`,
        `Thread ${state.thread_id}`,
        mergedSummary,
        `abstractive-${Date.now()}`,
        now,
      );

    // 3. UPDATE summary_state watermark (carry_over = 0, will be set to 1 below if backlog remains)
    deps.db
      .prepare(
        `UPDATE summary_state SET
        last_summarized_message_id = ?,
        pending_message_count = 0,
        pending_token_count = 0,
        pending_signal_flags = 0,
        carry_over = 0,
        summary_type = 'abstractive',
        last_abstractive_at = ?,
        abstractive_token_count = ?
       WHERE thread_id = ?`,
      )
      .run(scannedThroughMessageId, now, Math.round(totalTokens), state.thread_id);
  });

  tx();

  // Re-embed this thread with new abstractive summary (for semantic search)
  if (deps.reEmbed) {
    try {
      const title =
        (
          deps.db.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').get(`thread-${state.thread_id}`) as
            | { title: string }
            | undefined
        )?.title ?? '';
      await deps.reEmbed(`thread-${state.thread_id}`, `${title} ${mergedSummary}`);
    } catch {
      // fail-open
    }
  }

  // H-3: Submit durable candidates to MarkerQueue for knowledge emergence pipeline
  if (deps.submitCandidate) {
    for (const seg of segments) {
      const candidates = (seg.candidates ?? []) as Array<{
        kind: string;
        title: string;
        claim: string;
        confidence?: string;
      }>;
      for (const c of candidates) {
        try {
          await deps.submitCandidate({
            kind: c.kind,
            title: c.title,
            claim: c.claim,
            confidence: c.confidence ?? 'inferred',
            threadId: state.thread_id,
          });
          deps.logger.info(`[summary-compaction] submitted candidate: [${c.kind}] ${c.title}`);
        } catch (err) {
          // fail-open: candidate submission failure doesn't block compaction
          deps.logger.error(`[summary-compaction] submitCandidate failed for [${c.kind}] ${c.title}: ${err}`);
        }
      }
    }
  }

  // P1 R2 fix (砚砚 review): after compaction, check if there are STILL more messages
  // beyond the new watermark. If so, re-populate pending signal so the thread stays
  // in the scheduling pool. Otherwise a delta > 200 messages would silently stall.
  await refreshCarryOver(state.thread_id, scannedThroughMessageId, deps);

  deps.logger.info(
    `[summary-compaction] thread ${state.thread_id}: ${segments.length} segment(s), watermark → ${scannedThroughMessageId}`,
  );
  return true;
}

async function refreshCarryOver(
  threadId: string,
  scannedThroughMessageId: string,
  deps: SummaryCompactionDeps,
): Promise<void> {
  try {
    const remaining = await deps.getMessagesAfterWatermark(threadId, scannedThroughMessageId, 1);
    if (!remaining.scannedThroughMessageId) return;

    // Re-count actual remaining (up to 200 to avoid scanning everything).
    const remainingBatch = await deps.getMessagesAfterWatermark(threadId, scannedThroughMessageId, 200);
    const estimatedTokens = remainingBatch.messages.reduce(
      (sum, message) => sum + Math.ceil(message.content.length / 4),
      0,
    );
    const pendingCount = remainingBatch.messages.length + remainingBatch.excludedPrivateCount;
    // carry_over=1 itself绕过 volume gate，因此即使下一批全是系统噪音，也能继续推进水位。
    deps.db
      .prepare(
        `UPDATE summary_state SET pending_message_count = ?, pending_token_count = ?, carry_over = 1
         WHERE thread_id = ?`,
      )
      .run(pendingCount, estimatedTokens, threadId);
    deps.logger.info(`[summary-compaction] thread ${threadId}: ${pendingCount} messages still pending after batch`);
  } catch {
    // fail-open: worst case is one missed tick, next append will re-trigger
  }
}
