/**
 * 批次 3 F-E: USER.md 槽位化（轻量版）—— 每节内部可选的 `**子主题**: 内容` 行级
 * 结构（Memobase topic/sub_topic 的轻量对应物，docs/research/memory-absorption.md
 * §2 第 3 条）。
 *
 * 纪律：**不做强制迁移** —— 存量自由文本（无 `**子主题**:` 前缀）必须原样解析为
 * `subTopic: null`，不丢字、不报错；只有新写入的条目才带子主题。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const STORE_MODULE = '../dist/domains/cats/services/agents/memory/UserProfileStore.js';

describe('USER.md sub_topic 槽位化 (批次 3 F-E)', () => {
  describe('parseUserProfileSubTopicLine', () => {
    it('parses a bare **子主题**: 内容 line', async () => {
      const { parseUserProfileSubTopicLine } = await import(STORE_MODULE);
      const raw = '**语气**: 全中文，简短直接';
      assert.deepEqual(parseUserProfileSubTopicLine(raw), {
        subTopic: '语气',
        content: '全中文，简短直接',
        raw,
      });
    });

    it('parses a dated bullet line in the exact shape appendUserProfileLine writes', async () => {
      const { parseUserProfileSubTopicLine } = await import(STORE_MODULE);
      const raw = '- [2026-07-25] **端口红线**: 生产 Redis 6399 禁止外连';
      const result = parseUserProfileSubTopicLine(raw);
      assert.equal(result.subTopic, '端口红线');
      assert.equal(result.content, '生产 Redis 6399 禁止外连');
      assert.equal(result.raw, raw);
    });

    it('backward-compat: plain dated bullet with no sub_topic parses as subTopic:null, content = full line', async () => {
      const { parseUserProfileSubTopicLine } = await import(STORE_MODULE);
      const raw = '- [2026-07-01] 铲屎官偏好回复简短，不要长篇大论';
      const result = parseUserProfileSubTopicLine(raw);
      assert.equal(result.subTopic, null);
      assert.equal(result.content, raw);
      assert.equal(result.raw, raw);
    });

    it('backward-compat: free-text Owner sentence with no bullet, no sub_topic — still parses fine', async () => {
      const { parseUserProfileSubTopicLine } = await import(STORE_MODULE);
      const raw = '硬约束不带项目符号也要保留';
      const result = parseUserProfileSubTopicLine(raw);
      assert.equal(result.subTopic, null);
      assert.equal(result.content, raw);
    });
  });

  describe('parseUserProfile / deriveUserProfileSubTopics round-trip', () => {
    it('mixed sub_topic + legacy plain lines parse into the correct per-section breakdown', async () => {
      const { parseUserProfile } = await import(STORE_MODULE);
      const content = [
        '# 铲屎官画像',
        '',
        '## 偏好',
        '- [2026-07-25] **语气**: 全中文，简短直接',
        '- [2026-07-01] 老式自由文本偏好条目',
        '',
        '## 硬约束',
        '- [2026-07-25] **端口红线**: 生产 Redis 6399 禁止外连',
        '',
        '## 账号级事实',
        '- [2026-07-01] 邮箱 928590029cy@gmail.com',
        '',
      ].join('\n');
      const parsed = parseUserProfile(content);

      const prefSubTopics = parsed.subTopics.get('偏好');
      assert.equal(prefSubTopics.length, 2);
      assert.equal(prefSubTopics[0].subTopic, '语气');
      assert.equal(prefSubTopics[0].content, '全中文，简短直接');
      assert.equal(prefSubTopics[1].subTopic, null, 'legacy line without a sub_topic prefix must not be misparsed');
      assert.equal(prefSubTopics[1].content, prefSubTopics[1].raw);

      const constraintSubTopics = parsed.subTopics.get('硬约束');
      assert.equal(constraintSubTopics.length, 1);
      assert.equal(constraintSubTopics[0].subTopic, '端口红线');
      assert.equal(constraintSubTopics[0].content, '生产 Redis 6399 禁止外连');

      // `sections` (the raw bullet array `renderUserProfile` serializes from)
      // is completely unaffected by the subTopics view.
      assert.equal(parsed.sections.get('偏好').length, 2);
    });

    it('empty USER.md still returns an empty-array subTopics entry for every section — no crash on absent file', async () => {
      const { parseUserProfile, USER_PROFILE_SECTIONS } = await import(STORE_MODULE);
      const parsed = parseUserProfile('');
      for (const section of USER_PROFILE_SECTIONS) {
        assert.deepEqual(parsed.subTopics.get(section), []);
      }
    });

    it('deriveUserProfileSubTopics is a pure function of a sections map — reused by routes/user-profile.ts PUT', async () => {
      const { deriveUserProfileSubTopics } = await import(STORE_MODULE);
      const sections = new Map([
        ['偏好', ['**格式**: 只写结论/证据/下一步']],
        ['硬约束', []],
        ['账号级事实', []],
      ]);
      const subTopics = deriveUserProfileSubTopics(sections);
      assert.equal(subTopics.get('偏好')[0].subTopic, '格式');
      assert.equal(subTopics.get('偏好')[0].content, '只写结论/证据/下一步');
      assert.deepEqual(subTopics.get('硬约束'), []);
    });
  });

  describe('appendUserProfileLine optional subTopic parameter', () => {
    it('writes a **subTopic**: content bullet when subTopic is given, and it round-trips on next parse', async () => {
      const { appendUserProfileLine, parseUserProfile } = await import(STORE_MODULE);
      const next = appendUserProfileLine('', '偏好', '全中文交流', '2026-07-25', '语气');
      assert.match(next, /- \[2026-07-25\] \*\*语气\*\*: 全中文交流/);

      const entry = parseUserProfile(next).subTopics.get('偏好')[0];
      assert.equal(entry.subTopic, '语气');
      assert.equal(entry.content, '全中文交流');
    });

    it('omitting subTopic produces the exact legacy `- [date] content` bullet — no behavior change for existing callers', async () => {
      const { appendUserProfileLine } = await import(STORE_MODULE);
      const next = appendUserProfileLine('', '账号级事实', '时区 Asia/Shanghai', '2026-07-25');
      assert.match(next, /- \[2026-07-25\] 时区 Asia\/Shanghai/);
      assert.ok(!next.includes('**'), 'no sub_topic prefix means no ** markers anywhere in the written line');
    });
  });

  describe('classifyUserProfileSection: sub_topic keyword priority', () => {
    it('sub_topic label takes priority over the body text\'s own keyword when they disagree', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      // Label says "偏好-格式" (a formatting preference) but the body text
      // happens to contain "必须" (normally a hard-constraint signal). Without
      // sub_topic-priority, the old whole-text scan would hit 必须 first and
      // misfile this as 硬约束 — the deliberate label should win.
      assert.equal(classifyUserProfileSection('**偏好-格式**: 必须只写结论和下一步，不要过程'), '偏好');
    });

    it('a **端口**-family label routes to 硬约束 via the sub_topic channel', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('**端口红线**: 6399 是生产 Redis'), '硬约束');
    });

    it('a **语气**-labeled line routes to 偏好 via the sub_topic channel', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('**语气**: 平实白话'), '偏好');
    });

    it('lines without a sub_topic prefix keep the original whole-text heuristic — no regression', async () => {
      const { classifyUserProfileSection } = await import(STORE_MODULE);
      assert.equal(classifyUserProfileSection('硬约束：生产 Redis 端口禁止外连'), '硬约束');
      assert.equal(classifyUserProfileSection('回复风格偏好简短'), '偏好');
      assert.equal(classifyUserProfileSection('邮箱是 928590029cy@gmail.com'), '账号级事实');
    });
  });
});
