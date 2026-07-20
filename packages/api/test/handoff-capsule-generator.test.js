import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatSanityHandoffMarkdown,
  generateSanityHandoffCapsule,
  UNSPECIFIED,
} from '../dist/domains/cats/services/session/HandoffCapsuleGenerator.js';

function msg(content, overrides = {}) {
  return { content, catId: 'opus', timestamp: Date.now(), ...overrides };
}

describe('理智线 T4 (task #386): generateSanityHandoffCapsule', () => {
  it('extracts all 9 fields from a realistic message sequence, none left empty', () => {
    const messages = [
      msg('帮我把 F194 全频道翻转的自动建 task 判定器调优一下'),
      msg('禁止在生产环境直接改配置文件，必须先过 gate'),
      msg('已经确定用关键词匹配而不是精确模型 ID，抗版本漂移'),
      msg('修复了 packages/api/src/routes/cats.ts 里 sanityLine 的 400 校验'),
      msg('测试通过，回归 142 例全绿'),
      msg('试过反查 ITaskStore 但要动 port，放弃了，改用消息推断'),
      msg('还没确定 goal 字段要不要精确关联 task 标题，存疑'),
      msg('下一步接下来把 SessionBootstrap.ts 的渲染也补上'),
    ];

    const capsule = generateSanityHandoffCapsule({
      threadId: 'thread-1',
      catId: 'opus',
      triggerState: 'yellow',
      messages,
    });

    assert.equal(capsule.v, 1);
    assert.equal(capsule.threadId, 'thread-1');
    assert.equal(capsule.catId, 'opus');
    assert.equal(capsule.triggerState, 'yellow');
    assert.equal(capsule.goalIsInferred, true);

    for (const field of [
      'goal',
      'background',
      'constraints',
      'completed',
      'verified',
      'abandonedApproaches',
      'openIssues',
      'nextSteps',
      'mustReadFiles',
    ]) {
      assert.ok(capsule[field].length > 0, `${field} should not be empty`);
    }

    assert.match(capsule.goal, /^（消息推断）/);
    assert.match(capsule.constraints, /禁止/);
    assert.match(capsule.completed, /确定|修复/);
    assert.match(capsule.verified, /测试通过/);
    assert.match(capsule.abandonedApproaches, /放弃/);
    assert.match(capsule.openIssues, /还没|存疑/);
    assert.match(capsule.nextSteps, /下一步/);
    assert.match(capsule.mustReadFiles, /cats\.ts/);
  });

  it('marks every field as 未明确 (not empty string) when there is no source content', () => {
    const capsule = generateSanityHandoffCapsule({
      threadId: 'thread-empty',
      catId: 'opus',
      triggerState: 'yellow',
      messages: [],
    });

    assert.equal(capsule.goal, UNSPECIFIED);
    assert.equal(capsule.background, UNSPECIFIED);
    assert.equal(capsule.constraints, UNSPECIFIED);
    assert.equal(capsule.completed, UNSPECIFIED);
    assert.equal(capsule.verified, UNSPECIFIED);
    assert.equal(capsule.abandonedApproaches, UNSPECIFIED);
    assert.equal(capsule.openIssues, UNSPECIFIED);
    assert.equal(capsule.nextSteps, UNSPECIFIED);
    assert.equal(capsule.mustReadFiles, UNSPECIFIED);
  });

  it('ignores trivial/short messages when picking the goal (whitespace, very short content)', () => {
    const capsule = generateSanityHandoffCapsule({
      threadId: 'thread-2',
      catId: 'opus',
      triggerState: 'yellow',
      messages: [msg('  '), msg('ok'), msg('帮我实现一个新功能，具体是这样的：……')],
    });
    assert.match(capsule.goal, /帮我实现一个新功能/);
  });

  it('is a pure function: same input always produces the same field content (idempotent, timestamps aside)', () => {
    const messages = [msg('决定采用方案 A'), msg('测试通过，全绿')];
    const a = generateSanityHandoffCapsule({
      threadId: 't',
      catId: 'opus',
      triggerState: 'yellow',
      messages,
      generatedAt: 1,
    });
    const b = generateSanityHandoffCapsule({
      threadId: 't',
      catId: 'opus',
      triggerState: 'yellow',
      messages,
      generatedAt: 1,
    });
    assert.deepEqual(a, b);
  });

  it('caps mustReadFiles at a bounded count instead of growing unbounded', () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(`修改了 packages/api/src/file-${i}.ts`));
    const capsule = generateSanityHandoffCapsule({ threadId: 't', catId: 'opus', triggerState: 'red', messages });
    const fileCount = capsule.mustReadFiles.split('、').length;
    assert.ok(fileCount <= 8, `expected at most 8 files, got ${fileCount}`);
  });
});

describe('理智线 T4 (task #386): formatSanityHandoffMarkdown', () => {
  it('renders all 9 fields with labels, and marks red vs yellow distinctly', () => {
    const capsule = generateSanityHandoffCapsule({
      threadId: 't',
      catId: 'opus',
      triggerState: 'red',
      messages: [msg('决定采用方案 A'), msg('测试通过')],
    });
    const md = formatSanityHandoffMarkdown(capsule);
    assert.match(md, /红区/);
    assert.match(md, /目标（推断，非精确）/);
    assert.match(md, /已验证/);
    assert.match(md, /必读文件/);
  });
});
