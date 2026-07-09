---
name: obsidian-connector
display_name: Obsidian 知识库连接器
description: >
  将 Obsidian vault 接入 Clowder，使其成为 Agent 可检索的只读知识库。
  Use when: 用户说“连接 400 知识库”“关联 Obsidian”“接入知识库”“加载 Obsidian”“绑定 Obsidian vault”等。
  Not for: 关联外部 skill（用 skill-linker）、修改 skill 内容（用 writing-skills）、写入 Obsidian（本 skill 只读不接写回）。
  Output: `.env` 中写入 `OBSIDIAN_READONLY_ROOTS` 配置 + 重启 API 提示 + 验证是否生效。
  GOTCHA: 环境变量写入后必须重启 `clowder-api` 才生效；不会自动扫描子 vault，需要为每个 vault 单独配置一行。
triggers:
  - "连接 400 知识库"
  - "关联 Obsidian"
  - "接入知识库"
  - "加载 Obsidian"
  - "绑定 Obsidian"
  - "连接 Obsidian"
  - "接入 Obsidian"
  - "关联 400知识库"
  - "Obsidian 只读"
  - "知识库接入 Clowder"
---

# Obsidian 知识库连接器

把 Obsidian vault 注册为 Clowder 的只读 Collection，让 Agent 通过 `search_evidence` 查询你的笔记。

## 核心知识

- Clowder 通过 `OBSIDIAN_READONLY_ROOTS` 环境变量识别 Obsidian vault
- 每个 vault 生成一个独立的只读 Collection，**不会修改原文**
- 索引在 Clowder 启动或重建时建立，日常查询走 SQLite

## 执行流程

### Step 1：确认 vault 路径

询问用户或探测常见路径：

```bash
find ~/Documents -maxdepth 3 -type d \( -name "*Obsidian*" -o -name "400知识库" \) 2>/dev/null
```

### Step 2：检查现有配置

```bash
grep -n "OBSIDIAN_READONLY_ROOTS" ~/.slock/worktrees/clowder-ai-slock-like-webui/.env
```

### Step 3：写入配置

格式：

```bash
OBSIDIAN_READONLY_ROOTS="domain:COLLECTION_ID=/path/to/vault"
```

示例：

```bash
OBSIDIAN_READONLY_ROOTS="domain:400知识库=~/Documents/03 life/AI design/OrbitOS-CN/400知识库"
```

多个 vault 用逗号分隔：

```bash
OBSIDIAN_READONLY_ROOTS="domain:400知识库=/path/1,domain:个人笔记=/path/2"
```

### Step 4：重启 API 生效

```bash
pm2 restart clowder-api
```

或按项目实际使用的进程管理命令重启。

### Step 5：验证

调用 `cat_cafe_search_evidence`，查询 `dimension=collection`，确认能返回结果。

## Quick Reference

| 用户说法 | 对应动作 |
|---|---|
| 连接 400 知识库 | 写入 `.env` + 重启 API |
| 关联 Obsidian | 同上，探测默认 vault 路径 |
| 接入知识库 | 确认 vault 路径后写入配置 |
| 加载 Obsidian | 检查并补充缺失的 vault 配置 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 没重启 API | 配置写了但搜索不到 | 必须重启 `clowder-api` |
| 路径带空格没加引号 | `.env` 解析失败 | 整行用双引号包裹 |
| 想写入 Obsidian | 只读集合不支持回写 | 用 Obsidian 自己的工具或 bridge |
| 一个 vault 配多行 | 后覆盖前 | 多个 vault 用逗号写在一行 |

## 和其他 skill 的区别

- `skill-linker`：挂外部 skill 到 Clowder — obsidian-connector 是接外部知识库
- `knowledge-engineering`：指导外部项目做文档重构 — obsidian-connector 只处理 Clowder 与 Obsidian 的连接
- `writing-skills`：写/改 skill 文件 — obsidian-connector 是具体使用场景

## 下一步

配置生效后 → 让用户用自然语言搜索测试 → 若需把 Obsidian 内容写回，单独立项
