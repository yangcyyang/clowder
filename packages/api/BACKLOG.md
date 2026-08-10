---
topics: [backlog]
doc_kind: note
created: 2026-05-15
---

# Feature Roadmap

> **Rules**: Only active Features (idea/spec/in-progress/review). Move to done after completion.
> Details in `docs/features/Fxxx-*.md`.

| ID | Name | Status | Owner | Link |
|----|------|--------|-------|------|
| F001 | @ 目标忙碌时 mention 应在其空闲后自动重投 | idea | TBD | docs/features/F001-mention-redelivery-on-idle.md |
| F002 | 排查消息管道吞掉本地绝对路径 | idea | TBD | docs/features/F002-inline-code-path-loss.md |
| F003 | 猫级心跳与失联接管 | idea | TBD | docs/features/F003-agent-heartbeat-and-failover.md（60s 心跳 / 180s 疑似 / 300s 可接管；含 TTL、补投、重启持久化与原子 lease） |
| F004 | Token 消耗治理 | idea | gpt52 | docs/features/F004-token-context-governance.md + docs/features/F004-phase2-context-governance-draft.md — P0 固定注入分级；P1 历史 shadow-summary、超长 session 分片与计数接入 |
