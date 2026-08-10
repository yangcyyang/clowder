---
feature_ids: []
topics:
  - kimi
  - cli-session
doc_kind: bug-report
created: 2026-07-28
---

# Kimi CLI sessionId 前缀兼容

## 报告人

铲屎官在当前线程发送 `@kimi hi` 后，系统返回 `Kimi CLI: CLI 异常退出 (code: 1, signal: none)`；砚砚接手修复。

## 复现步骤

1. Clowder 向 Kimi 续接旧 session，传入裸 UUID：`ffe7f4c3-71eb-4c3d-9a5f-139538414668`。
2. 本机新版 kimi-code 的 `~/.kimi-code/session_index.jsonl` 中实际记录为：`ses_ffe7f4c3-71eb-4c3d-9a5f-139538414668`。
3. `KimiAgentService` 原样把裸 UUID 传给 `kimi --session`，CLI 查不到 session 并退出。

期望：能续接已有 Kimi session。

实际：Kimi CLI 报 `Session not found` 并退出。

## 根因分析

Kimi CLI 0.29.x 的本地 session 索引使用 `ses_<uuid>` 或 `session_<uuid>` 形式保存 sessionId；Clowder 旧记录里保存的是裸 UUID。服务层没有在调用 CLI 前对 sessionId 做索引解析，导致传给 CLI 的 ID 和磁盘索引不一致。

## 修复方案

在 Kimi 调用前新增 sessionId 解析：

- 优先读取 `KIMI_SHARE_DIR`，兼容 `KIMI_CODE_HOME`、`~/.kimi-code`，最后回退 `~/.kimi`。
- 对裸 UUID 同时查找原值、`ses_<uuid>`、`session_<uuid>`。
- 同 workdir 命中优先；命中后把索引中的 sessionId 传给 CLI，并通过 `session_init` 回写。

未采用清理或删除 session 的方案，因为本机索引里已有可用 session，只是 ID 形态不一致。

## 验证方式

- `pnpm run build`
- `node --test test/kimi-agent-service.test.js`
- 真实本机索引纯解析：`ffe7f4c3-71eb-4c3d-9a5f-139538414668` 解析为 `ses_ffe7f4c3-71eb-4c3d-9a5f-139538414668`
