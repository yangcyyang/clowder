import { describe, expect, it } from 'vitest';
import { getTextFoldReason, shouldFoldText, TEXT_FOLD_THRESHOLD } from '../textFold';

describe('shouldFoldText', () => {
  it('returns false for short text', () => {
    expect(shouldFoldText('line 1\nline 2\nline 3')).toBe(false);
  });

  it('returns false for exactly threshold lines', () => {
    const text = Array.from({ length: TEXT_FOLD_THRESHOLD }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFoldText(text)).toBe(false);
  });

  it('returns true for text exceeding threshold', () => {
    const text = Array.from({ length: TEXT_FOLD_THRESHOLD + 1 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFoldText(text)).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(shouldFoldText('')).toBe(false);
  });

  it('returns false for single line', () => {
    expect(shouldFoldText('hello world')).toBe(false);
  });

  it('returns false for exactly threshold lines with trailing newline', () => {
    const text = 'x\n'.repeat(TEXT_FOLD_THRESHOLD);
    expect(shouldFoldText(text)).toBe(false);
  });

  it('folds structured agent handoff content even under threshold', () => {
    const text = [
      '@gpt52',
      '**🔒 代理名称**：simple_html_worker',
      '**📝 任务定义**：写一个简单网页',
      '**⚙️ 执行动作**：创建 HTML 文件',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(true);
    expect(getTextFoldReason(text)).toBe('structured-agent');
  });

  it('keeps ordinary Markdown heading content visible', () => {
    expect(getTextFoldReason('## 执行计划\n先做 A\n再做 B')).toBe(null);
  });

  it('folds Chinese handoff fields as structured agent detail', () => {
    expect(getTextFoldReason('任务名称：写一个简单网页')).toBe('structured-agent');
    expect(getTextFoldReason('执行步骤：\n1. 创建文件')).toBe('structured-agent');
  });

  it('folds technical details over three lines', () => {
    const text = [
      '验证结果：',
      '- pnpm --dir packages/api build',
      '- pnpm --dir packages/web build',
      '- commit 1234567',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(true);
    expect(getTextFoldReason(text)).toBe('technical-details');
  });

  it('keeps short technical mentions visible', () => {
    const text = '验证结果：build 通过。';

    expect(shouldFoldText(text)).toBe(false);
  });

  it('threshold defaults to 10', () => {
    expect(TEXT_FOLD_THRESHOLD).toBe(10);
  });
});
