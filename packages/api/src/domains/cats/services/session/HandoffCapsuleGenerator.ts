/**
 * 理智线 T4（task #386）：黄区自动轻交接包生成器。
 *
 * 纯函数，零 LLM 调用——手法照抄 AutoSummarizer.ts（正则匹配关键句式，避免额外 CLI
 * spawn 成本/方差）。调用方必须先用 stores/visibility.ts 的 isSummaryCompactionEligibleMessage
 * 过滤掉未 reveal 的 whisper 消息，再把结果传进来——这里不做二次可见性判断，抽取前置
 * 过滤是唯一防线（安全钉，见 invoke-single-cat.ts 调用点 + 对应哨兵测试）。注意：不能用
 * canViewMessage(msg,{type:'user'})，那个函数对 user viewer 直接放行一切，起不到过滤
 * 作用（这个坑本票踩过一次，被哨兵测试当场抓到）。
 *
 * V0 范围：`goal` 字段是近期消息推断的近似值（`goalIsInferred: true`），不是精确
 * task 标题——ITaskStore 没有 threadId 反查方法，为一个字段扩 store 接口不值 V0，
 * 精确关联留 follow-up（已跟 @专家-Claude 对齐）。
 */

import type { CatId, SanityHandoffCapsuleV1 } from '@cat-cafe/shared';

export const UNSPECIFIED = '未明确';

/** env 门控，默认关（canary 上线前先不生成）。 */
export function isSanityHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CAT_CAFE_SANITY_HANDOFF === '1' || env.CAT_CAFE_SANITY_HANDOFF === 'true';
}

/** 生成器输入的最小消息形状——调用方负责先过 isSummaryCompactionEligibleMessage 等可见性过滤。 */
export interface HandoffSourceMessage {
  readonly content: string;
  readonly catId: string | null;
  readonly timestamp: number;
}

const FIELD_PATTERNS: Record<
  'completed' | 'verified' | 'abandoned' | 'openIssues' | 'nextSteps' | 'constraints',
  RegExp
> = {
  completed: /决定|确定|选择|采用|使用|实现了|完成了|修复了|已上线|已交付|已合并|已核过/,
  verified: /测试通过|回归.*绿|全绿|验证通过|assert|测试.*(?:pass|绿)|核过.*生效|哨兵.*(?:通过|绿)/,
  abandoned: /放弃|不用了|改用|废弃|不采用|试过.*不行|回滚|撤回/,
  openIssues: /待|TODO|还没|未来|后续|不确定|存疑/,
  nextSteps: /下一步|接下来|准备|计划|下一轮|继续推进|继续做/,
  constraints: /禁止|不能|必须|不要|不得|边界是|铁律/,
};

const FILE_PATH_RE = /`?([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yaml|yml|py|sh))`?/g;

const MIN_SUBSTANTIAL_LENGTH = 10;
const MAX_FIELD_ITEMS = 3;
const MAX_FIELD_ITEM_CHARS = 120;
const MAX_FILES = 8;
const GOAL_SNIPPET_CHARS = 80;
const BACKGROUND_SNIPPET_MESSAGES = 3;
const BACKGROUND_SNIPPET_CHARS = 220;

function toSentences(content: string): string[] {
  return content
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

function extractField(messages: readonly HandoffSourceMessage[], pattern: RegExp): string {
  const hits = messages
    .flatMap((m) => toSentences(m.content))
    .filter((sentence) => pattern.test(sentence))
    .slice(0, MAX_FIELD_ITEMS)
    .map((sentence) => truncate(sentence, MAX_FIELD_ITEM_CHARS));
  return hits.length > 0 ? hits.join('；') : UNSPECIFIED;
}

function extractFiles(messages: readonly HandoffSourceMessage[]): string {
  const files = new Set<string>();
  for (const msg of messages) {
    for (const match of msg.content.matchAll(FILE_PATH_RE)) {
      const path = match[1];
      if (path) files.add(path);
      if (files.size >= MAX_FILES) break;
    }
    if (files.size >= MAX_FILES) break;
  }
  return files.size > 0 ? [...files].join('、') : UNSPECIFIED;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export interface GenerateSanityHandoffInput {
  readonly threadId: string;
  readonly catId: CatId;
  readonly triggerState: 'yellow' | 'red';
  /** 调用方已用 canViewMessage 过滤过的消息（时间正序，最旧在前）。 */
  readonly messages: readonly HandoffSourceMessage[];
  readonly generatedAt?: number;
}

export function generateSanityHandoffCapsule(input: GenerateSanityHandoffInput): SanityHandoffCapsuleV1 {
  const { threadId, catId, triggerState, messages } = input;
  const substantial = messages.filter((m) => m.content.trim().length >= MIN_SUBSTANTIAL_LENGTH);
  const recentWindow = substantial.slice(-30);

  const firstMsg = substantial[0]?.content.trim();
  const goal = firstMsg ? `（消息推断）${truncate(firstMsg, GOAL_SNIPPET_CHARS)}` : UNSPECIFIED;

  const backgroundSource = substantial
    .slice(0, BACKGROUND_SNIPPET_MESSAGES)
    .map((m) => m.content.trim())
    .join(' ');
  const background = backgroundSource
    ? `（消息推断）${truncate(backgroundSource, BACKGROUND_SNIPPET_CHARS)}`
    : UNSPECIFIED;

  return {
    v: 1,
    threadId,
    catId,
    triggerState,
    goal,
    goalIsInferred: true,
    background,
    constraints: extractField(recentWindow, FIELD_PATTERNS.constraints),
    completed: extractField(recentWindow, FIELD_PATTERNS.completed),
    verified: extractField(recentWindow, FIELD_PATTERNS.verified),
    abandonedApproaches: extractField(recentWindow, FIELD_PATTERNS.abandoned),
    openIssues: extractField(recentWindow, FIELD_PATTERNS.openIssues),
    nextSteps: extractField(recentWindow, FIELD_PATTERNS.nextSteps),
    mustReadFiles: extractFiles(recentWindow),
    generatedAt: input.generatedAt ?? Date.now(),
  };
}

/** 交接包渲染成任务线程消息正文（markdown）。 */
export function formatSanityHandoffMarkdown(capsule: SanityHandoffCapsuleV1): string {
  const stateLabel = capsule.triggerState === 'red' ? '🔴 红区' : '🟡 黄区';
  return [
    `## 理智线自动交接包（${stateLabel}）`,
    `目标（推断，非精确）：${capsule.goal}`,
    `背景：${capsule.background}`,
    `约束：${capsule.constraints}`,
    `已完成：${capsule.completed}`,
    `已验证：${capsule.verified}`,
    `废弃方案：${capsule.abandonedApproaches}`,
    `未解决：${capsule.openIssues}`,
    `下一步：${capsule.nextSteps}`,
    `必读文件：${capsule.mustReadFiles}`,
  ].join('\n');
}
