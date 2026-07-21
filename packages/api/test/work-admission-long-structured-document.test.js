/**
 * F194 FP tightening (yangcyyang picked option b): long pasted documents/excerpts with
 * numbered-paragraph structure and no leading @mention should classify as discussion, not
 * auto-create a task — even if an action-shaped verb (e.g. "改") appears somewhere inside.
 *
 * RED-first regression sample: the real false positive kimi's history replay found — cy's KV
 * Cache excerpt ("…一旦确定就不要改…") hit DIRECT_ACTION_RE's "改" and got auto-created as a
 * task when it was just a pasted reference document with a trailing question.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { classifyWorkAdmission } = await import('../dist/routes/work-admission.js');

// The real FP sample (reconstructed to match structure/length; message content itself, not a
// literal DB export) — three numbered points about KV-cache prefix stability, ends with a
// trailing question, no leading @mention.
const kvCacheExcerpt =
  '1. 系统提示词和工具定义一旦确定就不要改。任何改动，哪怕多一个空格，都会导致缓存全部失效，延迟成倍增加、成本上升（具体幅度视模型与配置而定），这一点在生产环境里尤其致命，因为一次不经意的措辞调整就可能让所有猫的响应速度同时变慢，团队应当把这一条写进部署检查清单里长期遵守，避免以后再犯同样的错误。' +
  '2. 动态信息永远追加到末尾——时间戳、用户状态等变化的内容，作为新消息追加到对话末尾，而不是修改已有的系统提示词，这样才能保证前缀在多轮对话之间保持字节级稳定，命中率才能维持在高位，这对成本控制非常关键。' +
  '3. 使用标准 API 格式，不要自行拼接消息：结构化消息会被 Chat Template 翻译成模型训练时见过的固定 token 序列；自行用字符串拼成 USER ASSISTANT 的根本问题是偏离了这种训练格式，会削弱模型的多步思考能力。至于缓存——它只认 token 字节序列，只要拼出的前缀字节级稳定，照样能命中；但若拼接方式不稳定（如每次向前缀注入动态内容），缓存也会随之失效，这三条原则建议我们团队认真对照现有实现逐条自查一遍。 @专家-Claude 看下这块对我们clowder有什么帮助。';

describe('F194 long-structured-document FP tightening', () => {
  test('the real cy KV-cache excerpt no longer auto-creates a task', () => {
    assert.ok(kvCacheExcerpt.length > 500, 'fixture must exceed the 500-char threshold');
    assert.deepEqual(classifyWorkAdmission({ content: kvCacheExcerpt }), {
      kind: 'reply_only',
      reason: 'long_structured_document',
    });
  });

  test('a short direct instruction is unaffected even if it contains a numbered list', () => {
    const shortNumbered = '1. 修一下登录页 2. 部署一下';
    assert.ok(shortNumbered.length < 500);
    assert.equal(classifyWorkAdmission({ content: shortNumbered }).kind, 'create_from_message');
  });

  test('a long document that leads with an @mention is unaffected by this rule (routes normally)', () => {
    const mentionLed = `@芝芝 ${kvCacheExcerpt}`;
    assert.notEqual(
      classifyWorkAdmission({ content: mentionLed, targetCatIds: ['opus'] }).reason,
      'long_structured_document',
    );
  });

  test('a long document without numbered-paragraph structure is unaffected (structure, not just length, gates this rule)', () => {
    const longUnstructured = '帮我修一下这个问题：'.repeat(60);
    assert.ok(longUnstructured.length > 500);
    assert.notEqual(classifyWorkAdmission({ content: longUnstructured }).reason, 'long_structured_document');
  });

  test('regression: the existing positive corpus of short direct instructions still all create tasks', () => {
    const positive = [
      '帮我重启clowder',
      '@芝芝 修复登录页面的报错',
      '把大厅的噪音消息清理一下',
      '@gpt52 写一个每日推特摘要脚本',
      '帮我把这份文档翻译成英文',
      '修一下红点不显示的问题',
      '去查一下昨天的错误日志，给我原因',
      '把这个功能的开关默认打开',
      '执行方案已批，开工吧',
      '@衡衡 给这篇文章配三张插图',
    ];
    for (const content of positive) {
      assert.equal(classifyWorkAdmission({ content }).kind, 'create_from_message', content);
    }
  });
});
