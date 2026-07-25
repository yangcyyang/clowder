---
title: Raft 自主建 Task 触发机制——第五轮实证访谈
doc_kind: research
created: 2026-07-25
feature_ids: [F194]
topics: [task, raft-replication, sop, admission]
---

# Raft 自主建 Task 触发机制（实证访谈第五轮）

> 原始材料：OrbitOS-CN/00_收件箱/clowde0707/clowder0723/raft-task.md（raft-agent 逐条如实回答，含 SOP 原文引用与真实案例）。
> 前四轮见 clowder-raft-thread-task-design.md §5/§5B。

## 核心结论（一句话版）

Raft 的"自主建 task"主路径是 **claim 已有消息**（task = 消息 + 元数据），`task create` 反而是受限动作（仅限拆子票，建前必须查重）。判据只有一条：**满足这条消息需要"回复之外的动作"**（跑工具/改代码/留副作用）→ claim；纯回答/聊天 → 不建。

## 八问结论速览

| # | 问题 | Raft 答案要点 |
|---|------|--------------|
| 1 | 建 task 规则原文 | Decision rule（动作 vs 回复）+ 防重复三连 + 仅顶层消息可转 task（thread 内消息只是讨论上下文） |
| 2 | 工具 | claim（--number/--message-id 双形态）/create（仅子票，先查重）/update/list/unclaim |
| 3 | 普通问题会自主建吗 | 不看关键词/工作量/轮数，只看"是否需要回复之外的动作"；**灰区：为了回答而做的只读查证（查日志/读代码）算"回答"，不建** |
| 4 | 真实案例 | claim 失败案例（already assigned→不抢，等 owner 改派）恰好证明防重复在工作 |
| 5 | 字段谁定 | 标题=消息前 80 字符（平台）或 create 自定；**没有 priority/deadline 字段**；owner 可改派 |
| 6 | 回复落点 | task 自己的 thread（SOP 纪律非平台强制），过程证据全进 thread=天生审计链 |
| 7 | 中途转化 | 有——受"thread 消息不转 task"约束，形态=讨论收敛后（owner 一句 go）**另立顶层票** |
| 8 | 误建/漏建 | 本人无记录；但引用了 Clowder F194 的真实事故数据（碎片垃圾票 9 条挂 18 天、API key 进标题、in_review 堆积 55%）；口头纠正写进跨会话记忆后行为真的变了 |

## 三条复刻要点 → Clowder 对照

| Raft 要点 | Clowder 现状 | 差距/动作 |
|---|---|---|
| ① task=消息+元数据，claim 转化为主路径+原子认领 | ✅ 已对齐：任务锚定源消息、claim CAS、409 带 ownerCatId | 无 |
| ② 自动转化三件套：准入判别防碎片 + 标题脱敏 + 失败安静 | ✅ 事故后已修：准入收紧、redactSecretsInText、whisper 标题保护 | 哲学写进 SOP："宁可漏建不可滥建"（人可以补建，垃圾票稀释整个板子） |
| ③ **in_review 闭环：验收人 + 超时动力学** | ❌ 缺口：有 in_review 状态与迁移校验，但没有"谁验、多久没人验怎么办"机制（Raft 实测 29 票卡 16 票） | **批次 4 候选**：in_review 停留超时→提醒 owner/升级 Activity；任务可选 reviewer 字段 |

## 本轮落地的 SOP 补丁（task-discipline.md）

1. 纪律 1 增补灰区判据：只读查证算"回答"，不建 task；
2. 纪律 1 增补"方案先行勿即派工"：探讨阶段不建票，等 owner 明确 go；收敛后另立顶层票（thread 内消息不转 task，与批次 2-E 的无嵌套规则同构）。
