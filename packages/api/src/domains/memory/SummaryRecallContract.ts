/**
 * F004: producer/consumer contract for summaries used as the mandatory
 * delivery-only history surface. The labels are deliberately explicit so a
 * prose-only model response cannot be mistaken for recall-safe context.
 */
const CANONICAL_RECALL_FIELD_LABELS = [
  /^(?:#{1,6}\s*)?(?:当前状态\/任务(?:\s*\(Current status\))?|Current status)\s*(?::|：)?\s*(.*)$/i,
  /^(?:#{1,6}\s*)?(?:已确认决策\/约束(?:\s*\(Decision\/constraint\))?|Decision\/constraint)\s*(?::|：)?\s*(.*)$/i,
  /^(?:#{1,6}\s*)?(?:下一步(?:\s*\(Next action\))?|Next action)\s*(?::|：)?\s*(.*)$/i,
  /^(?:#{1,6}\s*)?(?:风险\/锚点(?:\s*\(Risk\/anchor\))?|Risk\/anchor)\s*(?::|：)?\s*(.*)$/i,
] as const;

export function hasRequiredSummaryRecallFields(text: string): boolean {
  return [
    /当前(?:状态|任务)|正在推进|current\s+status/i,
    /决策|约束|已确认|decision|constraint/i,
    /下一步|next\s+action/i,
    /风险|不确定|锚点|回看原文|risk|anchor/i,
  ].every((pattern) => pattern.test(text));
}

/** Producer-side gate: new summaries must preserve the canonical field labels. */
export function hasCanonicalSummaryRecallFields(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim());
  return CANONICAL_RECALL_FIELD_LABELS.every((fieldPattern) => {
    const fieldLineIndex = lines.findIndex((line) => fieldPattern.test(line));
    if (fieldLineIndex < 0) return false;

    const inlineValue = lines[fieldLineIndex]?.match(fieldPattern)?.[1]?.trim();
    if (inlineValue) return true;

    const nextContentLine = lines.slice(fieldLineIndex + 1).find((line) => line.length > 0);
    if (!nextContentLine) return false;
    return !CANONICAL_RECALL_FIELD_LABELS.some((labelPattern) => labelPattern.test(nextContentLine));
  });
}
