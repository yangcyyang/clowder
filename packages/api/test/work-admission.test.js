import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { classifyWorkAdmission } = await import('../dist/routes/work-admission.js');

const positive = [
  '帮我重启clowder',
  '@芝芝 修复登录页面的报错',
  '把大厅的噪音消息清理一下',
  '@gpt52 写一个每日推特摘要脚本',
  '帮我把这份文档翻译成英文',
  '@砚砚 部署最新的 commit 到线上',
  '修一下红点不显示的问题',
  '去查一下昨天的错误日志，给我原因',
  '帮我做一份下周的内容排期表',
  '@墨墨 整理这个 thread 的结论成文档',
  '把这个功能的开关默认打开',
  '帮我建一个新频道叫产品讨论',
  '执行方案已批，开工吧',
  '安排人把这批图片压缩一下',
  '@荧荧 抓取这个页面的数据存到 /tmp',
  '弄一个自动备份的定时任务',
  '帮我改一下首页标题的字号',
  '@衡衡 review 一下这个 PR 的 diff',
  '把测试跑一遍看看有没有回归',
  '帮我导出这个月的用量报表',
  '@宪宪 给这篇文章配三张插图',
  '上线吧，验收过了',
];

const pendingPlanPositive = ['你来推进哈', '按照你排期来', '就按第3个方案做', '直接拍B'];

const negative = [
  '是否有问题？',
  'raft 是怎么处理类似的问题呢？',
  '这个是什么？提示什么东西？',
  '需要跟你们探讨个问题',
  '我发现clowder左侧红点通知消失了',
  '做好了吗',
  '进度',
  '@专家-Claude 你怎么看这个架构？',
  '首响应延迟是否需要参考raft去调整架构呢？',
  '我有个想法，把她的模板拿来给我们用',
  '这两个区别是什么？',
  '聊聊下一步该做什么',
  '你觉得A和B哪个好？',
  '为什么昨天的部署这么慢？',
  '@老者-codex',
  '这个机制clowder怎么还没形成啊？',
  '有个报错，你看下怎么回事',
  '如果我们改成常驻架构会怎么样？',
  '我在想要不要把频道拆开',
  '大家对开源时间有什么建议吗',
  '帮我看看这个方案怎么样？',
  '这份报告写得对吗？',
  '记一下：下次部署前要先备份',
  '收到',
  '谢谢，辛苦了',
  '明天再说这个事',
  '这不就该修吗？',
  '难道现在不应该部署吗？',
  '老板说要加个按钮',
  'Claude 让 Codex 开始做并提交',
  '如果测试过了就部署',
  '等我确认后再帮我做',
];

describe('F194 strict work admission classifier', () => {
  test('accepts the direct-action corpus', () => {
    for (const content of positive) {
      assert.equal(classifyWorkAdmission({ content }).kind, 'create_from_message', content);
    }
  });

  test('resumes approvals only with a structured pending plan', () => {
    for (const content of pendingPlanPositive) {
      assert.equal(classifyWorkAdmission({ content }).kind, 'reply_only', `${content} without pending plan`);
      assert.deepEqual(
        classifyWorkAdmission({
          content,
          pendingPlan: { messageId: 'plan-1', title: '已确认方案' },
        }),
        {
          kind: 'resume_pending_plan',
          pendingPlanMessageId: 'plan-1',
          taskTitle: '已确认方案',
          reason: 'approval_with_pending_plan',
        },
        content,
      );
    }
  });

  test('fails quiet for questions, discussion, reports, status, quotations, conditions and delay', () => {
    for (const content of negative) {
      assert.equal(classifyWorkAdmission({ content }).kind, 'reply_only', content);
    }
  });

  test('requires a unique owner for a line-leading mention but allows unowned direct work', () => {
    assert.equal(
      classifyWorkAdmission({ content: '@芝芝 修复登录页面的报错', targetCatIds: ['opus'] }).kind,
      'create_from_message',
    );
    assert.deepEqual(
      classifyWorkAdmission({ content: '@芝芝 @砚砚 修复登录页面的报错', targetCatIds: ['opus', 'codex'] }),
      { kind: 'reply_only', reason: 'ambiguous_owner' },
    );
    assert.equal(classifyWorkAdmission({ content: '把大厅噪音清理一下', targetCatIds: [] }).kind, 'create_from_message');
  });
});


test('B4: task title redacts embedded API keys before 80-char truncate', () => {
  const content =
    '帮我部署生产环境 key=tp-c545abcdef0123456789sk-proj-shouldnotleakXXXX 继续说明很多很多字来触发截断';
  const decision = classifyWorkAdmission({ content });
  assert.equal(decision.kind, 'create_from_message');
  assert.ok(!decision.taskTitle.includes('tp-c545'), decision.taskTitle);
  assert.ok(!decision.taskTitle.includes('sk-proj'), decision.taskTitle);
  assert.ok(decision.taskTitle.includes('[REDACTED]') || decision.taskTitle.includes('部署'), decision.taskTitle);
});
