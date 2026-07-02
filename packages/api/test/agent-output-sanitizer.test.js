import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('agent output sanitizer', () => {
  async function getSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentVisibleOutput;
  }

  test('removes internal task protocol and citation markers', async () => {
    const sanitize = await getSanitizer();
    const output = sanitize('Task claim 00017799 已更新到 in_review，cite:turn0view0');

    assert.equal(output, '');
    assert.ok(!output.includes('Task claim'));
    assert.ok(!output.includes('in_review'));
    assert.ok(!output.includes('cite:turn0view0'));
  });

  test('keeps final conclusion while stripping citations and temp paths', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。citeturn0view0',
      '',
      '本地 clone 在 /tmp/pilotdeck-research，仅用于只读调研。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。'));
    assert.ok(!output.includes('cite'));
    assert.ok(!output.includes('/tmp/pilotdeck-research'));
  });

  test('drops only protocol blocks, not adjacent useful blocks', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '我接球做 OpenBMB/PilotDeck 调研。当前 $CLI 未注入，inbox 标记 requiresTask: no。',
      '',
      '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。');
  });

  test('drops internal progress jargon lines while keeping conclusions', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '🔍 我先取上下文',
      '我会先按家规查当前任务记忆和可用工具，再快速扫本地 skill 目录。',
      '',
      '📊 初步结果',
      '本地三个主要 skill 根目录里扫到 399 个 SKILL.md。',
      '',
      '结论：你的 skill 不是缺数量，而是缺触发和应用闭环。',
      '建议：先做 manifest + dashboard，再接入 Clowder router。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：你的 skill 不是缺数量，而是缺触发和应用闭环。\n建议：先做 manifest + dashboard，再接入 Clowder router。');
  });

  test('removes continuation and memory-hit implementation chatter', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '接续检查：读取最近 thread 与 MEMORY.md。',
      '记忆命中：发现 PilotDeck 已调研。',
      '全量扫描完成，开始整理。',
      '结论：这里应该只输出用户可用的判断。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：这里应该只输出用户可用的判断。');
  });

  test('drops markdown progress sections before final delivery', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '**🔍 我开始做指南**',
      '',
      '**📌 证据不够细**',
      '',
      '搜索只确认了同一条线程的大方向，具体可执行内容要以本地文件为准。我现在认领当前消息，再并行读源文件和目标目录。',
      '',
      '**⚠️ 真相源路径有偏差**',
      '',
      '导航给的路径不存在。我会先重新定位真实文件，再继续写入目标目录。',
      '',
      '**🛠️ 准备落盘**',
      '',
      '我已经确认目标目录和索引位置，现在开始写文件、补索引、回写记忆。',
      '',
      '**✅ 已完成**',
      '',
      '已沉淀 `design-compiler-guide.md`，并补充 `README.md` 索引。',
      '',
      '**验证证据**',
      '',
      '- 目标文件存在',
      '- API build 通过',
      '',
      '**费曼版**',
      '',
      '这份 skill 是把设计风格翻译成可复用操作手册。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('**✅ 已完成**'));
    assert.ok(output.includes('design-compiler-guide.md'));
    assert.ok(output.includes('**验证证据**'));
    assert.ok(output.includes('**费曼版**'));
    assert.ok(!output.includes('我开始做指南'));
    assert.ok(!output.includes('证据不够细'));
    assert.ok(!output.includes('我现在认领当前消息'));
    assert.ok(!output.includes('准备落盘'));
    assert.ok(!output.includes('回写记忆'));
  });

  test('preserves markdown conclusion after progress chatter', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '**🔍 我先独立看问题**',
      '',
      '我会先读链接消息，再检查协议和规则是否影响输出。',
      '',
      '**📌 证据命中较宽**',
      '',
      '需要继续扩一圈看路由和清洗链路。',
      '',
      '**🎯 结论**',
      '',
      '问题不在前端排版，而在 agent 把执行日志写进了最终正文。',
      '',
      '**建议**',
      '',
      '在写入前清洗过程段落，只保留结论、交付和验证。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('**🎯 结论**'));
    assert.ok(output.includes('问题不在前端排版'));
    assert.ok(output.includes('**建议**'));
    assert.ok(!output.includes('我先独立看问题'));
    assert.ok(!output.includes('继续扩一圈'));
  });

  test('drops codex anchor lookup progress headings before the real answer', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '🔍 我先按消息锚点查上下文',
      '',
      '你给的是 thread 内某条消息的锚点。我会先用证据库按 ID 精确查，再尝试读本地页面。',
      '',
      '🔎 本地页面没有直接吐出消息内容',
      '',
      'curl 只能拿到 Next.js 外壳，没拿到那条消息。',
      '',
      '🧭 我有两个事实了',
      '',
      '1. curl 打开的是 3003 的应用外壳。',
      '2. 当前磁盘上的文件不在原路径了。',
      '',
      '✅ 找到可用 API',
      '',
      '3003 的 `/api/messages?threadId=...` 能返回完整消息。',
      '',
      '✅ 我看完锚点上下文了',
      '',
      '这条链接锚到的是一次试跑，不是最终源文件。',
      '',
      '结论：锚点消息说明当前任务应该先确认来源文件，再继续执行。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：锚点消息说明当前任务应该先确认来源文件，再继续执行。');
  });

  test('drops model-visible skills budget warning lines', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '结论：任务已经完成。',
      '',
      '⚠️ Exceeded skills context budget of 2%. All skill descriptions were removed and 257 additional skills were not included in the model-visible skills list.',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：任务已经完成。');
  });
});
