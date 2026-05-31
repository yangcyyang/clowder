export const TEXT_FOLD_THRESHOLD = 30;

export type TextFoldReason = 'length' | 'structured-agent' | 'technical-details';

export function getTextFoldReason(text: string): TextFoldReason | null {
  void text;
  return null;
}

export function shouldFoldText(text: string): boolean {
  return getTextFoldReason(text) !== null;
}
