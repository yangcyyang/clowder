import type { TrajectoryStep } from '../AntigravityBridge.js';
import type { AntigravityToolExecutor } from './AntigravityToolExecutor.js';

/** Canonical LS tool name for shell execution — the ONLY discriminator shared
 * by the executor registry and the A1 receipt-gate suppression logic. */
export const RUN_COMMAND_TOOL_NAME = 'run_command';

export function resolveToolName(step: TrajectoryStep | null | undefined): string | null {
  return step?.metadata?.toolCall?.name ?? step?.toolCall?.toolName ?? null;
}

/**
 * A1 receipt-gate suppression discriminator. MUST stay aligned with the
 * executor's own discriminator (`resolveToolName`, used by
 * `ExecutorRegistry.resolve`) — never with `step.type`, which is an LS-owned
 * string that can drift. A waiting step whose tool name cannot be determined
 * is treated as gated (fail toward suppression) so ambiguity can never
 * silently reopen the LS-side auto-approve bypass.
 */
export function isRunCommandOrAmbiguousWaitingStep(step: TrajectoryStep | null | undefined): boolean {
  if (step?.status !== 'CORTEX_STEP_STATUS_WAITING') return false;
  const toolName = resolveToolName(step);
  if (toolName === null) return true;
  return toolName === RUN_COMMAND_TOOL_NAME;
}

export class ExecutorRegistry {
  private readonly executors = new Map<string, AntigravityToolExecutor>();

  register(executor: AntigravityToolExecutor): void {
    if (this.executors.has(executor.toolName)) {
      throw new Error(`Executor for tool "${executor.toolName}" already registered`);
    }
    this.executors.set(executor.toolName, executor);
  }

  resolve(step: TrajectoryStep | null | undefined): AntigravityToolExecutor | null {
    const toolName = resolveToolName(step);
    if (!toolName) return null;
    return this.executors.get(toolName) ?? null;
  }

  size(): number {
    return this.executors.size;
  }
}
