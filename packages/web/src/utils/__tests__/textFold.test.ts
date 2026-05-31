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

  it('returns false for text exceeding threshold', () => {
    const text = Array.from({ length: TEXT_FOLD_THRESHOLD + 1 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('returns false for empty string', () => {
    expect(shouldFoldText('')).toBe(false);
  });

  it('returns false for single line', () => {
    expect(shouldFoldText('hello world')).toBe(false);
  });

  it('keeps normal dialogue visible even when it has several Markdown sections', () => {
    const text = [
      '这个方案可以做，但我建议先分两步。',
      '',
      '## 为什么',
      '第一，先把目录整理清楚。',
      '第二，再让 agent 自动选择。',
      '',
      '## 怎么做',
      '先生成 manifest。',
      '再做 dashboard。',
      '最后接入 router。',
      '',
      '要我现在就写 SKILL.md 内容吗？',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('returns false for exactly threshold lines with trailing newline', () => {
    const text = 'x\n'.repeat(TEXT_FOLD_THRESHOLD);
    expect(shouldFoldText(text)).toBe(false);
  });

  it('keeps structured agent handoff content visible', () => {
    const text = [
      '@gpt52',
      '**🔒 代理名称**：simple_html_worker',
      '**📝 任务定义**：写一个简单网页',
      '**⚙️ 执行动作**：创建 HTML 文件',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps ordinary Markdown heading content visible', () => {
    expect(getTextFoldReason('## 执行计划\n先做 A\n再做 B')).toBe(null);
  });

  it('keeps Chinese handoff fields visible', () => {
    expect(getTextFoldReason('任务名称：写一个简单网页')).toBe(null);
    expect(getTextFoldReason('执行步骤：\n1. 创建文件')).toBe(null);
  });

  it('keeps technical-looking progress visible under length threshold', () => {
    const text = [
      '验证结果：',
      '- pnpm --dir packages/api build',
      '- pnpm --dir packages/web build',
      '- commit 1234567',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps short technical mentions visible', () => {
    const text = '验证结果：build 通过。';

    expect(shouldFoldText(text)).toBe(false);
  });

  it('threshold defaults to 30', () => {
    expect(TEXT_FOLD_THRESHOLD).toBe(30);
  });

  it('keeps normal explanation with single file path visible', () => {
    const text = [
      '调研结论：',
      '这几个 skill 可以分成三类：内容到页面规格、页面规格到 HTML/PDF/PPTX。',
      '相关入口可以先看 packages/web/src/utils/textFold.ts。',
      '对 PPT Agent 最有价值的不是直接照搬某个 skill，而是吸收它们的"第二阶段 MD"设计方法。',
      '1. Huashu Design',
      '定位：高保真 HTML 设计生产线，能做原型、幻灯片、动画、设计变体、专家评审。',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps file change list visible under length threshold', () => {
    const text = [
      '改动文件：',
      '- packages/web/src/utils/textFold.ts',
      '- packages/web/src/utils/__tests__/textFold.test.ts',
      '- packages/web/src/components/CollapsibleMarkdown.tsx',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps normal explanation with inline code mentions visible', () => {
    const text = [
      '我会按这轮目标做轻量调研：先查线程记忆，再读 PPT Agent 真相源。',
      '然后对比本地 huashu / kami / guizang 相关 skill。',
      '不会生成新文档或修改 skill。',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps PPT write-back reply with markdown filename visible', () => {
    const text = [
      '开始写回',
      '已收到确认。我会按刚才确认的方向改同一份 MD：先补“给人审的 13 页逐页内容”，再补“给设计稿 Agent / ppt-master / image-2 的完整输入”。不生成图片、不导出 PPT。',
      '',
      '🔎 正在自检',
      '补充已经写入。我现在检查关键锚点、13 页是否齐、下游交接字段和哈希，确保这版能同时给人审和给下一步 Agent 执行。',
      '',
      '✅ 已按确认写回',
      '已更新这份 MD:',
      'dynamic-workflows-ppt-structure-design-blueprint.md',
      '这次重点补了两层：',
      '1. 给人审的 13 页逐页内容',
      '2. 给下游 Agent 执行的结构化输入',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });

  it('keeps agent research progress with inline code chips visible', () => {
    const text = [
      '🔍 接球：先查上下文，再做只读检测',
      '',
      '我会先确认本地 ppt-master 的位置和配置方式，只检查“是否配置/能否被程序识别”，不在主消息里暴露任何 API key。',
      '',
      '📍 开始定位本地 ppt-master',
      '',
      '我先找本地 ppt-master 仓库/工具目录和它的配置说明，再判断 API key 是读 .env、系统环境变量，还是某个配置文件。',
      '',
      '📚 找到本地 ppt-master',
      '',
      '本地实际目录是 产品项目/PPT agent/.research/ppt-master。文档显示 gpt-image-2 走的是 image_gen.py，需要 IMAGE_BACKEND 加对应 provider 的 *_API_KEY。',
      '',
      '⚠️ 第一轮检测结果',
      '',
      '当前这个本地 clone 没有 .env，当前进程也没有 IMAGE_BACKEND / OPENAI_API_KEY。我再查一遍用户级配置/环境变量，确认是不是挂在别处。',
    ].join('\n');

    expect(shouldFoldText(text)).toBe(false);
    expect(getTextFoldReason(text)).toBe(null);
  });
});
