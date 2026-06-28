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
      input: ProjectInitFastLaneInput;
    };

export interface ProjectInitFastLaneInput {
  projectName: string;
  root: string;
  security: boolean;
  creator?: string;
}

export function isFastLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[FAST_LANE_FLAG]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseProjectInitCommand(text: string): ProjectInitFastLaneInput | null {
  const commandLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('/project-init '));
  if (!commandLine) return null;

  const tokens = commandLine.split(/\s+/).filter(Boolean);
  const projectName = tokens[1];
  if (!projectName || !/^[a-zA-Z0-9_-]+$/.test(projectName)) return null;

  let root = '';
  let security = false;
  let creator: string | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--root') {
      root = tokens[++index] ?? '';
    } else if (token === '--security') {
      security = true;
    } else if (token === '--creator') {
      creator = tokens[++index] ?? '';
    } else {
      return null;
    }
  }

  if (!root) return null;
  return {
    projectName,
    root,
    security,
    ...(creator ? { creator } : {}),
  };
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
    const projectInitInput = parseProjectInitCommand(haystack);
    if (projectInitInput) {
      return {
        lane: 'fast',
        workflowId: PROJECT_INIT_WORKFLOW_ID,
        reason: 'matched explicit /project-init command',
        confidence: 'high',
        input: projectInitInput,
      };
    }

    if (normalizeText(haystack).includes('project-init') || haystack.includes('初始化项目')) {
      return {
        lane: 'slow',
        reason: 'project-init mentioned without explicit /project-init <name> --root <path> command',
      };
    }

    return {
      lane: 'slow',
      reason: 'no fast-lane whitelist match',
    };
  }
}
