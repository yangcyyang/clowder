/** Redis-backed capability receipt v1 store. */

import type {
  CapabilityIntentV1,
  CapabilityReceiptConsumeFailureCode,
  CapabilityReceiptConsumeResult,
  CapabilityReceiptIssueResult,
  CapabilityReceiptStatus,
  CapabilityReceiptV1,
  CatId,
  RespondScope,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ICapabilityReceiptStore,
  IssueCapabilityReceiptInput,
} from '../ports/CapabilityReceiptStore.js';
import {
  capabilityReceiptHashesEqual,
  createCapabilityReceiptIssue,
  digestCapabilityIntent,
  parseCapabilityReceiptBearer,
  sha256Hex,
} from '../ports/CapabilityReceiptStore.js';
import { AuthReceiptKeys } from '../redis-keys/authorization-keys.js';

const DEFAULT_PHYSICAL_GRACE_MS = 60_000;

const CREATE_RECEIPT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
local fields = {}
for i = 2, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
redis.call('HSET', KEYS[1], unpack(fields))
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

const CONSUME_RECEIPT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'not_found'
end
if redis.call('HGET', KEYS[1], 'tokenHash') ~= ARGV[1] then
  return 'invalid'
end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'consumed' then
  return 'already_used'
end
if status == 'revoked' then
  return 'revoked'
end
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
local now = tonumber(ARGV[3])
if status == 'expired' or not expiresAt or now > expiresAt then
  redis.call('HSET', KEYS[1], 'status', 'expired')
  return 'expired'
end
if redis.call('HGET', KEYS[1], 'subjectDigest') ~= ARGV[2] then
  return 'scope_mismatch'
end
redis.call('HSET', KEYS[1], 'status', 'consumed', 'consumedAt', ARGV[3], 'consumedBy', ARGV[4])
return 'ok'
`;

function serializeReceipt(receipt: CapabilityReceiptV1): string[] {
  const fields = [
    'version',
    String(receipt.version),
    'receiptId',
    receipt.receiptId,
    'tokenHash',
    receipt.tokenHash,
    'requestId',
    receipt.requestId,
    'subjectDigest',
    receipt.subjectDigest,
    'executorId',
    receipt.executorId,
    'action',
    receipt.action,
    'invocationId',
    receipt.invocationId,
    'threadId',
    receipt.threadId,
    'catId',
    receipt.catId,
    'userId',
    receipt.userId,
    'argumentDigest',
    receipt.argumentDigest,
    'issuedAt',
    String(receipt.issuedAt),
    'expiresAt',
    String(receipt.expiresAt),
    'status',
    receipt.status,
    'approvedBy',
    receipt.approvedBy,
    'approvalScope',
    receipt.approvalScope,
  ];
  if (receipt.taskId) fields.push('taskId', receipt.taskId);
  if (receipt.matchedRuleId) fields.push('matchedRuleId', receipt.matchedRuleId);
  if (receipt.consumedAt != null) fields.push('consumedAt', String(receipt.consumedAt));
  if (receipt.consumedBy) fields.push('consumedBy', receipt.consumedBy);
  return fields;
}

function hydrateReceipt(data: Record<string, string>): CapabilityReceiptV1 {
  return {
    version: 1,
    receiptId: data.receiptId!,
    tokenHash: data.tokenHash!,
    requestId: data.requestId!,
    subjectDigest: data.subjectDigest!,
    executorId: data.executorId!,
    action: data.action!,
    invocationId: data.invocationId!,
    threadId: data.threadId!,
    catId: data.catId! as CatId,
    userId: data.userId!,
    ...(data.taskId ? { taskId: data.taskId } : {}),
    argumentDigest: data.argumentDigest!,
    issuedAt: Number(data.issuedAt),
    expiresAt: Number(data.expiresAt),
    status: data.status! as CapabilityReceiptStatus,
    approvedBy: data.approvedBy!,
    approvalScope: data.approvalScope! as RespondScope,
    ...(data.matchedRuleId ? { matchedRuleId: data.matchedRuleId } : {}),
    ...(data.consumedAt ? { consumedAt: Number(data.consumedAt) } : {}),
    ...(data.consumedBy ? { consumedBy: data.consumedBy } : {}),
  };
}

export class RedisCapabilityReceiptStore implements ICapabilityReceiptStore {
  private readonly now: () => number;
  private readonly physicalGraceMs: number;

  constructor(
    private readonly redis: RedisClient,
    options?: { now?: () => number; physicalGraceMs?: number },
  ) {
    this.now = options?.now ?? Date.now;
    this.physicalGraceMs = Math.max(1, Math.floor(options?.physicalGraceMs ?? DEFAULT_PHYSICAL_GRACE_MS));
  }

  async issue(input: IssueCapabilityReceiptInput): Promise<CapabilityReceiptIssueResult> {
    const now = this.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const issued = createCapabilityReceiptIssue(input, now);
      const physicalTtlMs = Math.max(1, input.expiresAt - now + this.physicalGraceMs);
      const fields = serializeReceipt(issued.receipt);
      const created = (await this.redis.eval(
        CREATE_RECEIPT_LUA,
        1,
        AuthReceiptKeys.detail(issued.receipt.receiptId),
        String(physicalTtlMs),
        ...fields,
      )) as number;
      if (created === 1) return issued;
    }
    throw new Error('AUTH_RECEIPT_ID_CONFLICT');
  }

  async consume(
    bearer: string,
    expectedIntent: CapabilityIntentV1,
    consumedBy: string,
  ): Promise<CapabilityReceiptConsumeResult> {
    const parsed = parseCapabilityReceiptBearer(bearer);
    if (!parsed) return { ok: false, code: 'invalid' };

    const key = AuthReceiptKeys.detail(parsed.receiptId);
    const tokenHash = await this.redis.hget(key, 'tokenHash');
    if (tokenHash === null) return { ok: false, code: 'not_found' };
    const presentedHash = sha256Hex(bearer);
    if (!capabilityReceiptHashesEqual(tokenHash, presentedHash)) {
      return { ok: false, code: 'invalid' };
    }
    if (consumedBy !== expectedIntent.executorId) {
      return { ok: false, code: 'scope_mismatch' };
    }

    const result = (await this.redis.eval(
      CONSUME_RECEIPT_LUA,
      1,
      key,
      presentedHash,
      digestCapabilityIntent(expectedIntent),
      String(this.now()),
      consumedBy,
    )) as CapabilityReceiptConsumeFailureCode | 'ok';

    if (result !== 'ok') return { ok: false, code: result };
    const data = await this.redis.hgetall(key);
    if (!data.receiptId) return { ok: false, code: 'not_found' };
    return { ok: true, receipt: hydrateReceipt(data) };
  }
}
