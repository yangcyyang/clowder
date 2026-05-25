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
