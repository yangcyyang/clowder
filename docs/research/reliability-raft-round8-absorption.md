---
feature_ids: [F163]
topics: [reliability, raft-absorption, retry, watchdog, circuit-breaker]
doc_kind: research
created: 2026-07-26
---

# 可靠性三问 × Raft 第 8 轮实证对照与吸收清单

> 原料：OrbitOS-CN/00_收件箱/clowde0707/clowder0723/raft-第8轮.md（2026-07-26）。
> 方法：只对照 raft-agent 标注为【实测/文档原文】的证据；"未知"如实保留——agent 对自己生成层天然盲，这轮"证明不了"本身就是关键信息。

## 一、对照表

| 问题 | Raft 可证实的 | Clowder 现状 | 差距判定 |
|---|---|---|---|
| ① 输出截断恢复 | 子代理层"terminal API error **after retries**"（文档,次数未知）；断点续写无证据 | 3-B AutoRetryScheduler 骨架已建（默认关,白名单 transient_network/cli_crash,退避 30s/120s×2）；无截断检测、无续写 | Raft 也未证实有续写——**不追高**。差距=截断没进错误分类表 |
| ② 流式静默卡死 | 模型流层超时未知；**工具执行层 default 120s / max 600s**（文档原文）；两起真实卡死均由 agent 判断+人工杀,非平台超时救 | 只有 1 小时总闹钟（invocation_timeout）,无空闲看门狗——荧荧事故白等 58 分钟 | **最大差距,最值得做**：我们自己拥有 CLI stdout 管道,看门狗可完全自建 |
| ③ 钩子死循环 | 熔断数字明确：1000 agent 上限（原文"runaway-loop backstop"）/嵌套≤1/4096 显式报错；失败后自动化仅"存草稿"（不调模型） | 各自动化各有零散护栏（重试≤2、候选≤3、幂等键）;唤醒器风暴+理智线 seal 风暴两起血案已换来 kill switch+冷却窗口 | 机制差距小,**纪律差距大**：护栏散落无清单,新自动化无强制模板 |

## 二、吸收清单（按优先级）

### R8-1 CLI 流空闲看门狗（新增,建议并入批次4-C/二波）
- 做什么：AgentService 读 CLI stdout 流处,记录"最后一次收到数据时间"；空闲超过 `CLOWDER_CLI_IDLE_TIMEOUT_SEC`（建议默认 0=关,灰度 300s）→ 杀子进程,错误文本落 "cli stream idle timeout"（注意避开 'spawn'/'budget' 关键词,防 task-run-linkage 误分类）,provider-error-classification 增 `cli_stall` 类归 transient——从而天然进入 AUTO_RETRY 白名单射程。
- 为什么先做：荧荧式卡死的止血带（1h→5min）;与批次4-C"每场新会话"互补——新会话治加载卡死,看门狗治运行中断流。
- 验收：mock 慢流测试（有数据不杀/空闲杀/env 关零行为）;golden 绿。

### R8-2 截断类进错误分类表（小,搭 R8-1 班车）
- provider-error-classification 增 `output_truncated`（识别 CLI 明确的 max-tokens/truncation 信号,各家能识别多少写多少,识别不了归 agent_error 不猜）→ 归 transient 进白名单。断点续写**不做**（Raft 无证据,成本高收益未证——写入"不做清单"）。

### R8-3 自动化护栏清单化（纪律项,并入 SOP/批次4-B 文档）
Raft 元原则两条 + 我们两起血案教训,固化为**新自动化上线模板**（缺一不准默认开）：
1. 触发上限（次数/深度,显式数字）；2. 冷却窗口（跨周期记忆——单周期检查防不住 seal 型循环）；3. kill switch env；4. 熔断/抑制必须可观测（事件或日志,"显式报错不静默截断"）；5. 真实存储路径（隔离 Redis）验过护栏才准默认开（唤醒器学费）。
存量自动化对照审计：AutoRetry(✓上限✓冷却✓开关)、auto-claim(✓上限✓幂等,无独立开关=env 白名单兼任✓)、claimed-idle-wakeup(护栏 Redis 路径失效=批次4-C 在修)、rotation 蒸馏(✓幂等后缀)、governance 重试风暴(批次4-A2 终态化在修)、LibraryRebuild(✓env✓失败下轮重试,抑制事件缺→补日志即可)。

## 三、明确不做
- 断点续写（无对标证据,检测困难）；模型流层超时调参（在 CLI 内部,我们够不着——看门狗在我们自己层面解决同类症状）；把 1000/4096 这类数字照搬（我们的并发量级不同,已有 ≤3 候选/≤16 并发等本土数字）。
