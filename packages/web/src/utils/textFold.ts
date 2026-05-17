export const TEXT_FOLD_THRESHOLD = 10;

export type TextFoldReason = 'length' | 'structured-agent';

const STRUCTURED_AGENT_PATTERNS = [
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?(?:🔒\s*)?代理名称(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?(?:📝\s*)?任务定义(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?(?:⚙️\s*)?执行动作(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?(?:✅\s*)?预期结果(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?(?:📋\s*)?(?:任务已派发|已派工|已路由)/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?任务名称(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?执行步骤(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?完成标准(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*(?:[#*-]\s*)?(?:\*\*)?执行动作\s*\d*(?:\*\*)?\s*[:：]/,
  /(^|\n)\s*#{1,3}\s+.{4,}/,
];

export function getTextFoldReason(text: string): TextFoldReason | null {
  if (!text) return null;
  const normalized = text.trimEnd();
  if (!normalized) return null;
  if (STRUCTURED_AGENT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'structured-agent';
  if (normalized.split('\n').length > TEXT_FOLD_THRESHOLD) return 'length';
  return null;
}

export function shouldFoldText(text: string): boolean {
  return getTextFoldReason(text) !== null;
}
