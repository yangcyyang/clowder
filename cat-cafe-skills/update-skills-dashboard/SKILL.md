---
name: update-skills-dashboard
title: 技能看板刷新
description: >
  扫描本地 skill 目录并重新生成 Skills Dashboard HTML 文件。
  Use when: 铲屎官说"更新 dashboard"、"刷新技能列表"、skill 新增/删除后需要同步页面。
  Not for: 查看 dashboard（直接访问 http://localhost:3003/api/skills/dashboard）、修改 skill 内容（用对应 skill）。
  Output: 更新后的 skills-dashboard.html + 更新报告（新增/删除/总数）。
triggers:
  - "更新 dashboard"
  - "刷新技能列表"
  - "update skills dashboard"
  - "重新生成 dashboard"
  - "技能看板刷新"
---

# Update Skills Dashboard

扫描本地 skill 目录，提取元数据，重新生成 Skills Dashboard HTML 文件。

## 核心知识

**触发时机**：
- 新增/删除 skill 后
- skill 元数据（name/description/triggers）修改后
- 手动刷新页面数据

**数据源**：
- `~/.agents/skills/` - 个人 skill 目录
- `cat-cafe-skills/` - Clowder skill 目录
- 其他配置的 skill 源

**输出**：
- `/Users/cy/Documents/03 life/AI design/产品项目/skill管理/skills-dashboard.html`

## 执行流程

### Step 1 — 扫描 Skill 目录

扫描所有配置的 skill 源：

```typescript
const skillSources = [
  { name: 'personal', path: '~/.agents/skills/', priority: 'personal' },
  { name: 'clowder', path: 'cat-cafe-skills/', priority: 'clowder' },
  // 其他源...
];
```

### Step 2 — 提取元数据

从每个 `SKILL.md` 提取：
- frontmatter (name, description, triggers)
- 风险等级（从 description 或内容推断）
- 文件路径
- 场景分类（从 triggers 推断）

### Step 3 — 生成 HTML

使用现有模板结构：
- 保留双语标题逻辑（中文标题 + 英文 slug）
- 保留筛选功能（场景/来源）
- 保留搜索功能
- 更新统计数据（总数/分类数）

### Step 4 — 写入文件

覆盖现有 `skills-dashboard.html`。

### Step 5 — 生成报告

输出更新报告：
```
Skills Dashboard 更新完成

统计：
- 总计: 404 → 408 (+4)
- 新增: ai-new-skill, debugging-v2, ...
- 删除: old-skill-1, ...
- 分类变化: 工程开发 87 → 89

文件: /Users/cy/Documents/03 life/AI design/产品项目/skill管理/skills-dashboard.html
访问: http://localhost:3003/api/skills/dashboard
```

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 忘记扫描所有 skill 源 | 数据不完整 | 检查 skillSources 配置 |
| 覆盖前不备份 | 手动改动丢失 | 先备份旧文件 |
| 中文标题 fallback 失效 | 显示英文 slug | 检查 SKILL_TOKEN_ZH 词典 |
| HTML 语法错误 | 页面崩溃 | 用 HTML validator 检查 |

## 和其他 Skill 的区别

- **不是 `tdd`**：这是工具脚本，不涉及业务逻辑测试
- **不是 `quality-gate`**：这是数据同步，不是代码审查
- **不是 `schedule-tasks`**：这是手动触发，不是定时任务（虽然可以被定时任务调用）

## 下一步

更新完成后 → 访问 http://localhost:3003/api/skills/dashboard 验证
