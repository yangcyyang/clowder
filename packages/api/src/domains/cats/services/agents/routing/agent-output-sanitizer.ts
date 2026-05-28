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

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (isInternalProtocolBlock(block)) continue;

    const cleanedLines = block
      .split('\n')
      .map((line) => stripInlineArtifacts(line).replace(/[ \t]{2,}/g, ' ').trimEnd())
      .filter((line) => line.trim().length > 0);

    if (cleanedLines.length > 0) {
      cleanedBlocks.push(cleanedLines.join('\n'));
    }
  }

  return cleanedBlocks.join('\n\n').trim();
}
