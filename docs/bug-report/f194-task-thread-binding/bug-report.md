# F194 task-thread 任务绑定断层

## 报告人

- 报告人：老者-codex
- 发现方式：F194 c6b 隔离 E2E 中检查真实 Agent 工具调用时，发现 auto-task 的 task thread 内再次创建了第二张 task 和孙 thread。
- 影响提交：`5aad7af` 及之前的 F194 实现。

## Bug 诊断胶囊

| 栏位 | 内容 |
| --- | --- |
| **1. 现象** | 期望：主频道明确工作指令只生成一张 auto-task，Agent 在它的 task thread 内复用该 task。实际：`list_tasks(threadId=taskThreadId)` 返回空，Agent 随后 `create_task` 生成第二张 task。 |
| **2. 证据** | c6b root task 的 `threadId` 是 parent、`taskThreadId` 是 child；InvocationRecord 绑定 child。callback `list-tasks` 只执行 `listByThread(child)`；`create-task` 无条件在 child 创建。 |
| **3. 根因** | execution surface 已切到 task thread，但 task identity 仍只存在于 parent task；Prompt、list/update/claim/create callback 没有共享“task thread 属于哪张 task”的权威解析。 |
| **4. 诊断策略** | 逆向追踪 `admitWorkMessage → InvocationRecord → InvocationContext → callback task routes`，并与 run-ledger/QueueProcessor 已有 `taskThreadId` 反查模式对照。 |
| **5. 超时策略** | 若共享 resolver 无法同时满足权限与普通线程兼容，停止扩写补丁，回到 ExecutionRoute/InvocationRecord 持久化设计评审。 |
| **6. 预警策略** | 只改 prompt、只改 list、或第三处复制 `listByKind` 扫描均视为方向错误；多个 task 指向同一 task thread 时必须 fail closed。 |
| **7. 用户可见交互修正** | auto-task 的 Agent 会直接知道当前 taskId/owner/status/parent，不再困惑地重复建票；无 parentTaskId 的误调用会幂等返回既有 task。 |
| **8. 验收** | callback RED→GREEN；prompt binding RED→GREEN；focused/API build/CI；同一隔离 E2E 中 exactly-one-task 与 whisper body/baton/fold/真实 CLI prompt 零泄漏同时通过。 |

## 根因分析

`admitWorkMessage` 正确地把 task 保留在 parent thread，并把 Agent 的执行路由切到专用 task thread。这个模型本身不应改动：主频道 task marker、source lineage 和 Task Board 都依赖 parent 为真相源。

断层发生在后续消费面：动态 prompt 只有 child thread/message；callback actor 也只知道 child thread；task callback 则把 `task.threadId === actor.threadId` 当成唯一合法 surface。于是 Agent既看不到 parent task，也无法更新它，而 `create-task` 仍允许在 child 新建一张顶层 task。

## 修复方案

1. 增加共享 task-surface resolver：把 `task.threadId` 和 `task.taskThreadId` 视作同一 task 的两个合法 surface，同时执行 user scope 校验与多绑定 fail-closed。
2. Prompt 注入 server-derived taskId、parent/task thread、source、owner、status，并明确“已创建/已认领，禁止为同一工作再次 create”。
3. callback list/update/claim 使用同一 resolver/scope 合同。
4. auto-task 的 task thread 内，无显式 `parentTaskId` 的 `create-task` 幂等返回既有 task；显式且匹配的 `parentTaskId` 才允许合法子任务。
5. 不把 task reparent 到 child；不按标题模糊去重。
6. 普通会话的 task-store 查询异常 fail-open；同一 task thread 的多任务绑定仍按业务歧义 fail-closed。
7. 保留手工 task thread 的旧合同：仅 `work-intake:` auto-task 默认复用，手工 task 省略 `parentTaskId` 仍创建 201 顶层 task。
8. owner 校验与 freshness gate 先于成功复用；歧义/错误 parent 属于纯业务校验，重复请求稳定返回 409，不消耗 side-effect claim。

## 验证方式

- 单元/集成：task-thread alias list/update/claim、幂等 create、显式 child、跨用户/错 parent/多绑定负例。
- Prompt：current task binding 字段齐全，普通线程不误注入。
- Route：serial/parallel 最终 provider prompt 均携带权威 task binding；task-store 异常不打断普通对话，多绑定仍拒绝调用 provider。
- 回归：现有顶层 create-task 与手工 task-thread create 保持 201；disabled owner 不被幂等复用绕过；freshness stale/replay 合同保持不变；whisper task 只暴露脱敏 title/metadata。
- MCP adapter：`parentTaskId` schema 拒绝空串，handler 仅在显式 child 时转发该字段。
- 端到端：隔离 Redis、真实 CLI prompt capture、exactly-one-task、body/baton/fold 三面扫描。

## 残余风险

- 当前 task-thread 反查依赖 `listByKind('work')` 扫描；后续可增加持久化 reverse index / `getByTaskThreadId()` 优化，但不作为本次正确性门禁。
- 历史异常数据若已有多个 task 指向同一 task thread，将被安全拒绝并要求人工修复；本次不自动清理旧数据。
- 本地聚焦测试不替代隔离真实 CLI prompt、GitHub Actions 11 jobs 和 default-off live canary，三者仍按 F194 门禁顺序执行。
