---
feature_ids: [F003]
related_features: [F001]
topics: [A2A, runtime, heartbeat, task-board, failover]
doc_kind: spec
created: 2026-07-12
---

# F003: 猫级心跳与失联接管

> Status: idea | Priority: P1（协作阻断） | Owner: TBD

## Why

2026-07-12，砚砚（gpt52）在任务队列堵塞后仍被“忙碌保护”标记为忙碌，既没有开工预告也没有进度心跳；派工方多次 @ 后未获响应，其他猫无法改派，F001 建站因此停滞。它不是单个猫是否勤奋的问题，而是平台没有把“正在执行”“疑似失联”和“可安全接管”区分开。

现有规则只要求执行中的猫定期汇报，无法在猫没有任何汇报时发现失联。本功能以猫级心跳、任务 TTL 和待投递 mention 补投建立可验证的接管闭环。

## What

### 任务租约与持久化

- 每个进行中任务持久化 `owner`、`assignmentVersion`、`leaseId`、`leaseExpiresAt`、`lastHeartbeatAt`、`ttlExpiresAt` 与状态变更事件；服务重启后从该记录恢复判定，不依赖进程内计时器。
- 改派或接管必须以“当前 `assignmentVersion` + `leaseId` 仍匹配”为条件做原子更新；成功后递增版本并签发新 lease。旧 owner 的迟到心跳、完成回写或恢复流程不得覆盖已经改派的 owner、状态或 lease。
- 服务重启后先恢复任务与 pending mention 队列，再继续定时判定；已被改派的任务只恢复新 owner 的 lease，不向旧 owner 回填“进行中”。
- 工具启动、进度事件与完成事件必须携带当前 `assignmentVersion + leaseId`。工具仍在运行时，进度事件可刷新 `lastHeartbeatAt` 并续租 `leaseExpiresAt`；预计超过当前租期的长构建/测试必须以预期结束时间和原因显式续租，同时原子延长 `ttlExpiresAt`。没有匹配 lease 的旧工具事件只记审计，不得续租或改写任务。

### 状态判定

- 执行中的猫持续每 60 秒至少回写一次心跳；心跳须关联当前任务或调用，并刷新该任务的 `lastHeartbeatAt` 与 lease。
- 距最近心跳 180 秒时，任务标记为“疑似失联”，保留当前 owner 和诊断信息，不立即改派。
- 距最近心跳 300 秒时，任务进入“心跳已超时、待接管判定”；**只有同时满足该任务 TTL 已到期且不存在有效延期/续租**，才解除该任务的忙碌保护并允许派工方改派或接管。TTL 尚未到期的任务保持“疑似失联”，不得仅凭 300 秒超时抢占。
- 长构建、测试等任务可在开始时登记预期时长；工具运行期间以带 lease 的进度事件刷新心跳，预计超出原计划时必须在 TTL 到期前显式延期并记录原因，避免把正常长命令误判为失联。

### 任务与路由闭环

- 每个进行中任务有 TTL；可接管的必要条件是“心跳已超过 300 秒”**且**“TTL 已到期且未延期/续租”。TTL 与心跳阈值都必须由持久化记录计算，重启不重置计时。
- 猫级忙碌状态按 active lease 聚合：`catBusy = 存在任一 active lease`。某一任务失联只解除该任务的 lease 并允许改派，不得释放同一猫其他正常任务的忙碌保护。
- pending mention 仅在该猫**所有** active lease 均已释放、完成或被接管后，才按时间顺序自动补投，复用 F001 的 pending mention 机制；仍有任一正常 active lease 时继续保留队列，不得抢投。
- 每日对账任务板：找出无 owner、长期 in-progress、超过 TTL、疑似失联和已完成未切状态的任务，并产生可处理清单。

### pending mention 的可靠投递契约

- 每条 pending mention 在入队时持久化不可变 `mentionId` 与 `idempotencyKey`（同一条记录的重试、恢复和补投始终复用同一组值），并记录目标猫、原消息、入队顺序、`attemptId`、`deliveryLeaseId`、`deliveryLeaseExpiresAt` 与 ACK 元数据。不得在重试时新建一条逻辑相同的 mention；`attemptId` 是单调递增的投递围栏，`deliveryLeaseId` 只属于该次投递。
- 正常投递状态机为 `queued → delivering → delivered`：`queued` 表示可领投；领取时原子签发递增的 `attemptId` 与新的 `deliveryLeaseId`/投递租约并进入 `delivering`；`delivering` 表示该次尝试在途；`delivered` 表示目标已成功确认接收。除下述“租约到期回收”外，状态不得倒退或跳转。
- **唯一合法恢复路径**：投递租约到期后，worker 只能以 `mentionId + idempotencyKey + state=delivering + attemptId + deliveryLeaseId + deliveryLeaseExpiresAt` 做 CAS 回收。条件仍成立时，原子清除该 lease 并令记录回到 `queued`；随后由一次新的领取签发更大的 `attemptId` 并重新进入 `delivering`。网络失败、超时、worker 崩溃或不确定是否已送达时均不得直接重置状态或复用 attempt，只能等待该租约到期后走这条回收路径。CAS 失败即说明该记录已被 ACK、回收或取得了新 lease，当前 worker 必须停止。
- `delivered` 的唯一进入条件是收到**目标猫成功 ACK**：ACK 必须回显 `mentionId`、`idempotencyKey`、目标猫、`attemptId` 与 `deliveryLeaseId`。ACK 落库时必须以 `mentionId + idempotencyKey + state=delivering + attemptId + deliveryLeaseId + 未过期投递租约` 做原子条件更新；仅“已发送到路由/HTTP 200”、发起调用成功或发件端本地日志均不得把记录标为 `delivered`。旧 attempt 的 ACK、已过期 lease 的 ACK 或没有匹配 lease 的 ACK 一律失效，只记审计，不得覆盖新 attempt。
- 目标端须以 `idempotencyKey` 去重：同 key 的重复请求不得重复创建任务、触发调用或产生副作用，但必须能对**当前请求的 attempt/lease**返回可验证成功 ACK。这样回收后的新 attempt 可确认同一逻辑投递已经处理，而旧 attempt 的迟到 ACK 仍无法通过发送端围栏。
- 服务启动恢复时扫描 `queued` 和 `delivering`：`queued` 可正常领取；未过投递租期的 `delivering` 保持原样等待 ACK 或租约到期；已过租期的记录必须先按上述 CAS 回收，再由新 attempt 重投或以原 key 查询目标端。特别是“目标已接收并 ACK、但发件端在 ACK 落库前崩溃”的窗口，恢复流程不得直接相信旧 ACK；须等旧 lease 可回收后以原 key 新投/查询，由目标端幂等返回新 attempt 的 ACK，再原子标记 `delivered`，保证既不丢失也不重复执行。
- 按时间顺序补投的约束以持久化入队序列为准；前一条处于可恢复的 `delivering` 时不得把后续记录越过它标为已投递。

## 需求点 Checklist

- [ ] 心跳能关联猫、任务和最近活动时间
- [ ] 状态展示能区分正常执行、疑似失联和可接管
- [ ] 长任务可登记 TTL 或延期，不被错误接管
- [ ] assignment/lease 版本化，接管和改派可原子比较并更新
- [ ] 工具运行事件按有效 lease 刷新心跳和租约；长任务延期可审计
- [ ] 服务重启后恢复任务判定与 pending mention，不回滚已改派任务
- [ ] 接管后原 owner 的历史和原因可追溯
- [ ] 多任务猫的忙碌状态按任一 active lease 聚合；单任务接管不影响其他任务
- [ ] pending mention 仅在全部 active lease 释放后自动补投
- [ ] pending mention 以持久化正常路径 `queued → delivering → delivered` 投递；仅允许投递租约到期时以 `mentionId/idempotencyKey/attemptId/lease` CAS 回收为 `queued`，新 attempt 围栏旧 ACK，具备成功 ACK 和崩溃恢复保障
- [ ] 每日任务板对账可发现异常任务

## Acceptance Criteria

- [ ] AC-1：进行中任务在正常执行时每 60 秒记录一次可查询的心跳，包含猫、任务与时间戳。
- [ ] AC-2：无心跳达到 180 秒时，任务和猫状态明确标记为“疑似失联”，但尚不可被其他猫抢占。
- [ ] AC-3：无心跳达到 300 秒时，任务进入待接管判定；仅当该任务 TTL 同时到期且不存在有效延期/续租，系统才解除**该任务**的忙碌保护并允许改派。改派事件保留原 owner、最后心跳、TTL/延期状态和接管原因。
- [ ] AC-4：任务 TTL 到期但最近心跳尚未超过 300 秒时不得接管；心跳超过 300 秒但 TTL 尚未到期或存在有效延期/续租时也不得接管；两条件同时满足才可接管。
- [ ] AC-5：长构建在当前租期内持续产生带有效 `assignmentVersion + leaseId` 的进度事件时，每 60 秒刷新 `lastHeartbeatAt` 与 `leaseExpiresAt`；预计超期时显式延期 `ttlExpiresAt` 并记录原因，期间即使超过原租期也不被提前接管。
- [ ] AC-6：同一猫有两个 active lease 时，任务 A 心跳超时且 TTL 到期后只允许接管 A；任务 B 持续正常心跳时 `catBusy` 保持为真，A 期间累计的 pending mention 不得投递给该猫。
- [ ] AC-7：任务 B 完成、释放或被接管后，若该猫再无 active lease，系统才按持久化入队顺序补投 pending mention；每条记录使用不可变 `mentionId/idempotencyKey`，且不重复、不丢失。
- [ ] AC-8：每日任务板对账输出无 owner、长期 in-progress、超过 TTL、疑似失联、已完成未切状态五类任务清单，并提供处置入口。
- [ ] AC-9：以砚砚队列忙碌案例构造自动化或可重复的集成验证：180 秒出现疑似失联；300 秒仅进入待接管；TTL 到期后才可改派；全部 active lease 释放后才补投 pending mention。
- [ ] AC-10：运行态在任务卡片或派工上下文显示当前状态及最后心跳，不能仅在统计面板中查看。
- [ ] AC-11：任务执行期间连续两次 60 秒心跳均可查询，并刷新最后心跳与 lease；未到 180 秒不得标记为疑似失联。
- [ ] AC-12：用同一任务、同一旧 `assignmentVersion` 并发发起两次接管，仅一个请求成功；成功请求递增版本并留下接管事件。
- [ ] AC-13：旧 owner 在接管成功后发送迟到心跳、工具进度或完成回写，接口拒绝或记审计事件，但任务 owner、状态与 lease 保持新 owner 的值。
- [ ] AC-14：在 180 秒疑似失联、300 秒待接管以及接管完成后分别重启服务：重启后仍保留原有时间线；已改派任务不回滚给旧 owner，pending mention 按未投递状态继续补投且不重复。
- [ ] AC-15：两名投递 worker 并发领取同一条 `queued` mention 时，只有一个能原子转为 `delivering` 并签发 `attemptId=1` 与 lease。租约到期后，两名 worker 并发按 `mentionId + idempotencyKey + attemptId + deliveryLeaseId + deliveryLeaseExpiresAt` 回收时，只有一个能将其回到 `queued`；下一次领取签发更大的 `attemptId`。
- [ ] AC-16：仅目标猫回显匹配 `mentionId + idempotencyKey + attemptId + deliveryLeaseId` 且 lease 未过期的成功 ACK 后，记录才能以原子条件更新为 `delivered`；模拟“路由调用成功但无 ACK”、网络超时和错误 ACK 时，记录保持 `delivering` 至租约到期，再经 CAS 回收为可重试状态，不得误标成功或直接重置。
- [ ] AC-17：完成一次租约到期回收并签发新 attempt 后，注入旧 attempt 的迟到 ACK、旧 lease ACK 与旧 worker 的完成写入：全部必须 CAS 失败并留审计；只有新 attempt 的匹配 ACK 可使记录恰好一次进入 `delivered`。
- [ ] AC-18：模拟服务在“目标已成功处理、发件端尚未落库 delivered”时崩溃并重启：未过期的旧 `delivering` 不能被立即重投；租约到期后恢复流程以旧 attempt/lease CAS 回收，再以同一 `idempotencyKey` 签发新 attempt 重投/查询。目标只执行一次、对新 attempt 返回可验证 ACK，记录最终恰好一次进入 `delivered`。
- [ ] AC-19：模拟投递中断、投递租期超时和服务重启，只有已过期 lease 的 `delivering` 记录可安全回收；所有重试复用同一 `mentionId/idempotencyKey`、递增 `attemptId`，成功后按原入队顺序补投后续 pending mention。

## Dependencies

- F001 pending mention 重投机制为解除忙碌后的补投提供路由能力。
- 任务状态、猫运行态和消息投递需要共享可查询的时间戳与事件记录。

## Risk

- 心跳频率过高会造成噪音与不必要写入；过低会延迟接管，需以 60/180/300 秒为初始阈值并按真实任务数据复盘。
- 接管条件不严会误判长构建或外部等待，因此“180 秒仅疑似、300 秒进入待接管”与“TTL 到期且无有效延期/续租”必须同时生效；任一条件不满足都不得接管。
- 自动补投 mention 必须幂等，避免猫恢复后重复收到同一派工。
- 并发改派、旧 owner 迟到回写或服务重启恢复若不比较 assignment/lease 版本，可能出现双 owner 或把已接管任务回滚；原子条件更新是不可省略的保护。

## Open Questions

- TTL 应按任务类型提供默认值，还是只允许派工方显式填写？
- 每日对账应由服务端定时任务、值班猫还是两者共同执行？
