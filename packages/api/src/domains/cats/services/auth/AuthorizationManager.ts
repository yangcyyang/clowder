/**
 * Authorization Manager
 * 猫猫授权系统核心 — 规则匹配 + pending 队列 + inFlightWaiters
 *
 * 两层设计（缅因猫 review P1-3 要求）:
 * - 持久化层: PendingRequestStore (Redis/内存) + RuleStore + AuditStore
 * - 运行时层: inFlightWaiters (Map<requestId, {resolve, timer}>) — 不可序列化
 */

import type {
  CapabilityIntentV1,
  CatId,
  PendingRequestRecord,
  PermissionRequest,
  PermissionResponse,
  RespondScope,
} from '@cat-cafe/shared';
import type { Server as SocketIOServer } from 'socket.io';
import { getPushNotificationService } from '../push/PushNotificationService.js';
import type { IAuthorizationAuditStore } from '../stores/ports/AuthorizationAuditStore.js';
import type { IAuthorizationRuleStore } from '../stores/ports/AuthorizationRuleStore.js';
import { digestCapabilityIntent } from '../stores/ports/CapabilityReceiptStore.js';
import type { IPendingRequestStore } from '../stores/ports/PendingRequestStore.js';
import type { CapabilityApproval } from './CapabilityReceiptExecutionGate.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CAPABILITY_REQUEST_TTL_MS = 10 * 60_000;
const DEFAULT_CAPABILITY_RECEIPT_TTL_MS = 30_000;

interface InFlightWaiter {
  resolve: (response: PermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AuthorizationManagerDeps {
  ruleStore: IAuthorizationRuleStore;
  pendingStore: IPendingRequestStore;
  auditStore: IAuthorizationAuditStore;
  io?: SocketIOServer;
  timeoutMs?: number;
}

export class AuthorizationManager {
  private inFlightWaiters = new Map<string, InFlightWaiter>();
  private readonly ruleStore: IAuthorizationRuleStore;
  private readonly pendingStore: IPendingRequestStore;
  private readonly auditStore: IAuthorizationAuditStore;
  private readonly io?: SocketIOServer;
  private readonly timeoutMs: number;

  constructor(deps: AuthorizationManagerDeps) {
    this.ruleStore = deps.ruleStore;
    this.pendingStore = deps.pendingStore;
    this.auditStore = deps.auditStore;
    if (deps.io) this.io = deps.io;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 猫猫请求权限 — 完整流程:
   * 1. 查规则 → 命中则直接返回
   * 2. 创建 pending record → WebSocket 推送
   * 3. 等待铲屎官审批 (120s) → 返回结果或 pending
   */
  async requestPermission(
    catId: CatId,
    threadId: string,
    req: Pick<PermissionRequest, 'invocationId' | 'action' | 'reason' | 'context'>,
    userId?: string,
  ): Promise<PermissionResponse> {
    // Step 1: 查规则
    const rule = await this.ruleStore.match(catId, req.action, threadId);
    if (rule) {
      const decision = rule.decision === 'allow' ? 'granted' : 'denied';
      await this.auditStore.append({
        requestId: '',
        invocationId: req.invocationId,
        catId,
        threadId,
        action: req.action,
        reason: req.reason,
        decision: rule.decision,
        matchedRuleId: rule.id,
      });
      return { status: decision as 'granted' | 'denied' };
    }

    // Step 2: 创建 pending record
    const record = await this.pendingStore.create({
      invocationId: req.invocationId,
      catId,
      threadId,
      action: req.action,
      reason: req.reason,
      ...(req.context ? { context: req.context } : {}),
    });

    // WebSocket 推送到前端
    if (this.io) {
      this.io.to(`thread:${threadId}`).emit('authorization:request', {
        requestId: record.requestId,
        catId,
        threadId,
        action: req.action,
        reason: req.reason,
        ...(req.context ? { context: req.context } : {}),
      });
    }

    // Web Push: 即使不在 Cat Cafe 页面也能收到权限请求
    const pushSvc = getPushNotificationService();
    if (pushSvc && userId) {
      pushSvc
        .notifyUser(userId, {
          title: `🔐 ${catId} 需要权限`,
          body: `${req.action}: ${req.reason}`.slice(0, 120),
          tag: `auth-${record.requestId}`,
          data: { threadId, url: `/?thread=${threadId}`, forceSystemNotification: true },
        })
        .catch(() => {
          /* best-effort */
        });
    }

    // Step 3: 等待铲屎官审批
    return new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.inFlightWaiters.delete(record.requestId);
        // 超时 → 返回 pending + requestId（铲屎官稍后审批）
        void this.auditStore.append({
          requestId: record.requestId,
          invocationId: req.invocationId,
          catId,
          threadId,
          action: req.action,
          reason: req.reason,
          decision: 'pending',
        });
        resolve({ status: 'pending', requestId: record.requestId });
      }, this.timeoutMs);

      this.inFlightWaiters.set(record.requestId, { resolve, timer });
    });
  }

  /**
   * A1 exact one-shot capability approval. Persistent rules are deliberately
   * ignored; a granted request is atomically claimable once, including after
   * the original HTTP waiter timed out.
   */
  async requestCapability(
    intent: CapabilityIntentV1,
    reason: string,
    options?: { requestTtlMs?: number; receiptTtlMs?: number },
  ): Promise<CapabilityApproval> {
    const now = Date.now();
    const subjectDigest = digestCapabilityIntent(intent);
    const existing = await this.pendingStore.findCapabilityRequest(subjectDigest, intent.userId, now);

    if (existing?.status === 'granted') {
      const claimed = await this.pendingStore.claimCapabilityGrant(
        existing.requestId,
        subjectDigest,
        intent.userId,
        now,
      );
      return this.capabilityApprovalFromClaim(claimed, options?.receiptTtlMs);
    }

    const record =
      existing?.status === 'waiting'
        ? existing
        : await this.pendingStore.create({
            invocationId: intent.invocationId,
            catId: intent.catId,
            threadId: intent.threadId,
            action: intent.action,
            reason,
            requesterUserId: intent.userId,
            capabilityIntent: intent,
            capabilitySubjectDigest: subjectDigest,
            requestExpiresAt: now + (options?.requestTtlMs ?? DEFAULT_CAPABILITY_REQUEST_TTL_MS),
          });

    if (!existing && this.io) {
      this.io.to(`thread:${intent.threadId}`).emit('authorization:request', {
        requestId: record.requestId,
        catId: intent.catId,
        threadId: intent.threadId,
        action: intent.action,
        reason,
      });
    }

    const response = await this.waitForCapability(record);
    if (response.status !== 'granted') {
      return {
        status: response.status,
        requestId: record.requestId,
        ...(response.reason ? { reason: response.reason } : {}),
      };
    }

    const claimed = await this.pendingStore.claimCapabilityGrant(
      record.requestId,
      subjectDigest,
      intent.userId,
      Date.now(),
    );
    return this.capabilityApprovalFromClaim(claimed, options?.receiptTtlMs);
  }

  private async waitForCapability(record: PendingRequestRecord): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.inFlightWaiters.delete(record.requestId);
        void this.auditStore.append({
          requestId: record.requestId,
          invocationId: record.invocationId,
          catId: record.catId,
          threadId: record.threadId,
          action: record.action,
          reason: record.reason,
          decision: 'pending',
        });
        resolve({ status: 'pending', requestId: record.requestId });
      }, this.timeoutMs);
      this.inFlightWaiters.set(record.requestId, { resolve, timer });
    });
  }

  private capabilityApprovalFromClaim(
    claimed: PendingRequestRecord | null,
    receiptTtlMs = DEFAULT_CAPABILITY_RECEIPT_TTL_MS,
  ): CapabilityApproval {
    const now = Date.now();
    if (
      !claimed ||
      !claimed.respondedBy ||
      claimed.respondScope !== 'once' ||
      claimed.requestExpiresAt === undefined ||
      claimed.requestExpiresAt < now
    ) {
      return {
        status: 'denied',
        requestId: claimed?.requestId ?? '',
        reason: 'Capability grant unavailable or already claimed',
      };
    }
    const expiresAt = Math.min(claimed.requestExpiresAt, now + Math.max(1, receiptTtlMs));
    return {
      status: 'granted',
      requestId: claimed.requestId,
      approvedBy: claimed.respondedBy,
      scope: 'once',
      expiresAt,
    };
  }

  /**
   * 铲屎官审批 — 更新 record + 可选创建规则 + resolve waiter
   */
  async respond(
    requestId: string,
    granted: boolean,
    scope: RespondScope,
    userId: string,
    reason?: string,
  ): Promise<PendingRequestRecord | null> {
    const decision = granted ? 'granted' : 'denied';

    const existing = await this.pendingStore.get(requestId);
    if (existing?.capabilityIntent) {
      if (!existing.requesterUserId || existing.requesterUserId !== userId) {
        throw new Error('Capability approval owner mismatch');
      }
      if (scope !== 'once') {
        throw new Error('A1 capability approvals only support once scope');
      }
      if (existing.requestExpiresAt === undefined || existing.requestExpiresAt < Date.now()) {
        throw new Error('Capability approval request expired');
      }
    }

    // 更新 pending record
    const updated = await this.pendingStore.respond(requestId, decision, scope, reason, userId);
    if (!updated) {
      const latest = await this.pendingStore.get(requestId);
      if (latest?.capabilityIntent && (latest.requestExpiresAt === undefined || latest.requestExpiresAt < Date.now())) {
        throw new Error('Capability approval request expired');
      }
      return null;
    }

    // 如果 scope 不是 'once'，创建持久化规则
    if (scope !== 'once' && !updated.capabilityIntent) {
      await this.ruleStore.add({
        catId: updated.catId,
        action: updated.action,
        scope,
        decision: granted ? 'allow' : 'deny',
        ...(scope === 'thread' ? { threadId: updated.threadId } : {}),
        createdBy: userId,
        ...(reason ? { reason } : {}),
      });
    }

    // 审计日志
    await this.auditStore.append({
      requestId,
      invocationId: updated.invocationId,
      catId: updated.catId,
      threadId: updated.threadId,
      action: updated.action,
      reason: updated.reason,
      decision: granted ? 'allow' : 'deny',
      scope,
      decidedBy: userId,
    });

    // Resolve in-flight waiter（猫猫 HTTP 立即返回）
    const waiter = this.inFlightWaiters.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.inFlightWaiters.delete(requestId);
      waiter.resolve({
        status: decision as 'granted' | 'denied',
        ...(reason ? { reason } : {}),
      });
    }

    return updated;
  }

  /** 猫猫用 requestId 查询结果 */
  async getRequestStatus(requestId: string): Promise<PendingRequestRecord | null> {
    return this.pendingStore.get(requestId);
  }

  /** 前端查询 status='waiting' 的请求 */
  async getPending(threadId?: string): Promise<PendingRequestRecord[]> {
    return this.pendingStore.listWaiting(threadId);
  }

  /** 查规则 */
  async checkRule(catId: CatId, action: string, threadId: string): Promise<'allow' | 'deny' | null> {
    const rule = await this.ruleStore.match(catId, action, threadId);
    return rule?.decision ?? null;
  }

  /** 测试用: 当前 in-flight waiter 数 */
  get pendingWaiterCount(): number {
    return this.inFlightWaiters.size;
  }
}
