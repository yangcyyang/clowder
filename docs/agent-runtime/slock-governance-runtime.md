# Slock-like Governance Runtime

Clowder 的 `shared-rules.md` 不再按“所有 Agent 每次背全文”的方式理解。
它按 Slock 的成熟秘书模型分层加载：核心规则常驻，运营规则按工具箱加载，原文按需查阅。

## 分层模型

```text
P0 核心家规       → 所有 Agent 常驻，短摘要
P1 运营家规       → standard/full 工具箱注入
P2 角色/工作流规则 → 按 Agent breed、pack、skill 注入
P3 原文规则       → 用户触发或审计时读取 shared-rules.md
```

## 当前实现

- `minimal`：只注入 `GOVERNANCE_CORE_DIGEST`
- `standard`：注入完整 `GOVERNANCE_OPERATIONAL_DIGEST`
- `full`：注入完整 `GOVERNANCE_OPERATIONAL_DIGEST`，并允许 always_on / signal / guide 等重上下文继续进入
- 命中 Magic Words 时：按需读取 `cat-cafe-skills/refs/shared-rules.md` 原文，作为本次 invocation 的动态上下文注入。
- 输出格式边界：日常对话和轻量问答必须自然短答；只有任务完成、review、handoff、BLOCKED 等状态迁移才需要结构化报告。

这和 `toolPolicy` 分层一致：

- 轻度工具箱：微信默认回复、Pi、短问候、简单问答
- 中度工具箱：普通工程/需求/协作任务
- 重度工具箱：深度调研、PPT、复杂工程、跨工具任务

## 设计原则

1. **硬边界常驻**：危险操作、任务状态、正确 surface 回复、完成证据必须常驻。
2. **长规则不常驻**：完整 `shared-rules.md` 是权威原文，但不是每次调用的 prompt。
3. **角色规则按需**：工程、设计、需求、PPT 规则应走资产卡、pack 或 skill。
4. **可诊断**：上下文诊断应能看出当前使用了哪个 `toolPolicy`，从而推断家规加载层级。

## 下一步

- 把 `shared-rules.md` 拆成可机器读取的章节元数据。
- 对 Magic Words 原文注入做更细的章节定位，而不是当前的截断式原文参考。
- 后续若 `shared-rules.md` 继续膨胀，需要把角色规则拆到 asset card / skill / pack。

## 运行态诊断

每次 invocation 的 `contextBudget` 会带上：

- `governanceTier`：`core` 或 `operational`
- `governanceEstimatedTokens`：家规摘要 + 按需原文的估算 token
- `governanceSourceInjected`：本次是否因 Magic Words 注入了原文

前端 `ThreadExecutionBar` 会显示 `家规:核心` 或 `家规:运营`，hover 可看到更详细的 token 和加载块。

## Agent 注入盘点

当前 Clowder 的家规不是按 Agent 名称硬编码，而是跟随 `toolPolicy` 走：

```text
Agent 默认 toolPolicy
  ↓
route-serial / route-parallel 解析用户是否显式要求轻度/标准/重度工具箱
  ↓
buildStaticIdentity(catId, { toolPolicy })
  ↓
注入 core 或 operational 家规
  ↓
buildInvocationContext(...)
  ↓
如果命中 Magic Words，再注入 shared-rules.md 原文片段
```

典型映射：

- `minimal`：Pi、任务接收、任务拆分、微信/IM 默认轻回复、短问候自动降级。
- `standard`：Codex、Claude、Kimi、OpenCode 等工程/协作 Agent。
- `full`：PPT 设计、UI 设计、Design Harness、需要重工具和长资料的专项 Agent。

用户仍可通过提示词覆盖默认工具箱：

- `轻度工具箱`：只要核心家规和当前消息，适合快问快答。
- `标准工具箱`：带运营家规、工作区上下文和必要历史。
- `重度工具箱`：加载全量上下文和重工具，适合调研、PPT、复杂工程。

## 与 Slock 的对照

Slock 的“家规”不是一个单独的长文档，而是多层运行契约：

- Runtime/daemon：消息读取、thread 回复、task claim、reminder、freshness gate 等硬规则。
- AGENTS.md/CLAUDE.md：当前工作区的项目级规则。
- MEMORY.md/notes：长期记忆、用户偏好、项目历史。
- Skill：按任务触发的专用规则。

Clowder 当前已经复刻了前三层中的一部分：

- Runtime：有 `clowder` CLI、task 认领/更新、正确 surface 回复约束。
- 项目规则：用 `shared-rules.md` 摘要 + `toolPolicy` 分层注入。
- Skill：已有 `cat-cafe-skills` 与 Harness Skills 提示。

仍未完全复刻的是：

- Agent 级 `MEMORY.md` 持久记忆：Clowder Agent 还没有像 Slock 一样每个 Agent 独立维护可恢复记忆索引。
- Reminder/唤醒系统：Clowder 目前没有 Slock 式 author-owned reminder。
- Freshness gate：Clowder CLI 还没有 Slock 那种“先读 inbox 才能发/claim”的强新鲜度门禁。

## 当前风险与收敛规则

### 风险 1：日常回复过度结构化

原因：运营家规强调证据和 quality-gate，工程类 Agent 容易把任何回复都当成交付报告。

收敛：`GOVERNANCE_OPERATIONAL_DIGEST` 已明确：

```text
日常对话和轻量问答用自然语言短答；
只有任务完成、review、handoff、BLOCKED 等状态迁移才需要结构化报告。
```

### 风险 2：Agent 资产卡与家规冲突

优先级：

```text
用户当前指令
  > 安全/危险操作确认
  > 家规硬边界
  > Agent 资产卡
  > Skill/Pack 建议
```

如果资产卡要求固定模板，但当前只是日常问答，应优先自然短答。

### 风险 3：规则膨胀

`shared-rules.md` 原文只能按 Magic Words 或审计场景读取，不允许重新变成所有 Agent 常驻全文。

## task #179：MEMORY 与提醒唤醒闭环

### 跨会话记忆

Clowder 现在对齐 Slock 的 `MEMORY.md` 思路：每个 Agent 有一份独立持久记忆，位置为：

```text
.cat-cafe/memory/{catId}.md
```

运行时会在 `route-serial` / `route-parallel` 里读取当前 `catId` 的 memory 文件，作为 `Agent Memory（跨会话记忆）` 注入 `buildStaticIdentity()`。这保证：

- 页面刷新、API 重启后仍能读回。
- 不依赖当前 thread 历史。
- 每个 Agent 记忆隔离，避免 Codex/Kimi/Pi 互相污染。

CLI/API：

```bash
clowder memory read --cat gpt52
clowder memory write --cat gpt52 --text "# Codex Memory\n..."
PATCH /api/cats/:catId/memory
```

### 提醒 / 唤醒

Clowder 现在新增本地提醒存储：

```text
.cat-cafe/reminders.json
```

提醒到期后，API scheduler 会做两件事：

1. 在目标 thread 写入一条 `Clowder Reminder` 系统提示消息。
2. 把目标 Agent enqueue 到 invocation queue，并 `tryAutoExecute()` 自动唤醒。

CLI/API：

```bash
clowder reminder schedule --target default --cat gpt52 --time 10m --msg "检查这件事"
clowder reminder list --cat gpt52
clowder reminder cancel --id <reminderId>
POST /api/reminders
```

### 当前边界

- 这是本地 runtime 级能力，不是多设备云端提醒。
- reminder scheduler 随 API 进程运行；API 不运行时不会触发，到期后下次 tick 会补触发。
- memory 写入目前是显式 API/CLI，不做模型自动总结写入，避免未审核记忆污染。
