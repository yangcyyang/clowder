# Update Skills Dashboard

扫描本地 skill 目录，重新生成 Skills Dashboard HTML 文件。

## 快速使用

### 方式 1：通过 Skill 触发（推荐）

在 Clowder 里对任意猫说：

```
更新 dashboard
```

或

```
刷新技能列表
```

### 方式 2：手动运行脚本

```bash
cd cat-cafe-skills/update-skills-dashboard
./run.sh
```

### 方式 3：集成到定时任务

使用 `schedule-tasks` skill：

```
每天凌晨 3 点更新 skills dashboard
```

## 工作原理

1. **扫描目录**：
   - `~/.agents/skills/` (个人 skill)
   - `cat-cafe-skills/` (Clowder skill)

2. **提取元数据**：
   - 从 `SKILL.md` frontmatter 读取 name/description/triggers
   - 推断分类和风险等级

3. **生成 HTML**：
   - 保留现有样式和双语标题逻辑
   - 更新统计数据
   - 覆盖写入文件

4. **输出**：
   - 文件：`/Users/cy/Documents/03 life/AI design/产品项目/skill管理/skills-dashboard.html`
   - 访问：http://localhost:3003/api/skills/dashboard

## 配置

如需添加新的 skill 源，编辑 `scripts/generate-dashboard.ts`：

```typescript
const SKILL_SOURCES = [
  { name: 'personal', path: '~/.agents/skills', label: '个人主力' },
  { name: 'clowder', path: 'cat-cafe-skills/', label: 'Clowder 可用' },
  // 👇 添加新源
  { name: 'codex404', path: '/path/to/codex/skills', label: 'Codex404' },
];
```

## 故障排查

**问题：扫描不到某个 skill**
- 检查 `SKILL.md` frontmatter 格式是否正确
- 确认目录结构：`skill-name/SKILL.md`

**问题：中文标题显示为英文**
- 检查原 HTML 的 `SKILL_TOKEN_ZH` 词典
- Fallback 会自动生成基础中文名

**问题：页面样式丢失**
- 生成脚本会保留原 HTML 的 `<style>` 和 `<script>`
- 如原文件不存在，使用 `assets/template.html`

## 文件结构

```
update-skills-dashboard/
├── SKILL.md              # Skill 元数据
├── README.md             # 本文档
├── run.sh                # 手动运行入口
├── scripts/
│   └── generate-dashboard.ts  # 生成逻辑
└── assets/
    └── template.html     # 备用模板
```
