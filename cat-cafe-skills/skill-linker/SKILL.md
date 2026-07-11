---
name: skill-linker
display_name: Skill 关联助手
description: >
  把本地已下载的外部 skill 一键关联到 Clowder，使其可被 SkillRouter 检索和触发。
  Use when: 用户说“帮我关联 xxx skill”“加载某个 skill”“把 skill 接到 Clowder”“install skill”等。
  Not for: 创建新 skill 内容（用 writing-skills）、卸载/删除 skill、修改 skill 内部逻辑。
  Output: cat-cafe-skills/external/ 下的有效 symlink + 验证结果（列表中可见）。
  GOTCHA: 不会自动下载 skill，只关联本地已存在的目录；遇到同名内置 skill 会跳过并提示。
triggers:
  - "关联 skill"
  - "link skill"
  - "加载 skill"
  - "install skill"
  - "添加 skill"
  - "接到 Clowder"
  - "把 skill 接到"
  - "帮我关联"
---

# Skill 关联助手

把本地已有的 skill 目录通过 symlink 挂到 `cat-cafe-skills/external/`，让 Clowder 的 SkillRouter 自动加载。

## 关联前必须确认

1. **不要覆盖内置 skill**：如果名称和 `cat-cafe-skills/` 下的内置 skill 同名，拒绝创建 symlink 并告知用户。
2. **只关联，不下载**：如果本地没有该 skill，询问用户提供完整路径或先去下载。
3. **来源优先级**：agents > claude > gstack > skillstar > pi > orbitos，同名时优先用高优先级来源。

## 搜索来源清单

按顺序扫描以下目录（来源定义见 `scripts/sync-external-skills.mjs`）：

| 来源 | 路径 |
|------|------|
| agents | `~/.agents/skills/` |
| claude | `~/.claude/skills/` |
| gstack | `~/.claude/skills/gstack/` |
| skillstar | `~/.skillstar/hub/skills/` |
| pi | `~/.pi/agent/skills/` |
| orbitos | `~/Documents/03 life/AI design/OrbitOS-CN/04skill/` |

## 执行流程

### Step 1：提取 skill 名称

从用户消息中解析要关联的 skill 名称，例如：
- 「帮我关联 create-prd」 → `create-prd`
- 「link skill tdd」 → `tdd`
- 「把 skill project-init 接到 Clowder」 → `project-init`

如果名称不明确，反问用户。

### Step 2：搜索本地来源

用 Shell 在 SOURCES 中查找匹配的 skill 目录。示例命令：

```bash
find ~/.agents/skills ~/.claude/skills ~/.claude/skills/gstack ~/.skillstar/hub/skills ~/.pi/agent/skills "$HOME/Documents/03 life/AI design/OrbitOS-CN/04skill" \
  -maxdepth 2 -type d -name "SKILL_NAME" 2>/dev/null
```

注意：来源可能不存在，报错要忽略。

### Step 3：处理搜索结果

- **唯一匹配**：直接创建 symlink。
- **多个匹配**：按优先级列出候选，询问用户选哪个。
- **无匹配**：询问用户提供完整路径，或建议先去下载。

### Step 4：创建 symlink

目标目录：`cat-cafe-skills/external/{skill-name}`

```bash
cd ~/.slock/worktrees/clowder-ai-slock-like-webui
ln -s "SOURCE_PATH" "cat-cafe-skills/external/{skill-name}"
```

创建前检查：
- 目标是否已存在（文件或链接）
- 是否与内置 skill 同名
- 源目录是否有 `SKILL.md`

### Step 5：验证

调用 `cat_cafe_list_skills` 或在 shell 中检查：

```bash
ls -la cat-cafe-skills/external/{skill-name}
test -f cat-cafe-skills/external/{skill-name}/SKILL.md && echo "OK"
```

确认新 skill 出现在列表中，并汇报给用户。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 没检查内置 skill 同名 | 覆盖内置 skill，导致路由异常 | 创建前对比 `cat-cafe-skills/` 下的目录名 |
| 源目录没有 SKILL.md | SkillRouter 加载失败 | 创建前验证 `SKILL.md` 存在 |
| 用了复制而不是 symlink | 后续 skill 更新不同步 | 必须用 `ln -s` |
| 没验证就报告成功 | 用户以为已关联实际未加载 | 创建后调用 list_skills 或 ls 验证 |

## 和其他 skill 的区别

- `writing-skills`：写新 skill 或修改 skill 内容 — skill-linker 是把它挂到 Clowder。
- `sync-external-skills` 脚本：批量同步所有外部来源 — skill-linker 是单 skill 交互式关联。
- `update-skills-dashboard`：刷新 skills 列表页面 — skill-linker 是改变实际加载的 skill 集合。

## 下一步

关联成功后，用户可以直接用该 skill 的 triggers 测试是否命中；如果 skill 内容需要调整，切到 `writing-skills`。
