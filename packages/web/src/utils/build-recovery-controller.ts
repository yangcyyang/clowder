import { reserveAutomaticRecovery } from '@/utils/chunk-load-recovery';

export const PRODUCT_RECOVERY_SOURCE = 'product-recovery' as const;

export type RecoveryKind = 'build' | 'broadcast' | 'chunk';

export type RecoveryRequest = {
  kind: RecoveryKind;
  targetBuildId: string;
};

export type BuildRecoveryAction =
  | { type: 'announce'; buildId: string }
  | { type: 'prompt'; request: RecoveryRequest }
  | {
      type: 'reload';
      source: typeof PRODUCT_RECOVERY_SOURCE;
      fromBuildId: string;
      toBuildId: string;
      trigger: 'automatic' | 'manual';
    };

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;

type BuildRecoveryControllerOptions = {
  currentBuildId: string;
  storage: RecoveryStorage;
  hasUnsavedWork: () => boolean;
  maxConsecutiveProbeFailures?: number;
};

export type BuildRecoverySnapshot = {
  source: typeof PRODUCT_RECOVERY_SOURCE;
  currentBuildId: string;
  targetBuildId: string | null;
  pendingRequest: RecoveryRequest | null;
  consecutiveProbeFailures: number;
  loopPrevented: boolean;
};

function normalizeRecoveryTarget(kind: RecoveryKind, targetBuildId: string): string {
  const normalizedBuildId = targetBuildId.trim();
  if (kind !== 'chunk' || normalizedBuildId.startsWith('chunk:')) return normalizedBuildId;
  return `chunk:${normalizedBuildId}`;
}

/**
 * Framework-agnostic recovery state machine shared by the hydrated React guard
 * and the deterministic Node acceptance harness. Browser lifecycle and DOM work
 * stay with their adapters; every recovery decision is emitted as an action.
 */
export function createBuildRecoveryController({
  currentBuildId,
  storage,
  hasUnsavedWork,
  maxConsecutiveProbeFailures = 3,
}: BuildRecoveryControllerOptions) {
  let consecutiveProbeFailures = 0;
  let pendingRequest: RecoveryRequest | null = null;
  let recoveryStarted = false;
  let targetBuildId: string | null = null;
  let loopPrevented = false;
  const announcedBuildIds = new Set<string>();

  const reloadAction = (request: RecoveryRequest, trigger: 'automatic' | 'manual'): BuildRecoveryAction[] => {
    if (recoveryStarted) {
      loopPrevented = true;
      return [];
    }
    if (!reserveAutomaticRecovery(storage, request.targetBuildId)) {
      loopPrevented = true;
      return [];
    }
    recoveryStarted = true;
    return [
      {
        type: 'reload',
        source: PRODUCT_RECOVERY_SOURCE,
        fromBuildId: currentBuildId,
        toBuildId: request.targetBuildId,
        trigger,
      },
    ];
  };

  const requestRecovery = (kind: RecoveryKind, rawTargetBuildId: string): BuildRecoveryAction[] => {
    const normalizedTarget = normalizeRecoveryTarget(kind, rawTargetBuildId);
    if (!normalizedTarget) return [];
    targetBuildId = normalizedTarget;

    if (recoveryStarted) {
      loopPrevented = true;
      return [];
    }
    if (pendingRequest || hasUnsavedWork()) {
      if (pendingRequest) return [];
      pendingRequest = { kind, targetBuildId: normalizedTarget };
      return [{ type: 'prompt', request: pendingRequest }];
    }
    return reloadAction({ kind, targetBuildId: normalizedTarget }, 'automatic');
  };

  return {
    source: PRODUCT_RECOVERY_SOURCE,
    canProbe: () => {
      if (recoveryStarted) loopPrevented = true;
      return consecutiveProbeFailures < maxConsecutiveProbeFailures && !recoveryStarted && !pendingRequest;
    },
    handleProbeResult(serverBuildId: string | null): BuildRecoveryAction[] {
      if (!serverBuildId) {
        consecutiveProbeFailures += 1;
        return [];
      }

      consecutiveProbeFailures = 0;
      if (serverBuildId === currentBuildId) return [];

      const actions: BuildRecoveryAction[] = [];
      if (!announcedBuildIds.has(serverBuildId)) {
        announcedBuildIds.add(serverBuildId);
        actions.push({ type: 'announce', buildId: serverBuildId });
      }
      return actions.concat(requestRecovery('build', serverBuildId));
    },
    requestRecovery,
    resetProbeFailures() {
      consecutiveProbeFailures = 0;
    },
    manualPromptAction(): BuildRecoveryAction[] {
      if (!pendingRequest) return [];
      return reloadAction(pendingRequest, 'manual');
    },
    snapshot(): BuildRecoverySnapshot {
      return {
        source: PRODUCT_RECOVERY_SOURCE,
        currentBuildId,
        targetBuildId,
        pendingRequest,
        consecutiveProbeFailures,
        loopPrevented,
      };
    },
  };
}

export type BuildRecoveryController = ReturnType<typeof createBuildRecoveryController>;
