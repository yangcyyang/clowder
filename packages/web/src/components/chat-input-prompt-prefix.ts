/**
 * Prompt-prefix presets shared by the main channel composer (ChatInput) and the
 * Thread panel composer (InlineThreadPanel) — extracted so both surfaces offer the
 * exact same "提示词" menu instead of two lists that can drift apart.
 */

export const CVO_MODE_STORAGE_KEY = 'cat-cafe:cvoMode';
export const PROMPT_PREFIX_STORAGE_KEY = 'cat-cafe:promptPrefix';

export const CVO_MODE_PREFIX = `[CVO_MODE] 在执行任何操作之前，你必须先以采访者身份问我 3 个问题，帮助澄清需求：
① 你希望的最终产物/结果是什么？
② 有什么约束条件或不能动的边界？
③ 完成的标准是什么，怎样算"做好了"？
请等我逐一回答后再开始执行。`;

export const PROMPT_PREFIX_OPTIONS = [
  {
    id: 'none',
    label: '无前缀',
    shortLabel: '提示词',
    description: '直接发送当前输入内容',
    prefix: '',
  },
  {
    id: 'requirements',
    label: '需求前置',
    shortLabel: '需求前置',
    description: '先问清目标、边界和验收标准',
    prefix: CVO_MODE_PREFIX,
  },
  {
    id: 'debug',
    label: '问题排查',
    shortLabel: '排查',
    description: '先定位现象、根因、影响面和修复方案',
    prefix:
      '[DEBUG_MODE] 请先按问题排查流程处理：明确现象、复现路径、可能根因、影响范围、最小修复方案和验证方式。不要直接给泛泛建议。',
  },
  {
    id: 'plan',
    label: '方案规划',
    shortLabel: '规划',
    description: '输出目标、范围、步骤、风险和验收点',
    prefix:
      '[PLAN_MODE] 请先做方案规划：明确目标、边界、执行步骤、依赖、风险、验收标准。优先给可落地的最小方案。',
  },
  {
    id: 'review',
    label: '代码审查',
    shortLabel: '审查',
    description: '优先找 bug、回归风险和缺失测试',
    prefix:
      '[REVIEW_MODE] 请以代码审查视角回答：优先指出 bug、行为回归、边界风险和缺失测试，再给修改建议。不要只做总结。',
  },
  {
    id: 'summary',
    label: '总结提炼',
    shortLabel: '总结',
    description: '提炼结论、关键点和下一步行动',
    prefix:
      '[SUMMARY_MODE] 请做结构化总结：先给一句核心结论，再提炼关键点、决策、待办和下一步行动。避免长篇复述。',
  },
] as const;

export type PromptPrefixId = (typeof PROMPT_PREFIX_OPTIONS)[number]['id'];

export function isPromptPrefixId(value: string | null): value is PromptPrefixId {
  return PROMPT_PREFIX_OPTIONS.some((option) => option.id === value);
}
