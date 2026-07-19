/** Exact-scope rollout gate for capability receipt v1. */

import type { CapabilityIntentV1, RespondScope } from '@cat-cafe/shared';
import { STATUS } from '../../../../infrastructure/telemetry/genai-semconv.js';
import { capabilityReceiptGateDecisions } from '../../../../infrastructure/telemetry/instruments.js';
import {
  type CapabilityReceiptMode,
  resolveCapabilityReceiptMode,
} from '../stores/factories/CapabilityReceiptStoreFactory.js';
import type { ICapabilityReceiptStore } from '../stores/ports/CapabilityReceiptStore.js';

export interface CapabilityReceiptRolloutPolicy {
  readonly mode: CapabilityReceiptMode;
  readonly executorAllowlist: ReadonlySet<string>;
  readonly catAllowlist: ReadonlySet<string>;
  readonly threadAllowlist: ReadonlySet<string>;
  readonly emergencyBlock?: boolean;
}

export type CapabilityApproval =
  | {
      readonly status: 'granted';
      readonly requestId: string;
      readonly approvedBy: string;
      readonly scope: RespondScope;
      readonly expiresAt: number;
      readonly matchedRuleId?: string;
    }
  | { readonly status: 'pending' | 'denied'; readonly requestId: string; readonly reason?: string };

export type CapabilityReceiptGateDecision =
  | { readonly allowed: true; readonly state: 'off' | 'out_of_scope' | 'observed' }
  | { readonly allowed: true; readonly state: 'granted'; readonly receiptId: string }
  | {
      readonly allowed: false;
      readonly state: 'pending' | 'denied';
      readonly requestId: string;
      readonly reason?: string;
    }
  | { readonly allowed: false; readonly state: 'error' };

export interface CapabilityReceiptExecutionGateDeps {
  readonly policy: CapabilityReceiptRolloutPolicy;
  readonly authorize: (intent: CapabilityIntentV1, reason: string) => Promise<CapabilityApproval>;
  readonly receiptStore?: ICapabilityReceiptStore;
  readonly recordDecision?: (status: CapabilityReceiptMetricStatus) => void;
}

export type CapabilityReceiptScope = Pick<CapabilityIntentV1, 'executorId' | 'catId' | 'threadId'>;
export type CapabilityReceiptMetricStatus =
  | 'gate_off'
  | 'mismatch'
  | 'would_block'
  | 'pending'
  | 'denied'
  | 'issued'
  | 'consumed'
  | 'expired'
  | 'replay'
  | 'store_error'
  | 'emergency_block';

function parseExactAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function resolveCapabilityReceiptRolloutPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityReceiptRolloutPolicy {
  return {
    mode: resolveCapabilityReceiptMode(env.CLOWDER_CAPABILITY_RECEIPT_MODE),
    executorAllowlist: parseExactAllowlist(env.CLOWDER_CAPABILITY_RECEIPT_EXECUTOR_ALLOWLIST),
    catAllowlist: parseExactAllowlist(env.CLOWDER_CAPABILITY_RECEIPT_CAT_ALLOWLIST),
    threadAllowlist: parseExactAllowlist(env.CLOWDER_CAPABILITY_RECEIPT_THREAD_ALLOWLIST),
    emergencyBlock: env.CLOWDER_CAPABILITY_RECEIPT_EMERGENCY_BLOCK === '1',
  };
}

export function isCapabilityReceiptPolicyMatch(
  policy: CapabilityReceiptRolloutPolicy,
  intent: CapabilityReceiptScope,
): boolean {
  // Empty lists are deliberately match-none. This prevents a missing canary
  // configuration from silently turning into global enforcement.
  return (
    policy.executorAllowlist.size > 0 &&
    policy.catAllowlist.size > 0 &&
    policy.threadAllowlist.size > 0 &&
    policy.executorAllowlist.has(intent.executorId) &&
    policy.catAllowlist.has(intent.catId) &&
    policy.threadAllowlist.has(intent.threadId)
  );
}

export class CapabilityReceiptExecutionGate {
  private readonly policy: CapabilityReceiptRolloutPolicy;
  private readonly authorizeIntent: CapabilityReceiptExecutionGateDeps['authorize'];
  private readonly receiptStore?: ICapabilityReceiptStore;
  private readonly recordDecision: (status: CapabilityReceiptMetricStatus) => void;

  constructor(deps: CapabilityReceiptExecutionGateDeps) {
    this.policy = deps.policy;
    this.authorizeIntent = deps.authorize;
    this.receiptStore = deps.receiptStore;
    this.recordDecision =
      deps.recordDecision ??
      ((status) => {
        capabilityReceiptGateDecisions.add(1, { [STATUS]: status });
      });
  }

  isInScope(scope: CapabilityReceiptScope): boolean {
    return this.policy.mode !== 'off' && isCapabilityReceiptPolicyMatch(this.policy, scope);
  }

  async authorize(intent: CapabilityIntentV1, reason: string): Promise<CapabilityReceiptGateDecision> {
    if (this.policy.mode === 'off') {
      this.recordDecision('gate_off');
      return { allowed: true, state: 'off' };
    }
    if (!isCapabilityReceiptPolicyMatch(this.policy, intent)) {
      this.recordDecision('mismatch');
      return { allowed: true, state: 'out_of_scope' };
    }
    if (this.policy.emergencyBlock) {
      this.recordDecision('emergency_block');
      return {
        allowed: false,
        state: 'denied',
        requestId: 'policy-block',
        reason: 'Capability receipt emergency block is active',
      };
    }
    if (this.policy.mode === 'observe') {
      this.recordDecision('would_block');
      return { allowed: true, state: 'observed' };
    }

    try {
      if (!this.receiptStore) {
        this.recordDecision('store_error');
        return { allowed: false, state: 'error' };
      }
      const approval = await this.authorizeIntent(intent, reason);
      if (approval.status !== 'granted') {
        this.recordDecision(approval.status);
        return {
          allowed: false,
          state: approval.status,
          requestId: approval.requestId,
          ...(approval.reason ? { reason: approval.reason } : {}),
        };
      }

      const issued = await this.receiptStore.issue({
        requestId: approval.requestId,
        intent,
        approvedBy: approval.approvedBy,
        approvalScope: approval.scope,
        expiresAt: approval.expiresAt,
        ...(approval.matchedRuleId ? { matchedRuleId: approval.matchedRuleId } : {}),
      });
      this.recordDecision('issued');
      const consumed = await this.receiptStore.consume(issued.bearer, intent, intent.executorId);
      if (!consumed.ok) {
        const status: CapabilityReceiptMetricStatus =
          consumed.code === 'expired'
            ? 'expired'
            : consumed.code === 'already_used'
              ? 'replay'
              : consumed.code === 'scope_mismatch' ||
                  consumed.code === 'invalid' ||
                  consumed.code === 'not_found' ||
                  consumed.code === 'revoked'
                ? 'mismatch'
                : 'store_error';
        this.recordDecision(status);
        return { allowed: false, state: 'error' };
      }
      this.recordDecision('consumed');
      return { allowed: true, state: 'granted', receiptId: consumed.receipt.receiptId };
    } catch {
      // No memory fallback or best-effort bypass is permitted in enforce mode.
      this.recordDecision('store_error');
      return { allowed: false, state: 'error' };
    }
  }
}
