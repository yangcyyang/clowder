---
feature_ids: [F004]
related_features: [F003]
topics: [token, context, prompt, governance, cost]
doc_kind: spec
created: 2026-07-13
---

# F004: Token 消耗治理

> Status: idea | Priority: P0 | Owner: gpt52

## Why

铲屎官指出 Clowder 可能把与当前任务无关的大段上下文重复送入 LLM，造成
额度和 token 浪费。`docs/token-audit-2026-07-13.md` 的近三天审计支持两个
方向性结论：轻量任务的固定注入远大于有效输入；历史治理仍处于 observe，
未主动摘要。审计中的总成本归因尚在 Pi 对账，因此一期不以成本金额作为
设计依据，只治理可直接验证的固定注入体积。

## What

### 一期 P0：固定注入按“猫默认值 + 任务风险”分级

| Profile | 默认对象 | 用途 | 静态注入预算 |
|---|---|---|---|
| `minimal` | Pi、点点、Kimi | 只读盘点、检索、摘要、格式转换 | ≤500 tokens |
| `standard` | 普通执行猫 | 写文件、跑测试、一般工程任务 | 保持现状，后续单独测量 |
| `full` | 宪宪、芝芝、gpt52 等重工作流 | 裁定、跨猫编排、复杂实现与 review | 保持现状 |

Profile 不是由模型自行选择。服务端先取猫的默认 profile，再按任务风险升级：
只读且无外部副作用才允许 `minimal`；文件写入、代码修改、外部 API 写操作、
生产资源、权限或敏感数据任务至少升级到 `standard`；未知情况失败关闭到
`standard`，不得为了省 token 降低安全边界。

### `minimal` 的唯一核心契约

必须保留：

1. 身份与回复目标；当前 A2A 任务的 What / Why / Next Action。
2. 行动前认领任务；冲突即停止；危险操作须确认。
3. 禁止生产 Redis 6399、禁止泄露敏感信息、身份不可冒充。
4. 行首 `@` 路由规则、交付需证据、阻塞需写清缺口。
5. 当前 workspace、日期、语言与本轮命中的 skill 名称。
6. 遇到不可逆操作、愿景/方向决策或跨猫僵局时必须停止并升级铲屎官，
   不得因任务被标为 `minimal` 就自行拍板。
7. session 将断开或额度即将耗尽时，必须持久化交接摘要，至少包含当前
   What / Why / Tradeoff / Open Questions / Next Action 与已有证据位置。

默认不注入：完整花名册、完整共享家规、历史 thread 全文、无关任务列表、
完整 skill 目录、长篇 memory、其他猫的模型说明。需要额外规则时，模型通过
明确的 skill/read 工具按需读取；当前任务的必要例外由服务端追加小片段，
不得退化成重新塞入整份规则。

### 单一真相源与可观测性

- 三档共用同一份“不可删安全核心”，profile 只决定附加块，避免复制三套规则漂移。
- 每次调用记录 `contextProfile`、选择原因、升级原因，以及 rules / roster /
  history / memory / task / skill 各来源 token 数。
- 预算计算必须使用实际 tokenizer；字符数只能做预警，不能作为 AC 证据。
- 先 shadow 计算新 payload，不改变真实调用；通过安全与路由对照后再对轻量猫启用。

### 二期 P1：只立案，本期不改

- 评估 history `shadow-summary` 的启用阈值、摘要保真和回滚条件。
- 对超长 Codex session 设计分片或 fresh-start 策略。
- 接入 Kimi token 统计，并修正 Pi cache/input 归因异常。

## 需求点 Checklist

- [ ] `minimal` 静态注入经实际 tokenizer 计算不超过 500 tokens
- [ ] 安全核心、任务认领、行首路由和证据门禁在三档中一致
- [ ] 任务风险只能升级 profile，模型不能自行降级
- [ ] 无关 roster、历史、skill 列表不进入 `minimal`
- [ ] 每次调用能按来源记录注入 token 与 profile 选择原因
- [ ] shadow 对照能发现缺规则、路由差异和任务门禁差异
- [ ] 可一键回退到 `standard`
- [ ] 不可逆操作、愿景决策和跨猫僵局能升级铲屎官
- [ ] session 断开或额度耗尽前能留下可接续的交接摘要

## Acceptance Criteria

- [ ] AC-1：用实际 tokenizer 对 `minimal` 静态块测量，Pi、点点、Kimi 均 ≤500 tokens；报告列出各来源 token。
- [ ] AC-2：最小契约测试覆盖身份、任务认领冲突、危险操作确认、6399 禁令、行首 `@` 路由、证据交付、三类升级铲屎官条件与断线前交接摘要，三档结果一致。
- [ ] AC-3：只读盘点使用 `minimal`；同一猫收到写文件、外部写入、权限或敏感数据任务时，服务端在调用前升级到 `standard` 并记录原因。
- [ ] AC-4：未知猫、未知任务类型、profile 配置缺失或预算计算失败时使用 `standard`，不得静默降到 `minimal`。
- [ ] AC-5：shadow 样本至少覆盖 100 次轻量调用，并显式包含未知 catId、profile 配置缺失、任务风险未知和 tokenizer/预算计算失败等异常用例；任务完成率、路由目标和安全门禁相对现状无回归后，才能真实启用。
- [ ] AC-6：上线后连续 7 天记录 minimal 的 p50/p95 固定注入、升级率和任务失败率；任一安全/路由回归可一键回滚到 `standard`。
- [ ] AC-7：二期三项分别有评估输入、风险和验收草案，但本期不修改 history mode、session 生命周期或 Kimi provider。

## Dependencies

- 审计真相源：`docs/token-audit-2026-07-13.md`。
- Profile 选择发生在服务端上下文组装入口，不能依赖模型提示自律。
- 共享契约改动须跨家族 review 后才能实现。

## Risk

- 裁剪过度会让轻量猫漏掉安全或交棒规则；用单一安全核心、风险升级和 shadow 对照防护。
- 只按猫分级会误判同一猫的高风险任务；必须叠加任务风险，且只允许升级。
- 500-token 目标可能因 tokenizer 或动态任务片段波动；静态块硬限 500，动态片段单独计量并设调用总预算。
- 审计成本口径尚未完全对账；方案不承诺节省金额，只承诺减少可测的固定注入。

## Open Questions

- 点点的稳定 catId 是 `checklist-worker` 还是另有注册 ID？实现前从 roster 真相源解析，不硬编码昵称。
- `minimal` 的动态任务片段总预算应设 1K 还是按任务长度分桶？
- shadow 样本的“任务完成率”由自动判据、人工抽检还是两者共同计算？
