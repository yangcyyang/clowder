---
feature_ids: [F194]
related_features: [F128, F167, F193]
topics: [task, thread, routing, agent-runtime, address-contract]
doc_kind: spec
created: 2026-07-18
---

# F194: Channel Task Thread Routing — 频道任务线程路由协议

> **Status**: in-progress | **Owner**: Maine Coon / Codex | **Priority**: P0

## Why

用户在主频道发出明确工作指令后，当前系统仍把「建 task、建 task thread、认领、回复归线程」交给 Agent 自己拼接。#379 只约束模型何时讨论、何时执行，并不是服务器级 admission gate；因此模型可以先开始回复，task 才晚到，首 ACK 与最终交付也会继续落在主频道。

Raft 的关键坐标是“每条消息自带精确地址，回信原样复用”。用户于 2026-07-14 明确要求把这层地址协议补进 Clowder，并于 2026-07-18 将它与自动建 task 合并为一条完整流水线：

> 主频道明确工作指令 → 自动 task + thread + 被点名 Agent claim → ACK/交付留在线程；讨论永不自动建 task；折叠行地址可精确引用。

F194 将其实现为一个服务器派生、全链路消费的执行坐标，而不是继续叠加 prompt 约定。

## Relation Detection

- **F128** 解决“猫主动创建任意独立 Thread”，不负责用户消息 admission、task owner 或回复地址。
- **F167** 解决 A2A 传球质量，不负责人类消息到 task/thread 的首次坐标建立。
- **F193** 解决发布 freshness；F194 的 reply target 必须在 invocation 开始时冻结，随后仍受 F193 发布裁决。
- **#376 / task thread 基础** 已提供 `extra.slockThread.branchThreadId`、折叠行和 `TaskItem.taskThreadId`，F194 复用而不新增第二套 Thread 实体。

结论：立新 Feature F194；相关能力是依赖，不是重复实现。

## Core Contract

```ts
type WorkAdmissionDecision =
  | { kind: 'create_from_message'; reason: string }
  | { kind: 'resume_pending_plan'; pendingPlanMessageId: string; reason: string }
  | { kind: 'reply_only'; reason: string };

interface ExecutionRouteV1 {
  version: 1;
  sourceThreadId: string;
  rootMessageId: string;
  replyTargetThreadId: string;
  mode: 'same_thread' | 'task_thread' | 'explicit_cross_thread';
  taskId?: string;
  ownerCatId?: string;
}
```

`ExecutionRouteV1` 只由服务器根据已持久化消息、TaskStore、ThreadStore 与当前用户身份派生。客户端、token 和模型都不能直接声明 `replyTargetThreadId`。

## What

### Phase A: Strict Work Admission

新增纯函数严格判定器，复用现有 Agent Intent Snapshot 的分类入口与类型，但使用 `auto-task` 严格模式：

1. 先否决疑问、讨论、状态查询、问题报告、转述、未满足条件、否定/暂停和纯备忘。
2. 再识别显式执行口令或行首 `@Agent + 具体祈使动作`。
3. 批准信号不能凭空建 task；只有上下文提供明确挂起方案时返回 `resume_pending_plan`。
4. 不确定一律 `reply_only`，不靠模型猜测补全。

服务器在用户消息 durable append 后、InvocationRecord/Agent 调用前完成 admission。明确任务使用稳定 subject `work-intake:<sourceThreadId>:<rootMessageId>` 原子 upsert，保证同一消息最多一个 work task。自动建 task 只在主频道/DM 顶层人类消息上触发；task thread、inline branch、Agent/callback/system 消息不递归触发。

Owner 规则：

- 唯一明确目标 Agent：服务器原子写入 `ownerCatId + doing`，并记录同一 task claimed event。
- 没有明确目标：可以建未认领 task，但不得擅自选 Agent。
- 多个目标且没有唯一 owner：首版 fail-quiet，不建 task。

admission 创建失败时不启动 Agent invocation，给当前用户一个去重的人话错误；不得出现“Agent 已开工但 task 不存在”。

### Phase B: Exactly-Once Task Thread Link

work task 创建时原子确保一个 task discussion thread，并将 parent root 的 `extra.slockThread.branchThreadId` 链接到 `taskThreadId`。task source copy 必须保留：

- `content/contentBlocks/mentions/metadata/origin/source`
- `visibility/whisperTo/revealedAt`
- 任务来源与 parent root 的稳定关联

TaskStore 必须提供 source/subject 唯一约束；thread 建立使用 get-or-create/CAS，claim 使用“owner 为空或等于目标 Agent”条件更新。重复 HTTP、队列重放、双并发均只产生一个 task、一个 task thread、一个 create notice、一个 claim event。

自动 task admission 完成后，首轮 invocation 在 task thread 上运行，并以 task-thread source copy 作为 `currentUserMessageId`。这样 ACK、callback、stream final、draft、freshness、A2A 与错误都自然复用现有同线程写回路径；不采用“先写主频道再复制”的镜像方案。

### Phase C: Thread Address Contract

折叠行提供地址引用入口，v1 token 为：

```text
#频道显示名:<fullRootMessageId>
```

- UI 可以截断展示，但 clipboard/composer 必须使用完整 root message ID。
- 频道显示名用于人类辨识，不是权限凭证；服务端以 root message ID + root 所属 thread 为权威。
- “引用”动作把 token 插入当前主频道 composer；“复制”动作写 clipboard；折叠行原有“打开 Thread”行为不变。
- Markdown 渲染把合法 token 显示为可点击地址，点击打开对应 thread；无权限 viewer 不渲染地址入口。

服务端只解析当前人类入站消息正文中的一个明文 token。代码块、引用块、Agent 输出、callback/system 消息中的 token 不参与解析。多 token、畸形、删除 root、陈旧 branch、跨用户或不可见 whisper 均 fail-closed，并停止该轮 invocation；错误文案不泄漏目标是否存在。

显式跨 thread 地址不会伪装成普通同线程写回：服务器派生 `mode=explicit_cross_thread`，沿用 cross-post scope 校验与 `extra.crossPost` 审计。ACK 可以写预先绑定的 reply target，但模型任意传入的 threadId 仍受现有权限规则约束。

### Phase D: Conversation Placement and Rollout

主频道保留：

1. 用户原始 root message；
2. 单一 task badge / 折叠 marker；
3. 当前 viewer 可见的 reply count、最新摘要和未读状态。

task 讨论、ACK、进度、交付、错误与后续往来只在 task thread。主频道禁止 substantive duplicate；同 task/status 更新覆盖已有 entity，不追加进度流水账。

自动 admission 与地址路由分别有默认关闭的 rollout flag。发布顺序：纯函数语料 → store/route integration → Web UI → 本地 E2E → Claude gate → canary。任何环节异常均回到现有手工转 task / 当前 thread 行为，但已解析到无效地址时绝不回落误投。

## Design Gate

### Design-in-Context

- 已读现有结构：`ChatMessage.tsx` 的 `ThreadReplyBadge`（折叠行）、`ChatContainer.tsx` 的 inline/task thread 打开链路、`InlineThreadPanel.tsx` 的 panel header/composer。
- 现有折叠行是一整行 open button，含 reply count、最新摘要、未读点和尾部箭头；新能力与旧入口共存。
- 选定形态：折叠行右侧保留打开入口，并增加紧凑引用/复制 action；不用再造全局地址面板。
- 备选形态：放进 MessageActions overflow，密度更低但发现性差，且脱离“门牌”发生现场，否决。
- 桌面与窄屏：摘要继续 truncate；引用/复制 action 固定最小触控区，不挤压 reply count；mobile panel 仍全屏。
- 空态：replyCount=0 时 task badge 是实体入口；首次 ACK 后出现折叠 marker。陈旧/无权 target 不显示地址 action。
- 视觉：复用现有 border/surface/focus Design Token，不新增硬编码色与 z-index。
- `docs/canon/meta-aesthetics.md` 在当前仓库不存在；本设计仍按“一个执行坐标替代多处镜像补丁”的坐标变换原则自检，并把缺失 canon 记为文档基线问题，不阻塞 F194。

### In-Context Observability

1. 任务发起者与被点名 Agent 第一时间需要看到 admission/route 结果。
2. 第一现场是 root task marker 与 task thread 自身；不要求用户去 dashboard 查数字。
3. 类比现有 task entity 自带 status 与 inline thread 未读摘要。
4. 若只能保留一个 surface，保留 in-context root/thread。
5. dashboard/日志只用于事后审计 classifier reason、idempotency 与权限拒绝。

```yaml
in_context_observability:
  primary_surface: "主频道 root 的单一 task/Thread marker + task thread 内真实对话"
  why_not_dashboard_only: "用户必须在发出指令的现场立刻知道是否已建 task、由谁接手、回复将落在哪里"
  deep_dive_surface: "结构化日志与 invocation/task audit，用于追查 classifier、幂等和权限拒绝"
  noise_dedup_policy: "同 rootMessageId 只保留一个 task/marker；状态覆盖 entity；失败按 source+reason 去重，不复制进度正文"
```

### Approved Sources

- 用户消息 `24820393`：批准 Thread Address Contract 纳入执行计划。
- 用户消息 `26186a8b` / `c810b644`：要求分工并安排 Codex 执行。
- Claude 消息 `9ee2da18`：锁定自动 task + 地址协议 + 对话归线程的合并范围与验收。

## Acceptance Criteria

### Phase A（Strict Work Admission）

- [ ] AC-A1: 52 条供货语料 + 反问/转述/条件各 2 条负例参数化通过；批准 4 例只有 pending-plan fixture 时才 resume。
- [ ] AC-A2: 讨论、疑问、状态、问题报告、否定、转述、条件和非人类消息均为零 task/零 thread。
- [ ] AC-A3: 单一行首 @Agent 的明确任务在 invocation 前得到 exactly-one work task、owner+doing 与 claim event。
- [ ] AC-A4: admission 失败不启动 invocation；无目标明确任务可未认领，多目标不明确 fail-quiet。

### Phase B（Exactly-Once Task Thread Link）

- [ ] AC-B1: 重试/并发/队列重放只产生一个 task、一个 task thread、一个 create notice 与一个 claim event。
- [ ] AC-B2: root `extra.slockThread.branchThreadId === task.taskThreadId`，刷新/Redis round-trip 后不丢。
- [ ] AC-B3: task source copy 保留 public/whisper/attachment/mentions/visibility 语义；无权 viewer 不泄摘要或地址。
- [ ] AC-B4: 自动 task 首轮 invocation 使用 task thread + copy message ID；ACK、自然 final、callback final 均只落 task thread，root substantive agent reply 为零。

### Phase C（Thread Address Contract）

- [ ] AC-C1: 折叠行可引用/复制完整 token；刷新后保持；desktop 与 390px 可用且无嵌套 button/a11y 回归。
- [ ] AC-C2: 单一合法 token 精确解析 root→branch；点击 token 打开相同 branch。
- [ ] AC-C3: 畸形/多 token/删除/陈旧/无权限/不可见 whisper 地址 fail-closed，不启动或继续误投，不泄存在性。
- [ ] AC-C4: 显式 cross-thread ACK/final 只落目标 thread，并保留 crossPost 审计；replyTo 只能引用目标 thread 内消息。

### Phase D（Conversation Placement and Rollout）

- [ ] AC-D1: 真实 E2E：主频道单一明确 @Agent 工作指令 → 自动 task/thread/claim → ACK + 交付在线程 → 主频道仅 root + 单一 marker。
- [ ] AC-D2: 真实负例：同频道讨论消息 → task 数量不变、无 task thread、正常讨论回复仍在当前 thread。
- [ ] AC-D3: rollout/canary 默认关闭；关闭时现有手工 As Task、inline thread、#374/#376 未读与折叠契约不回归。
- [ ] AC-D4: API/Web build、目标测试、完整 required gates 与隔离 canary 全绿后，才允许进入 Claude merge gate。

## 需求点 Checklist

| ID | 需求点（铲屎官原话/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “主频道明确工作指令→自动建 task+开线程+被点名猫 claim” | AC-A1~A4, AC-B1 | classifier/unit/integration/E2E | [ ] |
| R2 | “讨论类永不自动建” | AC-A1, AC-A2, AC-D2 | 参数化负例 + live negative | [ ] |
| R3 | “折叠行可引用 token→replyTargetThreadId” | AC-B2, AC-C1~C3 | API/Web tests + UI | [ ] |
| R4 | “猫的 ack 和交付自动落 task 线程” | AC-B4, AC-C4, AC-D1 | serial/callback/E2E | [ ] |
| R5 | “跨线程走 cross_post+权限” | AC-C3, AC-C4 | auth/metadata tests | [ ] |
| R6 | “task 相关往来留线程，主频道只见折叠标记” | AC-D1, AC-D3 | Web/API E2E + unread regression | [ ] |
| R7 | “canary 默认关；Phase 0→矩阵→RED/GREEN→Claude gate” | AC-D3, AC-D4 | config test + review evidence | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有可执行验证方式。
- [x] 前端需求已有需求→证据映射（AC-C1、AC-D1、AC-D3）。

## Dependencies

- **Evolved from**: F128（复用 thread creation，不扩展任意猫主动建 thread）
- **Related**: F167（A2A 与球权继续消费同一 execution route）
- **Related**: F193（reply target 在 invocation 起点冻结，发布仍过 freshness gate）
- **Related**: task #376（复用折叠行与 viewer-safe reply summary）
- **Related**: task #379（复用 intent snapshot，但服务器严格判定独立 fail-quiet）

## Risk

| 风险 | 缓解 |
|------|------|
| regex 把问题/转述/条件当任务 | 否决优先、typed decision、58 条语料、fail-quiet |
| 同消息生成重复 task/thread/claim | source subject 唯一键 + store CAS + 并发集成测试 |
| task source copy 泄漏 whisper | 完整复制 visibility 字段；viewer-safe summary/address 测试 |
| 无效地址静默回落主频道 | 解析后 fail-closed；错误不泄目标存在性 |
| prompt-only 导致部分出口仍写 root | 自动 task 直接在 task thread invocation；显式地址使用 server-bound route |
| rollout 影响旧手工流程 | 双 flag 默认关；关闭态回归 #374/#376/As Task |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 无 mention 的明确任务是否应自动选默认 Agent？ | 已定：不选，建未认领 task |
| OQ-2 | 多 Agent 明确工作是否首版拆多票？ | 已定：不拆；owner 不唯一时 fail-quiet |
| OQ-3 | token 使用 full ID 还是短 ID？ | 已定：v1 clipboard/composer 使用 full rootMessageId |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 一个 `ExecutionRouteV1` 贯穿 admission、invocation、egress | 避免 task、地址、写回三套半协议 | 2026-07-18 |
| KD-2 | 自动 task 在 task thread 执行，不镜像输出 | 复用同线程全出口，避免重复与漏出口 | 2026-07-18 |
| KD-3 | 地址 token 是定位符，不是权限凭证 | 防止伪造 branchThreadId 越权 | 2026-07-18 |
| KD-4 | classifier typed + fail-quiet | 批准恢复与新建任务语义不能混成 boolean | 2026-07-18 |
| KD-5 | 主频道 entity-self，线程内对话 | 保持 Raft 式频道洁净与现场可感知 | 2026-07-18 |

## Alternatives Rejected

1. **仅靠 prompt 要模型建 task/cross-post**：无法保证首 ACK、自然 stream final、错误和回调出口一致。
2. **Agent 先在主频道执行，再把回复镜像到 task thread**：制造双真相、未读重复与 privacy/freshness 旁路。
3. **沿用 Web `onSend → POST task` 两步**：存在 invocation 先启动、task 后创建的竞态。
4. **token 直接携带 branchThreadId 并视为授权**：泄漏内部坐标且绕过 root/viewer 权限。

## 收敛检查

1. 否决理由 → ADR？有 → 已记录在本 Feature 的 `Alternatives Rejected`，当前不另建跨 Feature ADR。
2. 踩坑教训 → lessons-learned？没有；实现/验收若发现新坑再补。
3. 操作规则 → 指引文件？没有；这是产品协议，不修改 Agent 通用家规。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-14 | 用户批准 Thread Address Contract 纳入执行计划 |
| 2026-07-18 | 用户要求分工；Claude 将自动 task、地址协议、对话归线程合并交给 Codex |
| 2026-07-18 | Phase 0 取证、关系判定、设计矩阵与 F194 立项 |

## Review Gate

- Phase A：classifier 语料与 admission 时序独立 review。
- Phase B：store 并发/隐私与 route binding 独立 review。
- Phase C：权限、无效地址、UI/a11y 与 #374/#376 回归独立 review。
- Phase D：Claude merge gate + 默认关闭 canary；PASS 前不合 canonical、不碰 live。

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F128-cat-create-thread.md` | 现有 thread creation 边界 |
| **Feature** | `docs/features/F167-a2a-chain-quality.md` | A2A 路由质量边界 |
| **Feature** | `docs/features/F193-output-publication-freshness-hold.md` | 发布 freshness 边界 |
| **Roadmap** | `docs/ROADMAP.md` | 活跃 Feature 索引 |
