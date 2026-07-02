const OPENAI_CITATION_RE = /cite[^]*/g;
const BRACKET_CITATION_RE = /\[cite:[^\]]+\]/gi;
const COLON_CITATION_RE = /\bcite:turn\d+view\d+\b/gi;
const COMPACT_CITATION_RE = /\bciteturn\d+view\d+\b/gi;
const TEMP_PATH_RE = /\/tmp\/[^\s，。；;、)）\]}>"']+/g;

const INTERNAL_PROTOCOL_PATTERNS = [
  /\bTask\s+claim\b/i,
  /\$CLI\b/,
  /\binbox\b/i,
  /\brequiresTask\b/i,
  /\bin_review\b/i,
  /\bclowder\s+task\b/i,
  /\bclowder\s+message\b/i,
];

const INTERNAL_PROGRESS_LINE_PATTERNS = [
  /接续检查/,
  /记忆命中/,
  /全量扫描/,
  /当前任务记忆/,
  /可用工具/,
  /我先取上下文/,
  /我先按.*(?:查|确认|读取).*上下文/,
  /我先.*消息锚点.*上下文/,
  /使用\s*Skill/i,
  /初步结果/,
  /并行拆分/,
  /子任务状态/,
  /对齐数量口径/,
  /按家规查/,
  /加载.*技能/,
  /Task\s+更新/i,
  /我开始做/,
  /证据不够细/,
  /真相源.*偏差/,
  /真相源确认/,
  /结构已明确/,
  /准备落盘/,
  /开始写文件/,
  /已落盘.*验证/,
  /补索引/,
  /收尾验证/,
  /回写记忆/,
  /切任务状态/,
  /我先独立看/,
  /证据命中/,
  /本地布局事实/,
  /本地页面.*(?:没|没有).*消息内容/,
  /我有.*事实/,
  /找到可用.*API/i,
  /我看完.*上下文/,
  /我再扩一圈/,
];

const USER_FACING_LINE_RE =
  /^(结论|建议|结果|交付|验证|验证证据|原因|下一步|需要确认|风险|修复|改动|已完成|可以|不建议|费曼版|总结|最终判断|核心判断)(?:\s|[：:]|$)/;

function stripInlineArtifacts(text: string): string {
  return text
    .replace(OPENAI_CITATION_RE, '')
    .replace(BRACKET_CITATION_RE, '')
    .replace(COLON_CITATION_RE, '')
    .replace(COMPACT_CITATION_RE, '')
    .replace(TEMP_PATH_RE, '');
}

function isInternalProtocolBlock(block: string): boolean {
  return INTERNAL_PROTOCOL_PATTERNS.some((pattern) => pattern.test(block));
}

function normalizeSignalLine(line: string): string {
  return line
    .trim()
    .replace(/^[#>*\-\s\d.)（(]+/, '')
    .replace(/^(\*\*|__)+/, '')
    .replace(/(\*\*|__)+$/, '')
    .replace(/^[^\p{Letter}\p{Number}]+/u, '')
    .trim();
}

function isInternalProgressLine(line: string): boolean {
  const normalized = normalizeSignalLine(line);
  return INTERNAL_PROGRESS_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isUserFacingLine(line: string): boolean {
  return USER_FACING_LINE_RE.test(normalizeSignalLine(line));
}

/**
 * Final user-visible agent output sanitizer.
 *
 * This runs in the write pipeline, not in prompts, so it removes leaked runtime
 * protocol/log artifacts without changing how the agent reasons or chooses tools.
 */
export function sanitizeAgentVisibleOutput(content: string): string {
  if (!content) return content;

  const normalized = content.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cleanedBlocks: string[] = [];
  let suppressNarrativeAfterProgress = false;

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (isInternalProtocolBlock(block)) continue;

    const rawLines = block.split('\n').map((line) => stripInlineArtifacts(line).replace(/[ \t]{2,}/g, ' ').trimEnd());
    const hasInternalProgress = rawLines.some(isInternalProgressLine);
    const hasUserFacingLine = rawLines.some(isUserFacingLine);

    if (hasInternalProgress && !hasUserFacingLine) {
      suppressNarrativeAfterProgress = true;
      continue;
    }
    if (suppressNarrativeAfterProgress && !hasUserFacingLine) continue;
    if (hasUserFacingLine) suppressNarrativeAfterProgress = false;

    const cleanedLines = rawLines
      .filter((line) => !isInternalProgressLine(line))
      .filter((line) => line.trim().length > 0);

    if (cleanedLines.length > 0) {
      cleanedBlocks.push(cleanedLines.join('\n'));
    }
  }

  return cleanedBlocks.join('\n\n').trim();
}
