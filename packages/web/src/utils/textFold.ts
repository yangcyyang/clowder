export const TEXT_FOLD_THRESHOLD = 30;

export type TextFoldReason = 'length' | 'structured-agent' | 'technical-details';

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
];

// 技术密度判断：需要同时满足多个特征才判定为技术细节
// 避免单个路径/命令误伤正常解释内容
function isTechnicalDetail(text: string): boolean {
  const lineCount = countMeaningfulLines(text);
  if (lineCount <= 3) return false;

  let matchCount = 0;
  const hasExplicitTechnicalHeading =
    /(^|\n)\s*(?:验证|测试|构建|build|tsc|截图|日志|API smoke|改动文件|文件清单)[:：]/i.test(text);

  // 代码块算强特征（+2）
  if (/```/.test(text)) matchCount += 2;

  // 命令行特征（+1）
  if (/(^|\n)\s*[-*]\s*`?(?:pnpm|npm|bun|yarn|node|python3?|bash|curl|git|tsc|vitest|playwright)\b/i.test(text)) {
    matchCount += 1;
  }

  // 验证/构建关键词（+1）
  if (hasExplicitTechnicalHeading) matchCount += 1;

  // 列表中的 commit/build 等（+1）
  if (/(^|\n)\s*[-*]\s*(?:commit|build|tsc|验证|测试)\b/i.test(text)) {
    matchCount += 1;
  }

  // 改动文件清单上下文中的文件路径（+1）：只在明确的"改动文件/文件清单/验证"等列表前缀后计分
  // 单独提及 .md/.ts 文件名不计分，避免误伤正常讨论
  if (
    hasExplicitTechnicalHeading &&
    /(^|\n)\s*(?:改动文件|文件清单|changed files?|modified files?)[:：][^]*?(?:\.ts|\.tsx|\.js|\.jsx|\.css|\.md|\.json)/i.test(text)
  ) {
    matchCount += 1;
  }

  // 需要至少 2 分才判定为技术细节
  return matchCount >= 2;
}

function countMeaningfulLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

export function getTextFoldReason(text: string): TextFoldReason | null {
  if (!text) return null;
  const normalized = text.trimEnd();
  if (!normalized) return null;
  if (STRUCTURED_AGENT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'structured-agent';
  if (isTechnicalDetail(normalized)) return 'technical-details';
  if (countMeaningfulLines(normalized) > TEXT_FOLD_THRESHOLD) return 'length';
  return null;
}

export function shouldFoldText(text: string): boolean {
  return getTextFoldReason(text) !== null;
}
