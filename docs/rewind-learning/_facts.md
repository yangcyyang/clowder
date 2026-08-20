---
feature_ids: [rewind-learning-clowder]
topics: [rewind-learning, clowder, multi-agent]
doc_kind: rewind_facts
created: 2026-07-07
---

# Clowder AI 倒带学习 · 事实地基 (_facts.md)

## 1. 项目定位

**Clowder AI (Cat Café)** 是一个多 Agent 协作平台。

- 把多个不同模型/家族的 AI Agent（Claude、GPT/Codex、Gemini、OpenCode、Antigravity 等）放进同一个聊天/工作空间
- 每只猫保持独立身份、记忆、工作风格
- 支持 @mention 路由、任务子线程、A2A 结构化交接、跨模型 review
- 基于 Slock-like Web UI 改造，但加入了 Cat Café 自己的协作纪律层

一句话：**不是让一只 Agent 更强，而是让多只 Agent 能有序协作。**

## 2. 技术栈与物理结构

| 层级 | 技术 | 端口/位置 |
|------|------|-----------|
| 前端 | Next.js 14.2 + React 18 | http://localhost:3003 |
| 后端 | Fastify (TypeScript) | http://localhost:3004 |
| 共享 | `packages/shared` 类型与工具 | - |
| MCP 服务 | `packages/mcp-server` (cat-cafe / collab / memory / signals) | stdio/HTTP 桥接 |
| 数据 | Redis 7+ (消息/队列/状态) + SQLite `evidence.sqlite` (证据/记忆) | 生产 / dev 分离 |
| 包管理 | pnpm 9 + monorepo | `pnpm-workspace.yaml` |
| 代码规范 | Biome + TypeScript strict，单文件 ≤350 行 | `biome.json` |

目录速查：

```
clowder-ai/
├── packages/
│   ├── api/              # Fastify 后端：消息、Agent 调度、Skill 路由、A2A
│   ├── web/              # Next.js 前端：聊天、thread、任务板、Skills Dashboard
│   ├── shared/           # 共享类型与工具
│   └── mcp-server/       # MCP 工具服务器（回调桥接非 Claude 模型）
├── cat-cafe-skills/      # Clowder 专用 skills（36+）+ external/ 外部 skill symlink
├── .cat-cafe/            # 运行时配置、项目事实源、记忆
├── docs/                 # ADR、Feature docs、SOP
└── scripts/              # 启动、同步、评估脚本
```

## 3. 核心概念（用户必须懂）

### 3.1 Cat / Agent 身份
- 每只猫有 `catId`（如 `kimi`、`opus-45`、`gpt52`）
- 角色、模型、system prompt、技能集在 `cat-template.json` + `.cat-cafe/cat-catalog.json` 中配置
- 人类用户是“铲屎官”

### 3.2 Thread / Task Thread
- `threadId`：主聊天频道
- `taskThreadId`：任务专属子线程（A2A 派任务时可创建）
- 结构已存在，但派任务时经常没 populate `taskThreadId`，导致子线程空着

### 3.3 A2A 协作协议
- 行首 `@猫名` 触发路由
- 结构化交接五件套：`What / Why / Tradeoff / Open Questions / Next Action`
- WI-8 新增第七字段：`Trust`（trusted / stale / needs_revalidation）

### 3.4 Skills 框架
- 每个 skill 是一个目录，含 `SKILL.md`（YAML frontmatter + 流程说明）
- `SkillRouter.ts` 扫描 `cat-cafe-skills/` 和外部 skill symlink，按 triggers 匹配
- 当前数百个 skills（内置数十个 + 外部 symlink）
- 命中后，在 agent system prompt 里写一句「本轮命中 skill: xxx」，agent 再读 SKILL.md 执行

### 3.5 项目事实源五件套
位于 `.cat-cafe/projects/{projectId}/`：
1. `brief.md` — 目标、验收标准、约束
2. `progress.md` — 当前阶段、完成项、待办
3. `decisions.md` — 已拍板长期决策
4. `handoff-index.md` — 交接索引
5. `handoff-log.md` — 自动化交接流水

## 4. 关键运行时流程

### 4.1 用户消息 → Agent 响应

```
用户发消息
  → web 前端 → API /api/threads/{id}/messages
  → MessageStore 持久化（Redis）
  → 若含 @mention → A2A 路由
  → QueueProcessor 调度对应 cat 的 invocation
  → invoke-single-cat.ts 调用具体 Agent CLI（Claude Code / Codex CLI / Gemini CLI 等）
  → Agent 输出写回 MessageStore
  → 前端 WebSocket / 轮询更新
```

### 4.2 Skill 路由
- 入口：`packages/api/src/domains/cats/services/context/SkillRouter.ts`
- 加载：`loadSkillRouterCatalog()` 扫描 `cat-cafe-skills/` + external symlink
- 匹配：`matchSkills(userMessage)` 做字符串匹配，最多返回 2 个 skill
- 注入：把命中 skill 名写进 agent system prompt

### 4.3 Agent 调用
- 入口：`packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- 调度：`QueueProcessor.ts`
- 启动恢复：`StartupReconciler.ts` — API 启动时扫描 Redis 孤儿 invocation，requeue 或标记失败，并发送“运行服务已恢复”通知

## 5. 当前项目状态（截至 2026-07-07 10:00）

### 已落地（带 commit）
- WI-1 A5/A6：工具广告 + SkillRouter 加载 external skills
- WI-3：复刻状态评分器 `scripts/evals/replica-state-grade.mjs`
- WI-4 (BUG-01)：系统通知移出聊天流、遥测抑制
- WI-5：pm2 环境检查与生态测试
- WI-9 心跳内核：`formatProgressHeartbeatContent` 等（但卡在 `catRegistry.get` bug）
- 抢救提交：5 笔 commit 落地，git status 已清

### 进行中 / 阻塞
- WI-6：项目五件套可选生成（接口已就位，复用 project-init）
- WI-7：Resume Trust 分级
- WI-8：上下文交接桥（75% 起草 → 85% 硬门 → 新 session 读 handoff-index）
- WI-9：进度心跳 + task-thread 意图播报（等 WI-8 后）
- WI-10：脏工作区防线（P0 治本）
- Epic A 剩余、Epic B 剩余

### 已知关键 bug
- `catRegistry.get is not a function`：QueueProcessor.ts:308 用了不存在的 `.get()` 方法，已派 P0 修复
- 脏工作区被 prestart 自动 build 上线，导致半成品弄崩生产

## 6. 关键教训（这轮迭代里反复出现的）

1. **稳定性 > 功能**：凌晨重启循环修好后，才谈得上 WI-8/9 落地
2. **证据字段级契约**：没 commit/没测试/没日志 = 没做
3. **脏工作区不能自动上线**：prestart build 必须隔离未提交改动
4. **进度外化**：Codex 闷头执行让用户焦虑，需要开工预告/task-thread 播报
5. **单一真相源**：五件套/方案/WI 规格集中在本机知识库收件箱（路径不入库）

## 7. 可迁移到其他项目的机制

- Skills 框架：把重复工作流沉淀为 skill
- A2A 五件套交接：任何多 agent 系统都需要结构化接力
- 项目事实源：`.cat-cafe/projects/{name}/` 模式
- 质量门禁：worktree → tdd → quality-gate → review → merge-gate
- Runtime 单实例保护 + Alpha 验收通道
