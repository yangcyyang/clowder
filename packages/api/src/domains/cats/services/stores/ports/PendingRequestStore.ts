/**
 * Pending Request Store
 * 持久化待审批队列 — 铲屎官离线时请求不丢失
 *
 * 只存可序列化的 PendingRequestRecord，不存运行时 waiter。
 */

import type { CapabilityIntentV1, CatId, PendingRequestRecord, RespondScope } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';

export interface CreatePendingInput {
  readonly invocationId: string;
  readonly catId: CatId;
  readonly threadId: string;
  readonly action: string;
  readonly reason: string;
  readonly context?: string;
  readonly requesterUserId?: string;
  readonly capabilityIntent?: CapabilityIntentV1;
  readonly capabilitySubjectDigest?: string;
  readonly requestExpiresAt?: number;
}

export interface IPendingRequestStore {
  create(input: CreatePendingInput): PendingRequestRecord | Promise<PendingRequestRecord>;
  get(requestId: string): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
  respond(
    requestId: string,
    decision: 'granted' | 'denied',
    scope: RespondScope,
    reason?: string,
    respondedBy?: string,
  ): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
  listWaiting(threadId?: string): PendingRequestRecord[] | Promise<PendingRequestRecord[]>;
  findCapabilityRequest(
    subjectDigest: string,
    requesterUserId: string,
    now: number,
  ): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
  claimCapabilityGrant(
    requestId: string,
    subjectDigest: string,
    requesterUserId: string,
    claimedAt: number,
  ): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
}

const DEFAULT_MAX = 1000;

export class PendingRequestStore implements IPendingRequestStore {
  private records = new Map<string, PendingRequestRecord>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX;
  }

  create(input: CreatePendingInput): PendingRequestRecord {
    if (this.records.size >= this.maxRecords) {
      // Evict oldest resolved first, then oldest waiting
      let evicted = false;
      for (const [id, rec] of this.records) {
        if (rec.status !== 'waiting') {
          this.records.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const firstKey = this.records.keys().next().value;
        if (firstKey) this.records.delete(firstKey);
      }
    }

    const record: PendingRequestRecord = {
      requestId: generateSortableId(Date.now()),
      invocationId: input.invocationId,
      catId: input.catId,
      threadId: input.threadId,
      action: input.action,
      reason: input.reason,
      ...(input.context ? { context: input.context } : {}),
      ...(input.requesterUserId ? { requesterUserId: input.requesterUserId } : {}),
      ...(input.capabilityIntent ? { capabilityIntent: { ...input.capabilityIntent } } : {}),
      ...(input.capabilitySubjectDigest ? { capabilitySubjectDigest: input.capabilitySubjectDigest } : {}),
      ...(input.requestExpiresAt !== undefined ? { requestExpiresAt: input.requestExpiresAt } : {}),
      createdAt: Date.now(),
      status: 'waiting',
    };
    this.records.set(record.requestId, record);
    return record;
  }

  get(requestId: string): PendingRequestRecord | null {
    return this.records.get(requestId) ?? null;
  }

  respond(
    requestId: string,
    decision: 'granted' | 'denied',
    scope: RespondScope,
    reason?: string,
    respondedBy?: string,
  ): PendingRequestRecord | null {
    const existing = this.records.get(requestId);
    if (!existing || existing.status !== 'waiting') return null;
    if (existing.requestExpiresAt !== undefined && existing.requestExpiresAt < Date.now()) return null;

    const updated: PendingRequestRecord = {
      ...existing,
      status: decision,
      respondedAt: Date.now(),
      respondScope: scope,
      ...(reason ? { respondReason: reason } : {}),
      ...(respondedBy ? { respondedBy } : {}),
    };
    this.records.set(requestId, updated);
    return updated;
  }

  listWaiting(threadId?: string): PendingRequestRecord[] {
    const result: PendingRequestRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.status !== 'waiting') continue;
      if (threadId && rec.threadId !== threadId) continue;
      result.push(rec);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  findCapabilityRequest(subjectDigest: string, requesterUserId: string, now: number): PendingRequestRecord | null {
    const matches = [...this.records.values()].filter(
      (record) =>
        record.capabilitySubjectDigest === subjectDigest &&
        record.requesterUserId === requesterUserId &&
        record.requestExpiresAt !== undefined &&
        record.requestExpiresAt >= now &&
        (record.status === 'waiting' || (record.status === 'granted' && record.grantClaimedAt === undefined)),
    );
    matches.sort((left, right) => {
      if (left.status === 'granted' && right.status !== 'granted') return -1;
      if (right.status === 'granted' && left.status !== 'granted') return 1;
      return right.createdAt - left.createdAt;
    });
    return matches[0] ?? null;
  }

  claimCapabilityGrant(
    requestId: string,
    subjectDigest: string,
    requesterUserId: string,
    claimedAt: number,
  ): PendingRequestRecord | null {
    const existing = this.records.get(requestId);
    if (
      !existing ||
      existing.status !== 'granted' ||
      existing.grantClaimedAt !== undefined ||
      existing.capabilitySubjectDigest !== subjectDigest ||
      existing.requesterUserId !== requesterUserId ||
      existing.requestExpiresAt === undefined ||
      existing.requestExpiresAt < claimedAt
    ) {
      return null;
    }
    const claimed = { ...existing, grantClaimedAt: claimedAt };
    this.records.set(requestId, claimed);
    return claimed;
  }

  get size(): number {
    return this.records.size;
  }
}
