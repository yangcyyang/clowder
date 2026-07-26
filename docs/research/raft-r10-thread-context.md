---
title: Raft 第十轮研判——thread 上下文机制与结论回写
doc_kind: research
created: 2026-07-26
topics: [thread, context, raft-replication]
---

# Raft 第十轮研判（原料 OrbitOS-CN/00_收件箱/clowde0707/clowder0723/raft-第10轮.md）

## Raft 实测结论 × Clowder 对照

| Raft 实测 | Clowder 现状 | 结论 |
|---|---|---|
| 被 @ 时**零自动打包** thread 内容——靠长驻会话的 push 积累 + MEMORY msg-id 面包屑 + 定点重读三层 | 猫每次派发由平台组装上下文（ContextAssembler/分层传输/ADR-024） | **架构差异，勿照抄**：Raft 的"零打包"成立是因为 agent 长驻、消息产生时就进了上下文；Clowder 猫按次唤醒，平台组装就是我们的"push 积累"等价物。谁拿第十轮来提议"砍上下文组装"就是砍错 |
| channel 范围搜索自动覆盖全部子 thread，结果显式标注 channel/thread 归属 | 搜索已覆盖全部消息并带 threadId/threadTitle 归属 | ✅ 已有；"按频道限定含子 thread"的过滤语义可作小增强（低优先级） |
| **thread 结论回写主时间线：平台无机制**，靠人肉收官报告；Raft 主动点名"这是 Clowder 可反超的点——thread 结论卡一键回写" | thread-first 默认开 → 结论天然埋在分支里，主频道只剩源消息；**但猫侧跨发工具 `cat_cafe_cross_post_message` 已存在**——管道有，缺纪律和人侧入口 | 两步走（见下） |
| 未参与的 thread 对话需检索找回 | 同理（猫上下文按需组装） | 无动作 |

## 落地两步

1. **纪律 14（本轮即入 SOP）：分支收官必回写**——多轮讨论分支得出结论/裁定后，owner 猫必须用 `cat_cafe_cross_post_message` 把一条**结论卡**（≤5 行：结论/关键证据指针/下一步）回写主频道并引用来源分支。分支=过程，主频道=结论层。这直接治 thread-first 的"结论看不见"结构性痛点，也与 B5.5（任务上浮主频道）同构：**任务归位父级，结论也归位父级**。
2. **GUI 一键回写（二波候选，Raft 点名的反超点）**：分支面板加"结论回写主频道"按钮（选中消息→生成结论卡→主频道发出+跳转引用）。排前端二波，与桌面回归等一起。

## 备注

第十轮的"暗号双变体实验"（验证未参与 thread 的投递规则）是 Raft 侧自家实验，与我方无涉，不跟进。
