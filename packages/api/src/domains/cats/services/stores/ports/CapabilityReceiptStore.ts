/**
 * Capability receipt v1 store.
 *
 * The receipt is an opaque bearer (`arv1.<id>.<secret>`). Only a SHA-256 hash
 * of that bearer is persisted. Every receipt is bound to one exact execution
 * intent and may be consumed at most once.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CapabilityIntentV1,
  CapabilityReceiptConsumeResult,
  CapabilityReceiptIssueResult,
  CapabilityReceiptV1,
  RespondScope,
} from '@cat-cafe/shared';

export interface IssueCapabilityReceiptInput {
  readonly requestId: string;
  readonly intent: CapabilityIntentV1;
  readonly approvedBy: string;
  readonly approvalScope: RespondScope;
  readonly expiresAt: number;
  readonly matchedRuleId?: string;
}

export interface ICapabilityReceiptStore {
  issue(input: IssueCapabilityReceiptInput): CapabilityReceiptIssueResult | Promise<CapabilityReceiptIssueResult>;
  consume(
    bearer: string,
    expectedIntent: CapabilityIntentV1,
    consumedBy: string,
  ): CapabilityReceiptConsumeResult | Promise<CapabilityReceiptConsumeResult>;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function canonicalizeJson(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Capability arguments must contain only finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Capability arguments must not contain cycles');
    seen.add(value);
    const result = `[${value.map((entry) => canonicalizeJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const proto = Object.getPrototypeOf(record);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('Capability arguments must be plain JSON objects');
    }
    if (seen.has(record)) throw new TypeError('Capability arguments must not contain cycles');
    seen.add(record);
    const fields = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) throw new TypeError('Capability arguments must not contain undefined');
        return `${JSON.stringify(key)}:${canonicalizeJson(entry, seen)}`;
      });
    seen.delete(record);
    return `{${fields.join(',')}}`;
  }
  throw new TypeError(`Capability arguments contain unsupported value type: ${typeof value}`);
}

/** RFC 8785-style subset for plain JSON values: sorted object keys, no whitespace. */
export function canonicalizeCapabilityArguments(value: JsonValue | unknown): string {
  return canonicalizeJson(value, new WeakSet<object>());
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestCapabilityArguments(value: JsonValue | unknown): string {
  return sha256Hex(canonicalizeCapabilityArguments(value));
}

export function digestCapabilityIntent(intent: CapabilityIntentV1): string {
  return digestCapabilityArguments({
    action: intent.action,
    argumentDigest: intent.argumentDigest,
    catId: intent.catId,
    executorId: intent.executorId,
    invocationId: intent.invocationId,
    // Keep the v1 claim shape fixed so absent and explicit-null cannot drift.
    taskId: intent.taskId ?? null,
    threadId: intent.threadId,
    userId: intent.userId,
    version: intent.version,
  });
}

function cloneReceipt(receipt: CapabilityReceiptV1): CapabilityReceiptV1 {
  return { ...receipt };
}

export function parseCapabilityReceiptBearer(bearer: string): { receiptId: string } | null {
  const match = /^arv1\.([^.]+)\.([A-Za-z0-9_-]+)$/.exec(bearer);
  if (!match?.[1] || !match[2]) return null;
  return { receiptId: match[1] };
}

export function capabilityReceiptHashesEqual(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function createCapabilityReceiptIssue(
  input: IssueCapabilityReceiptInput,
  issuedAt: number,
): CapabilityReceiptIssueResult {
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= issuedAt) {
    throw new RangeError('Capability receipt expiresAt must be in the future');
  }

  const receiptId = randomUUID();
  const bearer = `arv1.${receiptId}.${randomBytes(32).toString('base64url')}`;
  const receipt: CapabilityReceiptV1 = {
    ...input.intent,
    receiptId,
    tokenHash: sha256Hex(bearer),
    requestId: input.requestId,
    subjectDigest: digestCapabilityIntent(input.intent),
    issuedAt,
    expiresAt: input.expiresAt,
    status: 'issued',
    approvedBy: input.approvedBy,
    approvalScope: input.approvalScope,
    ...(input.matchedRuleId ? { matchedRuleId: input.matchedRuleId } : {}),
  };
  return { bearer, receipt };
}

export class CapabilityReceiptStore implements ICapabilityReceiptStore {
  private readonly receipts = new Map<string, CapabilityReceiptV1>();
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
  }

  issue(input: IssueCapabilityReceiptInput): CapabilityReceiptIssueResult {
    const issuedAt = this.now();
    const { bearer, receipt } = createCapabilityReceiptIssue(input, issuedAt);
    this.receipts.set(receipt.receiptId, receipt);
    return { bearer, receipt: cloneReceipt(receipt) };
  }

  consume(
    bearer: string,
    expectedIntent: CapabilityIntentV1,
    consumedBy: string,
  ): CapabilityReceiptConsumeResult {
    const parsed = parseCapabilityReceiptBearer(bearer);
    if (!parsed) return { ok: false, code: 'invalid' };

    const existing = this.receipts.get(parsed.receiptId);
    if (!existing) return { ok: false, code: 'not_found' };
    if (!capabilityReceiptHashesEqual(existing.tokenHash, sha256Hex(bearer))) {
      return { ok: false, code: 'invalid' };
    }
    if (existing.status === 'consumed') return { ok: false, code: 'already_used' };
    if (existing.status === 'revoked') return { ok: false, code: 'revoked' };

    const now = this.now();
    if (existing.status === 'expired' || now > existing.expiresAt) {
      if (existing.status !== 'expired') {
        this.receipts.set(existing.receiptId, { ...existing, status: 'expired' });
      }
      return { ok: false, code: 'expired' };
    }

    if (consumedBy !== expectedIntent.executorId || existing.subjectDigest !== digestCapabilityIntent(expectedIntent)) {
      return { ok: false, code: 'scope_mismatch' };
    }

    const consumed: CapabilityReceiptV1 = {
      ...existing,
      status: 'consumed',
      consumedAt: now,
      consumedBy,
    };
    this.receipts.set(existing.receiptId, consumed);
    return { ok: true, receipt: cloneReceipt(consumed) };
  }
}
