/**
 * Authorization Types (猫猫授权系统)
 * 猫猫向铲屎官请求权限 — 动态审批 + 持久化规则
 */

import type { CatId } from './ids.js';

// ---- Capability receipt v1 ----

/**
 * Exact execution subject authorized by a capability receipt.
 *
 * `argumentDigest` is SHA-256 over canonical JSON. Raw tool arguments are not
 * persisted in the receipt or its audit trail.
 */
export interface CapabilityIntentV1 {
  readonly version: 1;
  readonly executorId: string;
  readonly action: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly userId: string;
  readonly taskId?: string;
  readonly argumentDigest: string;
}

export type CapabilityReceiptStatus = 'issued' | 'consumed' | 'expired' | 'revoked';

/** Server-side receipt record. The bearer secret is deliberately absent. */
export interface CapabilityReceiptV1 extends CapabilityIntentV1 {
  readonly receiptId: string;
  readonly tokenHash: string;
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly status: CapabilityReceiptStatus;
  readonly approvedBy: string;
  readonly approvalScope: RespondScope;
  readonly matchedRuleId?: string;
  readonly consumedAt?: number;
  readonly consumedBy?: string;
}

export type CapabilityReceiptConsumeFailureCode =
  | 'not_found'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'already_used'
  | 'scope_mismatch';

export type CapabilityReceiptConsumeResult =
  | { readonly ok: true; readonly receipt: CapabilityReceiptV1 }
  | { readonly ok: false; readonly code: CapabilityReceiptConsumeFailureCode };

export interface CapabilityReceiptIssueResult {
  /** One-time secret. Callers must never log, persist, or expose it to a model. */
  readonly bearer: string;
  readonly receipt: CapabilityReceiptV1;
}

// ---- 请求/响应契约 ----

/** 猫猫发起的权限请求 (Callback POST body) */
export interface PermissionRequest {
  readonly invocationId: string;
  readonly callbackToken: string;
  readonly action: string;
  readonly reason: string;
  readonly context?: string;
}

/** API 返回给猫猫的响应 */
export interface PermissionResponse {
  readonly status: 'granted' | 'denied' | 'pending';
  readonly requestId?: string;
  readonly reason?: string;
}

/** 猫猫查询 pending 结果时的响应 */
export interface PermissionStatusResponse {
  readonly requestId: string;
  readonly status: 'waiting' | 'granted' | 'denied';
  readonly action: string;
  readonly createdAt: number;
  readonly reason?: string;
  readonly scope?: RespondScope;
  readonly respondedAt?: number;
}

// ---- 持久化数据模型 ----

/** 待审批请求记录 (可序列化，存 Redis/内存) */
export interface PendingRequestRecord {
  readonly requestId: string;
  readonly invocationId: string;
  readonly catId: CatId;
  readonly threadId: string;
  readonly action: string;
  readonly reason: string;
  readonly context?: string;
  readonly createdAt: number;
  readonly status: 'waiting' | 'granted' | 'denied';
  readonly respondedAt?: number;
  readonly respondReason?: string;
  readonly respondScope?: RespondScope;
  /** Verified invocation owner for high-privilege approval binding. */
  readonly requesterUserId?: string;
  /** A1 exact capability subject; raw executor arguments are never stored. */
  readonly capabilityIntent?: CapabilityIntentV1;
  readonly capabilitySubjectDigest?: string;
  readonly requestExpiresAt?: number;
  readonly respondedBy?: string;
  readonly grantClaimedAt?: number;
}

/** 铲屎官审批时的 scope 选择 */
export type RespondScope = 'once' | 'thread' | 'global';

/**
 * 持久化授权规则 (类似 Claude Code allow/deny 记忆)
 * scope 只有 thread | global — 'once' 不存规则
 */
export interface AuthorizationRule {
  readonly id: string;
  readonly catId: CatId | '*';
  readonly action: string;
  readonly scope: 'thread' | 'global';
  readonly decision: 'allow' | 'deny';
  readonly threadId?: string;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly reason?: string;
}

/** 审计日志条目 */
export interface AuthorizationAuditEntry {
  readonly id: string;
  readonly requestId: string;
  readonly invocationId: string;
  readonly catId: CatId;
  readonly threadId: string;
  readonly action: string;
  readonly reason: string;
  readonly decision: 'allow' | 'deny' | 'pending';
  readonly scope?: RespondScope;
  readonly decidedBy?: string;
  readonly decidedAt?: number;
  readonly matchedRuleId?: string;
  readonly createdAt: number;
}

// ---- WebSocket 事件 ----

/** Server → Client: 授权请求推送 */
export interface AuthorizationRequestEvent {
  readonly requestId: string;
  readonly catId: CatId;
  readonly threadId: string;
  readonly action: string;
  readonly reason: string;
  readonly context?: string;
}

/** Client → Server: 铲屎官响应 */
export interface AuthorizationRespondEvent {
  readonly requestId: string;
  readonly granted: boolean;
  readonly scope: RespondScope;
  readonly reason?: string;
}
