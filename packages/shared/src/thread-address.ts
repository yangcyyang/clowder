export const THREAD_ADDRESS_ROOT_ID_RE = /^\d{16}-\d{6}-[0-9a-f]{8}$/i;

export type ThreadAddressParseResult =
  | { kind: 'none' }
  | { kind: 'valid'; token: string; label: string; rootMessageId: string }
  | { kind: 'invalid'; reason: 'malformed' | 'multiple' };

function normalizeThreadAddressLabel(value: string): string {
  const normalized = value
    .trim()
    .replace(/[#：:]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return (normalized || 'Thread').slice(0, 48);
}

export function formatThreadAddressToken(threadTitle: string | null | undefined, rootMessageId: string): string {
  return `#${normalizeThreadAddressLabel(threadTitle ?? '')}:${rootMessageId}`;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findMatchingDelimiter(value: string, from: number, open: string, close: string): number {
  if (value[from] !== open) return -1;
  let depth = 1;
  for (let cursor = from + 1; cursor < value.length; cursor += 1) {
    if (isEscaped(value, cursor)) continue;
    if (value[cursor] === open) depth += 1;
    if (value[cursor] === close) depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

const RAW_HTML_OPEN_TAG_RE = /<([A-Za-z][A-Za-z0-9-]*)(?=\s|\/?>|$)/u;
const RAW_HTML_CLOSE_TAG_RE = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/u;
const RAW_HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function hasRawHtmlClosingTag(line: string, tag: string): boolean {
  return new RegExp(`</${tag}(?:\\s|>)`, 'iu').test(line);
}

function findRawHtmlOpeningTag(line: string): { tag: string; opensBlock: boolean } | undefined {
  const match = RAW_HTML_OPEN_TAG_RE.exec(line);
  const tag = match?.[1]?.toLowerCase();
  if (!match || !tag) return undefined;
  return {
    tag,
    opensBlock:
      !line.slice(match.index).includes('/>') && !RAW_HTML_VOID_TAGS.has(tag) && !hasRawHtmlClosingTag(line, tag),
  };
}

function isMarkdownReferenceDefinition(line: string): boolean {
  const openIndex = /^\s{0,3}\[/u.exec(line)?.[0].lastIndexOf('[') ?? -1;
  if (openIndex < 0) return false;
  const labelEnd = findMatchingDelimiter(line, openIndex, '[', ']');
  return labelEnd >= 0 && line[labelEnd + 1] === ':';
}

function maskInlineNonPlaintextSurfaces(line: string): string {
  if (isMarkdownReferenceDefinition(line)) return '';

  // String indices below are UTF-16 code-unit offsets; split('') keeps the mask
  // array aligned even when a label or surrounding prose contains emoji.
  const chars = line.split('');
  const mask = (from: number, through: number): void => {
    for (let cursor = from; cursor <= through; cursor += 1) chars[cursor] = ' ';
  };

  // Inline code is literal source, not an executable address surface.
  const withoutCode = line.replace(/(`+)[^\n]*?\1/gu, (value) => ' '.repeat(value.length));
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (withoutCode[cursor] === ' ' && line[cursor] !== ' ') chars[cursor] = ' ';
  }

  // Markdown links/images and reference links are structured destinations.
  // Mask the whole construct so neither alt/label text nor a destination can
  // accidentally become an executable thread address.
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (line[cursor] !== '[' || isEscaped(line, cursor)) continue;
    const labelEnd = findMatchingDelimiter(line, cursor, '[', ']');
    if (labelEnd < 0) continue;
    const destinationStart = labelEnd + 1;
    let destinationEnd = -1;
    if (line[destinationStart] === '(') {
      destinationEnd = findMatchingDelimiter(line, destinationStart, '(', ')');
    } else if (line[destinationStart] === '[') {
      destinationEnd = findMatchingDelimiter(line, destinationStart, '[', ']');
    }
    if (destinationEnd >= 0) {
      mask(line[cursor - 1] === '!' && !isEscaped(line, cursor - 1) ? cursor - 1 : cursor, destinationEnd);
      cursor = destinationEnd;
    }
  }

  const masked = chars.join('');
  return masked
    .replace(/<[^\n>]*>/gu, (value) => ' '.repeat(value.length))
    .replace(/(?:https?:\/\/|mailto:|www\.)[^\s<>()]+/giu, (value) => ' '.repeat(value.length));
}

function stripNonPlaintextAddressSurfaces(content: string): string {
  const visibleLines: string[] = [];
  let fence: '```' | '~~~' | null = null;
  let rawHtmlBlockTag: string | null = null;
  let rawHtmlComment = false;

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    const marker = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
    if (marker) {
      fence = fence === marker ? null : (fence ?? marker);
      visibleLines.push('');
      continue;
    }
    if (fence || /^\s*>/u.test(line) || /^(?: {4}|\t)/u.test(line)) {
      visibleLines.push('');
      continue;
    }
    if (rawHtmlComment) {
      if (line.includes('-->')) rawHtmlComment = false;
      visibleLines.push('');
      continue;
    }
    if (rawHtmlBlockTag) {
      if (hasRawHtmlClosingTag(line, rawHtmlBlockTag)) rawHtmlBlockTag = null;
      visibleLines.push('');
      continue;
    }
    const commentStart = line.indexOf('<!--');
    if (commentStart >= 0) {
      rawHtmlComment = line.indexOf('-->', commentStart + 4) < 0;
      visibleLines.push('');
      continue;
    }
    const rawHtmlOpening = findRawHtmlOpeningTag(line);
    if (rawHtmlOpening) {
      if (rawHtmlOpening.opensBlock) rawHtmlBlockTag = rawHtmlOpening.tag;
      visibleLines.push('');
      continue;
    }
    if (RAW_HTML_CLOSE_TAG_RE.test(line) || /<!(?:DOCTYPE|\[CDATA\[)|<\?/iu.test(line)) {
      visibleLines.push('');
      continue;
    }
    visibleLines.push(maskInlineNonPlaintextSurfaces(line));
  }

  return visibleLines.join('\n');
}

const ADDRESS_CANDIDATE_RE = /(^|[^\p{L}\p{N}\p{M}_\\-])#([^\s#:`]+):([^\s`]*)/gu;
const TRAILING_PUNCTUATION_RE = /[)\]}）】,，。.!！?？;；"'“”‘’]+$/gu;

export function parseThreadAddressToken(content: string): ThreadAddressParseResult {
  const plaintext = stripNonPlaintextAddressSurfaces(content);
  const candidates: Array<{ token: string; label: string; rootMessageId: string; valid: boolean }> = [];
  ADDRESS_CANDIDATE_RE.lastIndex = 0;
  let match = ADDRESS_CANDIDATE_RE.exec(plaintext);
  while (match !== null) {
    const label = match[2] ?? '';
    const rawId = match[3] ?? '';
    const rootMessageId = rawId.replace(TRAILING_PUNCTUATION_RE, '');
    candidates.push({
      token: `#${label}:${rootMessageId}`,
      label,
      rootMessageId,
      valid: THREAD_ADDRESS_ROOT_ID_RE.test(rootMessageId),
    });
    match = ADDRESS_CANDIDATE_RE.exec(plaintext);
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length !== 1) return { kind: 'invalid', reason: 'multiple' };
  const [candidate] = candidates;
  if (!candidate?.valid) return { kind: 'invalid', reason: 'malformed' };
  return {
    kind: 'valid',
    token: candidate.token,
    label: candidate.label,
    rootMessageId: candidate.rootMessageId,
  };
}
