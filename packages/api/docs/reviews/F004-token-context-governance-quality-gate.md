---
feature_ids: [F004]
topics: [quality-gate, token, context]
doc_kind: review
created: 2026-07-13
---

# F004 一期方案 Quality Gate

## 原始需求

来源：内部讨论 thread（id 已脱敏）。

> 额度消耗前的操作是否会带着大量上下文去到 LLM，导致不必要的 TOKEN 浪费；
> 需要考虑 Clowder 是否有问题。

## 范围结论

- 本轮只立案并定义 P0 注入分级契约，不修改运行代码。
- P0 直接处理可测的固定注入；P1 的历史摘要、session 分片和 Kimi 计数只立案。
- Pi 审计的成本加总仍待对账，方案没有把争议金额写成收益承诺。

## 自检

| 检查项 | 结果 |
|---|---|
| BACKLOG 与 feature 双向可定位 | 通过 |
| `minimal` 预算与保留/删除边界明确 | 通过 |
| 高风险任务只升级、不降级 | 通过 |
| 未知状态失败关闭到 `standard` | 通过 |
| shadow、遥测、回滚和 7 天观测 AC 完整 | 通过 |
| 本轮没有实现代码或运行态变更 | 通过 |
| 根目录媒体工件闸门 | 通过：13 个既有 PNG 已获授权移动归档，根目录复检无命中 |

## Artifact Hygiene

工作区根目录原有 F001、simple-webpage、skills-dashboard 的未跟踪截图，共
13 个。经内部消息明确授权，已移动到
`docs/evidence-archive/2026-07-13/`（截图本体不入库，只保留清单）；
文件名见同目录 `MANIFEST.md`。根目录媒体工件复检无命中。

## 结论

方案内容与 formal review 前置自检通过，可以发出跨家族 review；实现必须等
review 放行后另行开工。

## Review 反馈吸收

芝芝在内部 review 消息中放行方案，并提出两处 P2：
minimal 增加三类升级铲屎官条件、增加断线/额度耗尽前交接摘要。两项已补入
核心契约、Checklist 与 AC-2。P3 的 shadow 异常分支覆盖已补入 AC-5。
