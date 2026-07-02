---
feature_ids: []
topics: [clowder, fix-roadmap, execution-plan, prioritization]
doc_kind: spec
created: 2026-07-01
author: 专家-Claude
status: proposed
context: "Clowder 体验层修复总执行方案（优先级 + 分阶段 + 落点 + 验收）"
---

# Clowder 修复总执行方案（优先级排序）

> 定位：把这两天所有诊断收敛成一条**可执行、按优先级排序**的修复路线。执行者 @老者-codex，验收 @专家-Claude。
> 原则：**骨架已 OK，补体验层**。别加新功能，做减法 + 补稳定/透明/收拢。
> 优先级逻辑：**先不崩(P0) → 再又快又省(P1) → 再干净透明(P2) → 再收拢顺手(P3) → 最后打磨(P4)**。
> 引用：上下文治理细节见 `docs/exec-context-governance.md`；入口依赖表见 task #282。

## 优先级总表

| 优先级 | 项 | 治的短板 | 状态 | 前置/门槛 |
|---|---|---|---|---|
| **P0** | node 锁定 + rebuild better-sqlite3 + FDA 授权 | 运行稳定性(反复重启/权限丢) | 新 | **需 yangcyyang 确认运行时变更** |
| **P1** | 上下文按需注入 L1/L2/L3 | 又贵又慢 | 已 spec(Phase1a/1b 完) | 无(接成本面板数据) |
| **P2a** | 输出闸门扩全员 + 默认开 | 主消息脏 | 半成品(Codex 已做) | 无 |
| **P2b** | 成本/运行状态常驻可见 + 慢/限流提示 | 透明度 | 半成品(面板已做) | 无 |
| **P3a** | 入口收敛(隐藏边角 + callback 分组) | 摊子大/信息架构 | 依赖表 #282 在跑 | 需 yangcyyang 圈方向 |
| **P3b** | 频道工作空间统一(Chat/Tasks/Trace/Evidence) | 工作空间散/Mission Hub 孤岛 | 新 | 无 |
| **P3c** | 设置分层(基础/能力/高级) | 设置像控制台 | 新 | P3a 之后更顺 |
| **P4a** | 移动端 390px 收尾 | 移动端挤碎 | 新(**先实测确认**) | 无 |
| **P4b** | 快车道铺开 + stale 测试清理 | 提速覆盖/红测试 | 接续 | 无 |

## P0：运行稳定性止血（最优先）
- **问题**：机器有多个 node（.uclaw v22 / homebrew 25.6.x），PM2 在不对的 node 重启 → better-sqlite3 `ERR_DLOPEN_FAILED` → 反复重启；node 升级后 FDA 授权失效 → ~/Documents EPERM。
- **落点**：PM2 ecosystem/interpreter 配置、`pnpm rebuild better-sqlite3`、macOS FDA。
- **步骤**：①锁定 interpreter 为 `/Users/cy/.uclaw/node/bin/node`（稳定路径）②用该 node rebuild better-sqlite3 ③`pm2 delete + start` 重拉 ④给该 node 授 FDA ⑤启动自检(native module + 权限)失败给明确提示。
- **验收**：pm2 ↺ 计数长期不涨；`/api/ready` 稳定 ready；~/Documents 项目文件可读。
- **门槛**：动运行时、会重启服务，**等 yangcyyang 一句确认再执行**。

## P1：上下文按需注入 L1/L2/L3（最高 ROI）
- 详见 `docs/exec-context-governance.md`（Phase 1a/1b 已完成：成本面板 + 来源占比）。
- **本阶段 = Phase 2**：默认 L1（身份+当前任务+最小历史+家规摘要）；L2 项目上下文/代码情报按需；L3 完整家规/评审按需。收拢现有 digest + SkillRouter 的零散按需逻辑成统一分层。
- **验收**：日常任务只注入 L1，用成本面板证明 token 明显降；flag 可控、零回归。

## P2a：输出闸门扩全员 + 默认开
- **现状**：Codex 输出闸门已做(commit 214dd39, CAT_CAFE_CODEX_OUTPUT_GATE, 默认关)。
- **本阶段**：①扩到所有 provider（Claude/Gemini/Kimi）②评估默认开 ③保留 liveness 信号。
- **验收**：任意 agent 长任务，主气泡不刷过程块、只留成品；过程进 trace；liveness 在。

## P2b：成本/状态常驻可见
- **现状**：成本面板已做(387cd0d/8f5ce28)，但需手动查。
- **本阶段**：主气泡常驻极简状态（`模型·effort·耗时·input`），点开看详情；撞限流/变慢时醒目提示（不再"一直思考中"）。
- **验收**：任一慢回复能一眼看出慢因；限流有明确提示。

## P3a：入口收敛
- **前置**：task #282 依赖安全表（每入口 → 能安全删/只能隐藏/不能动）。
- **本阶段**：按 yangcyyang 圈定 + 依赖表，**先隐藏入口**（边角游戏化 + 未接的 callback 分组），日常只露核心。删代码留到确认长期不要。
- **验收**：日常界面只见核心（cats/memory/projects/workspace）；隐藏项零依赖破坏。

## P3b：频道工作空间统一
- **本阶段**：Chat 主区加频道级 tabs（Chat/Tasks/Trace/Evidence）；task 加 source 反链（channel/thread/message/invocation）；Mission Hub 任务可跳回原消息。
- **验收**：从消息建 task→当前频道+Mission Hub 都见→点击跳回原消息；完成后 task 带证据。

## P3c：设置分层
- **本阶段**：14+ 面板归 基础/能力/高级；高级默认折叠；配置变更提示"只对新一轮生效"。
- **验收**：普通用户进设置不被 100+ 开关淹没；成员当前模型/候选/实际启动对齐。

## P4：打磨
- **P4a 移动端**：**先实测 390px 确认真坏**（此前是转引），真坏再改；二级导航改 drawer、主内容独占宽度。
- **P4b**：快车道铺开到更多高频任务；清 stale 测试（bootstrap 硬编码 cat "codex"→gpt52）。

## 推进顺序与依赖
```text
P0 止血（等确认，最优先）
  ↓ 并行可做：
P1 按需注入（降本）  ‖  P2a 输出闸门全员  ‖  P2b 状态可见
  ↓
P3a 入口收敛（等 #282 表 + 圈定）→ P3b 工作空间统一 → P3c 设置分层
  ↓
P4 移动端 + 快车道铺开 + 清理
```

## 不做什么
- 不加新 domain/Agent 类型；不重写 UI 视觉；不一次删代码（先隐藏）；不追移动端全功能等价。
