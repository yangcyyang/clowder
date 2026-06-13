---
name: memory-consolidator
display_name: 记忆整理员
description: >
  定期整合所有 agent 的持久记忆文件。清理过时条目、验证已关闭决策和环境 gotcha、
  提取公共经验到 LESSONS.md。建议每周运行一次。
triggers:
  - "整合记忆"
  - "清理 memory"
  - "memory consolidation"
  - "记忆整理"
---

# 记忆整理员（Memory Consolidator）

## 目标

把 `.cat-cafe/memory/*.md` 从“个人工作笔记”整理成可长期接续的记忆层：

- 过时的当前状态要标出来。
- 已关闭决策要验证是否仍然成立。
- 环境 gotcha 要检查端口、路径、命令是否还有效。
- 多个 agent 重复踩过的坑要沉淀到 `.cat-cafe/LESSONS.md`。
- 每次整理必须输出报告，不静默改记忆。

## 输入

- 当前项目根目录。
- `.cat-cafe/memory/*.md`
- `.cat-cafe/LESSONS.md`
- 最近 git 历史和当前运行环境。

## 工作流

### 1. 扫描所有 memory 文件

列出每个 agent 的 memory 文件、大小和最后修改时间。

```bash
find .cat-cafe/memory -maxdepth 1 -name '*.md' -print0 \
  | xargs -0 ls -lh
```

快速查看每个文件的段落结构：

```bash
for f in .cat-cafe/memory/*.md; do
  echo "== $f =="
  rg '^## ' "$f" || true
done
```

### 2. 检测过时的「当前状态」

读取每个文件的 `## 当前状态` 段落，检查 `最后活跃` 日期。
距离今天超过 7 天的，标记为 stale，不直接删除。

```bash
for f in .cat-cafe/memory/*.md; do
  echo "== $f =="
  awk '/^## 当前状态/{flag=1; next} /^## /{flag=0} flag' "$f" \
    | rg '最后活跃|正在处理|上次交付' || true
done
```

整理规则：

- `最后活跃` 超过 7 天：在报告中标记 `stale`。
- `正在处理` 已明显结束：建议改成“暂无进行中任务”或最近真实状态。
- `上次交付` 与 task board/git 证据不一致：报告中列为待人工确认。

### 3. 验证「已关闭决策」

逐条读取 `## 已关闭决策`，确认该决策是否仍成立。

常用验证方式：

```bash
# 按关键词查历史提交
git log --oneline --all --grep '<关键词>'

# 查当前代码是否仍包含相关实现或约束
rg '<关键词|文件名|函数名>' .

# 查文档是否已有替代决策
rg '<决策关键词>' .cat-cafe docs cat-cafe-skills
```

处理规则：

- 仍有代码/文档证据支撑：保留。
- 已被新决策替代：不要直接删除，先在报告中标记“建议迁移/删除”。
- 无法验证：标记“需人工确认”，不要擅自清理。

### 4. 验证「环境 gotcha」

检查 gotcha 中提到的端口、路径、文件和命令是否仍有效。

端口检查：

```bash
lsof -nP -iTCP:3003 -sTCP:LISTEN || true
lsof -nP -iTCP:3004 -sTCP:LISTEN || true
lsof -nP -iTCP:6399 -sTCP:LISTEN || true
```

路径检查：

```bash
test -e '<path>' && echo 'exists' || echo 'missing'
```

命令检查：

```bash
command -v pnpm
command -v node
command -v pm2
```

处理规则：

- 仍有效：保留。
- 已失效但有替代方案：报告建议更新。
- 涉及用户配置或共享配置：只报告，不自动改。

### 5. 合并跨 agent 公共经验到 LESSONS.md

找出多个 memory 中重复出现的 gotcha、行为偏好或已验证经验。

```bash
for f in .cat-cafe/memory/*.md; do
  echo "== $f =="
  awk '/^## 环境 gotcha/{flag=1; next} /^## /{flag=0} flag' "$f" || true
done
```

合并规则：

- 至少两个 agent 都提到，或一次事故影响多个 agent，才进入 `.cat-cafe/LESSONS.md`。
- 添加前先去重：

```bash
rg '<LESSON 关键词>' .cat-cafe/LESSONS.md || true
```

- LESSONS 用短条目，不写长日志。
- LESSONS 是低优先级公共经验，不能覆盖当前用户指令、Pack 指令、输出协议或代码事实。

### 6. 输出整理报告

必须输出一份报告，供人工确认。

```text
## Memory Consolidation Report

### 扫描范围
- memory 文件数：
- LESSONS 路径：

### Stale 当前状态
- agent：
- 证据：
- 建议：

### 已关闭决策验证
- 保留：
- 建议清理：
- 需人工确认：

### Gotcha 验证
- 仍有效：
- 建议更新：
- 失效：

### 新增到 LESSONS
- 条目：
- 来源：

### 未自动修改的内容
- 原因：

### 下一步
```

## 质量标准

- 不静默删除 memory 内容。
- 不把单个 agent 的临时状态提升为公共 LESSON。
- 对共享配置、用户偏好、密钥、运行环境只报告，不擅自改。
- 每个建议都要有证据：文件、命令输出、git 记录或 task/thread 来源。
