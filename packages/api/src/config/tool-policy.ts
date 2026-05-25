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

const HEAVY_TASK_PATTERN =
  /(修复|实现|改造|执行|检查|排查|报错|代码|构建|测试|调研|搜索|检索|设计|PPT|导出|文档|总结.*文档|文件|路径|Git|github|数据库|微信|IM|thread|agent|clowder|slock|API|接口|运行|部署|备份|push|commit)/i;

function normalizeTaskText(message: string): string {
  return message
    .replace(/@\S+/g, '')
    .replace(/轻度工具箱|轻量模式|中度工具箱|标准工具箱|重度工具箱|全量模式|\bminimal\b|\bstandard\b|\bfull\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Slock-like "成熟秘书"默认降级：
 * 短问候/短问答不需要背历史包，除非用户明确要求重工具箱或文本命中重任务关键词。
 */
export function shouldAutoDowngradeToMinimal(message: string, defaultPolicy: ToolPolicy): boolean {
  if (defaultPolicy !== 'standard') return false;
  const text = normalizeTaskText(message);
  if (!text) return true;
  if (HEAVY_TASK_PATTERN.test(text)) return false;
  if (/^(hi|hello|hey|ok|好的|收到|在吗|在|谢谢|测试|ping|哈喽|你好)[。.!！?？\s]*$/i.test(text)) return true;
  return text.length <= 36;
}

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
  const defaultPolicy = catConfig?.toolPolicy ?? 'standard';
  if (shouldAutoDowngradeToMinimal(message, defaultPolicy)) {
    return { toolPolicy: 'minimal', source: 'agent-default' };
  }
  return { toolPolicy: defaultPolicy, source: 'agent-default' };
}

export function shouldLoadStandardContext(policy: ToolPolicy): boolean {
  return policy === 'standard' || policy === 'full';
}

export function shouldLoadFullContext(policy: ToolPolicy): boolean {
  return policy === 'full';
}
