import type { CatConfig, ToolPolicy } from '@cat-cafe/shared';

export type ToolPolicySource = 'agent-default' | 'user-override';

export interface ResolvedToolPolicy {
  readonly toolPolicy: ToolPolicy;
  readonly source: ToolPolicySource;
}

const POLICY_OVERRIDE_PATTERNS: ReadonlyArray<{ policy: ToolPolicy; patterns: readonly RegExp[] }> = [
  {
    policy: 'minimal',
    patterns: [/轻度工具箱/i, /轻量模式/i, /\bminimal\b/i],
  },
  {
    policy: 'standard',
    patterns: [/中度工具箱/i, /标准工具箱/i, /\bstandard\b/i],
  },
  {
    policy: 'full',
    patterns: [/重度工具箱/i, /全量模式/i, /\bfull\b/i],
  },
];

export function extractToolPolicyOverride(message: string): ToolPolicy | undefined {
  for (const candidate of POLICY_OVERRIDE_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(message))) {
      return candidate.policy;
    }
  }
  return undefined;
}

export function resolveEffectiveToolPolicy(catConfig: CatConfig | undefined, message: string): ResolvedToolPolicy {
  const override = extractToolPolicyOverride(message);
  if (override) return { toolPolicy: override, source: 'user-override' };
  return { toolPolicy: catConfig?.toolPolicy ?? 'standard', source: 'agent-default' };
}

export function shouldLoadStandardContext(policy: ToolPolicy): boolean {
  return policy === 'standard' || policy === 'full';
}

export function shouldLoadFullContext(policy: ToolPolicy): boolean {
  return policy === 'full';
}
