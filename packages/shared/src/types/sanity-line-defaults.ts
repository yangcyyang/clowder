/**
 * 理智线 T2（task #384）：模型先验 sanityLine 默认表。
 *
 * cy 拍板的课程先验值（F163 实测校准另立后续票，本表不改）：
 * GPT-5.6=250K / Fable5=240K / Sonnet5|Opus4.8=200K / Grok4.5=180K / KimiK2.7=140K / 其他未知=120K。
 *
 * 匹配用关键词而非精确模型 ID：真实 defaultModel 字符串带版本后缀会漂移
 * （如 "claude-opus-4-8"、"claude-sonnet-4-6"、"gpt-5.6-sol"），精确匹配一升版本就失效；
 * 关键词匹配对版本号漂移健壮，代价是略微宽松（例如未来的 "claude-opus-5" 也会命中 opus 档）。
 */

const SANITY_LINE_FALLBACK = 120_000;

const SANITY_LINE_MODEL_TABLE: ReadonlyArray<{ readonly match: RegExp; readonly sanityLine: number }> = [
  { match: /gpt-5\.6/i, sanityLine: 250_000 },
  { match: /fable/i, sanityLine: 240_000 },
  { match: /opus/i, sanityLine: 200_000 },
  { match: /sonnet/i, sanityLine: 200_000 },
  { match: /grok/i, sanityLine: 180_000 },
  { match: /kimi/i, sanityLine: 140_000 },
];

/** 未知/不匹配任何先验表条目的模型，回落到这个保守兜底值。 */
export function getSanityLineFallback(): number {
  return SANITY_LINE_FALLBACK;
}

/** 按 defaultModel 字符串解析模型先验 sanityLine；未匹配到任何条目时回落 120K。 */
export function resolveSanityLineDefault(defaultModel: string | undefined): number {
  if (!defaultModel) return SANITY_LINE_FALLBACK;
  const entry = SANITY_LINE_MODEL_TABLE.find(({ match }) => match.test(defaultModel));
  return entry ? entry.sanityLine : SANITY_LINE_FALLBACK;
}

/** 落回顺序：variant 显式值 > breed 显式值 > 模型先验表 > 120K 兜底。 */
export function resolveSanityLine(
  variantSanityLine: number | undefined,
  breedSanityLine: number | undefined,
  defaultModel: string | undefined,
): number {
  return variantSanityLine ?? breedSanityLine ?? resolveSanityLineDefault(defaultModel);
}
