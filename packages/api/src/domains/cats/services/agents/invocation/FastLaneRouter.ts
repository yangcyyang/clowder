import type { QueueEntry } from './InvocationQueue.js';

export const FAST_LANE_FLAG = 'CAT_CAFE_FAST_LANE';
export const PROJECT_INIT_WORKFLOW_ID = 'project-init';
export const IMAGE_GENERATION_WORKFLOW_ID = 'image-generation';

const IMAGE_SIZE_VALUES = new Set(['auto', '1024x1024', '1024x1536', '1536x1024']);
const IMAGE_QUALITY_VALUES = new Set(['auto', 'low', 'medium', 'high']);
const IMAGE_OUTPUT_FORMAT_VALUES = new Set(['png', 'jpeg', 'webp']);
const IMAGE_OPTION_ALIASES: Record<string, 'size' | 'quality' | 'outputFormat' | 'n'> = {
  '--size': 'size',
  '--quality': 'quality',
  '--format': 'outputFormat',
  '--output-format': 'outputFormat',
  '--n': 'n',
  '--count': 'n',
};

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
    }
  | {
      lane: 'fast';
      workflowId: typeof IMAGE_GENERATION_WORKFLOW_ID;
      reason: string;
      confidence: 'high';
      input: ImageGenerationFastLaneInput;
    };

export interface ProjectInitFastLaneInput {
  projectName: string;
  root: string;
  security: boolean;
  creator?: string;
}

export interface ImageGenerationFastLaneInput {
  prompt: string;
  n?: number;
  size?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024';
  quality?: 'auto' | 'low' | 'medium' | 'high';
  outputFormat?: 'png' | 'jpeg' | 'webp';
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

function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(line);
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = pattern.exec(line);
  }
  return tokens;
}

function applyImageOption(
  input: Partial<ImageGenerationFastLaneInput>,
  option: 'size' | 'quality' | 'outputFormat' | 'n',
  value: string,
): boolean {
  if (option === 'size') {
    if (!IMAGE_SIZE_VALUES.has(value)) return false;
    input.size = value as ImageGenerationFastLaneInput['size'];
    return true;
  }
  if (option === 'quality') {
    if (!IMAGE_QUALITY_VALUES.has(value)) return false;
    input.quality = value as ImageGenerationFastLaneInput['quality'];
    return true;
  }
  if (option === 'outputFormat') {
    if (!IMAGE_OUTPUT_FORMAT_VALUES.has(value)) return false;
    input.outputFormat = value as ImageGenerationFastLaneInput['outputFormat'];
    return true;
  }

  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 1 || count > 4) return false;
  input.n = count;
  return true;
}

function parseImageCommand(text: string): ImageGenerationFastLaneInput | null {
  const commandLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line === '/image' || line.startsWith('/image '));
  if (!commandLine) return null;

  const tokens = splitCommandLine(commandLine);
  if (tokens[0] !== '/image') return null;

  const promptTokens: string[] = [];
  const input: Partial<ImageGenerationFastLaneInput> = {};
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const option = IMAGE_OPTION_ALIASES[token];
    if (option) {
      if (!applyImageOption(input, option, tokens[++index] ?? '')) return null;
    } else if (token.startsWith('--')) {
      return null;
    } else {
      promptTokens.push(token);
    }
  }

  const prompt = promptTokens.join(' ').trim();
  if (!prompt) return null;
  return { prompt, ...input };
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

    const imageInput = parseImageCommand(haystack);
    if (imageInput) {
      return {
        lane: 'fast',
        workflowId: IMAGE_GENERATION_WORKFLOW_ID,
        reason: 'matched explicit /image command',
        confidence: 'high',
        input: imageInput,
      };
    }

    if (normalizeText(haystack).includes('project-init') || haystack.includes('初始化项目')) {
      return {
        lane: 'slow',
        reason: 'project-init mentioned without explicit /project-init <name> --root <path> command',
      };
    }

    if (normalizeText(haystack).includes('/image') || haystack.includes('生成图片') || haystack.includes('画一张')) {
      return {
        lane: 'slow',
        reason: 'image generation mentioned without explicit /image <prompt> command',
      };
    }

    return {
      lane: 'slow',
      reason: 'no fast-lane whitelist match',
    };
  }
}
