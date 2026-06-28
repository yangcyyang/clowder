import type { QueueEntry } from './InvocationQueue.js';

export const FAST_LANE_FLAG = 'CAT_CAFE_FAST_LANE';
export const PROJECT_INIT_WORKFLOW_ID = 'project-init';

export type FastLaneDecision =
  | {
      lane: 'slow';
      reason: string;
    }
  | {
      lane: 'fast';
      workflowId: typeof PROJECT_INIT_WORKFLOW_ID;
      reason: string;
      confidence: 'high';
    };

export function isFastLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[FAST_LANE_FLAG]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesProjectInitIntent(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  return (
    normalized.includes('/project-init') ||
    normalized.includes('project-init') ||
    normalized.includes('project init') ||
    normalized.includes('初始化项目') ||
    normalized.includes('项目初始化') ||
    normalized.includes('新项目脚手架') ||
    normalized.includes('创建项目脚手架')
  );
}

/**
 * Phase 1 only classifies deterministic fast-lane candidates.
 * It does not execute workflows; QueueProcessor keeps slow-lane execution until
 * a workflow executor is wired in Phase 2.
 */
export class FastLaneRouter {
  decide(entry: Pick<QueueEntry, 'content' | 'intent'>): FastLaneDecision {
    const intentText = typeof entry.intent === 'string' ? entry.intent : '';
    const haystack = `${entry.content}\n${intentText}`;
    if (matchesProjectInitIntent(haystack)) {
      return {
        lane: 'fast',
        workflowId: PROJECT_INIT_WORKFLOW_ID,
        reason: 'matched project-init whitelist trigger',
        confidence: 'high',
      };
    }

    return {
      lane: 'slow',
      reason: 'no fast-lane whitelist match',
    };
  }
}
