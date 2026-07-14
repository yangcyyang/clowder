# Review Request: task #378 queued user A2A 持久补投与冲突保护

Review-Target-ID: `task-378-a2a-queued-handoff`
Branch: `feature/slock-like-webui`
Commit: `d4294a9`

## What

当 A2A 行首 mention 因同线程用户消息排队而延后时，仍把 handoff 写入既有持久队列；QueueProcessor 在用户 queued/processing 全部结束后补投。只有“确实等待过用户队列”的 A2A 会进入 replay guard，显式 correction 改投发球方 durable conflict reminder，普通补充仍自动传球。

## Why

旧逻辑把公平优先级实现成了禁止 durable admission，只留下橙色 warning，没有 QueueEntry 可供队列清空时恢复，造成正常协作静默丢球。

## Original Requirements（必填）

> 用户输入优先于 A2A 这个优先级本身合理，问题在于只做了抑制、没做善后。
> 延迟重放：被抑制的 @ 进入 pending 队列，待该线程用户消息全部处理完后自动重新触发。
> 若期间用户新指令与原传球冲突，则转为提醒而非直接触发。
> 任何情况下被抑制的 @ 不再以“橙色提示 + 纯文本”为终态；正常无排队场景不回归。

- 来源：`#clowderAI:070b091a`，原始用户消息 `070b091a`
- 细化口径批准：`#clowderAI:805cc0e4`，@专家-Claude 消息 `3733f482`
- **请对照上面的摘录判断交付物是否真正消除了 A2A 静默丢球。**

## Tradeoff

- 不新增 scheduler，复用 task #366 的 durable queue、TTL、恢复与 completion 扫描。
- 不做任意 NLP 语义判断，只复用共享 Intent Snapshot correction 规则。
- history/lineage/persistence 异常时 fail-closed，宁可保留原队列项，也不误唤醒或丢失。

## Open Questions

1. 通用 dequeue、batch、manual next、immediate steer 是否还有绕过 replay guard 的入口？
2. reminder-first、durable-remove-second 是否足以覆盖 crash/重入，不会出现旧目标和发球方同时运行？
3. correction 扫描超过旧 20 条 snapshot window、异步 history read 期间插入用户工作、processing user 三类竞态是否都已锁住？
4. 非阻断风险是否可接受：读取失败仅等待下一次队列事件；超长线程扫描；同 message id 可能重复广播。

## Next Action

请 @专家-Claude 对 commit `d4294a9` 与 bug report 的 CloseGateReport 做最终 gate，按 P0/P1/P2/P3 给出 PASS 或精确阻断项。PASS 后由实现方提交文档、重建并重启本地 API，再做 ready/cats/dist smoke。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/task-378-a2a-queued-handoff/claude`
- Start Command: `pnpm review:start`
- Ports: 未启动；本票为 API queue-only，评审以 committed diff、unit tests 与 build 为准，不占用共享 3003/3004。

## 自检证据

### Spec 合规

- AC-A1 durable admission：met
- AC-A2 用户队列结束后恰好补投一次：met
- AC-A3 correction 转 reminder、普通补充不误伤：met
- AC-A4 persistence/race/manual entry fail-closed：met
- AC-A5 可见提醒与幂等 notice：met
- 结构化矩阵：`docs/bug-report/a2a-queued-user-handoff-loss/bug-report.md`

### 测试结果

```text
core relevant regression: 160 passed, 0 failed
replay guard + durable route: 11 passed, 0 failed
QueueProcessor full: 122 passed, 2 known connector batching baseline failures
API build: passed
workspace recursive build: passed
workspace lint: passed with existing warnings
targeted Biome: 11 files checked, 0 errors
git diff --check: passed
pnpm test: Web 2961 passed / 81 existing failures; API output included existing baselines
```

### 工件闸门

- 工作树根目录媒体/设计工件：空
- `origin/feature/slock-like-webui...HEAD` 根目录媒体/设计工件：空
- 无 `.pen` 改动，无前端改动，无截图要求。

### 相关文档

- Bug report: `docs/bug-report/a2a-queued-user-handoff-loss/bug-report.md`
- Task: task #378 / `#clowderAI:805cc0e4`
