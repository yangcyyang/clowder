---
feature_ids: []
topics:
  - kimi
  - provider
  - cli-compatibility
  - quota
doc_kind: bug-report
created: 2026-07-26
---

# Kimi CLI 异常退出（code 1）Bug Report

## 报告人

铲屎官在 Cloudflare 授权协作中调用墨墨时看到
`Error: Kimi CLI: CLI 异常退出 (code: 1, signal: none)`，由砚砚接手诊断。

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望 Clowder 调用 Kimi 后正常回复；实际不到一秒即收到 code 1，用户侧没有完整 stderr。 |
| **2. 证据** | 原始线程中 `@kimi hi` 后约 1 秒返回 code 1；Kimi 0.29.1 对旧参数 `--print` 稳定返回 `error: unknown option '--print'`。API 3004、Web 3003、Redis、SQLite 与 Agent 注册均健康。 |
| **3. 确认根因** | 原故障是 Clowder 适配器仍传 `--print`、`--work-dir`、`--thinking`、`--mcp-config-file`，而 kimi-code 0.28+ 已删除这些参数。兼容修复已包含在 `03e681398`。当前新的真实 smoke 不再命中参数错误，但账号返回 403：本计费周期额度已用尽。 |
| **4. 诊断策略** | 先核 API/进程与任务时序，再对照当前 CLI help、源码参数和调试日志；分别用旧参数失败 smoke 与生产参数真实 smoke 区分“适配器不兼容”和“上游额度”两层问题。 |
| **5. 超时策略** | 如果生产参数 smoke 仍失败，最多追到 provider 原始 stderr；不得通过反复重试消耗额度，也不得未经铲屎官确认切换账号、购买额度或修改运行配置。 |
| **6. 预警策略** | 若 API/Redis/SQLite 不健康则回到运行时故障；若 stderr 是 401 则转登录态；若是 403 usage limit 则停止按 CLI 崩溃处理。 |
| **7. 用户可见交互修正** | 兼容修复后不再因已删除参数立即退出。当前仍需等 Kimi 额度刷新、升级套餐或由铲屎官授权切换账号/凭证后才能恢复真实回答。 |
| **8. 验收** | 当前运行进程启动时间晚于修复 commit；`kimi doctor` 通过；旧参数稳定重现 code 1；生产参数进入 provider 后明确返回 403 usage limit。额度恢复后再以 `KIMI_CLI_SMOKE_OK` 做最终绿灯。 |

## 根因分析

### 原始 code 1：CLI 参数代际不兼容

Kimi CLI 0.28+ 改为直接使用 prompt mode。旧适配器附加的
`--print`、`--work-dir`、`--thinking` 和 `--mcp-config-file`
已不在 CLI 参数表中，Commander 在发起任何模型请求之前即以 code 1 退出。

复现所得完整 stderr：

```text
error: unknown option '--print'
(Did you mean --prompt?)
```

修复 commit `03e681398` 已将调用收敛为当前支持的
`--output-format stream-json`、`--session`、`--add-dir`、
`--model` 和 `--prompt`，同时过滤成员配置中残留的四个旧参数。

### 当前阻塞：登录有效，但订阅额度耗尽

当前机器的 Kimi CLI 为 0.29.1，`kimi doctor` 确认配置文件有效。
真实 prompt 已通过参数解析并抵达 provider，说明 CLI 可执行文件、配置和登录凭证
不是本次阻塞点；上游返回：

```text
provider.api_error: 403 You've reached your usage limit for this billing cycle.
Your quota will be refreshed in the next cycle.
```

这与 401 登录失败不同，也不是 Clowder 队列卡住。原始线程的错误在消息后约一秒返回，
说明 invocation 已实际执行；当前冷却排队开关默认关闭，provider 错误会立即对用户可见。

## 已完成的恢复

1. 兼容修复 `03e681398` 已在当前源码中，运行中的 API 进程也晚于该 commit 启动。
2. Clowder 当前健康：3003 HTTP 200；`/api/ready` 为 ready，Redis/SQLite 均正常；
   `/api/cats` 返回 24 个 Agent，包含 `kimi`。
3. Kimi CLI 0.29.1 能正常显示帮助并通过 `kimi doctor`。
4. 已从 API 调试日志和 Kimi 日志取得完整 provider stderr，排除“只有泛化 code 1、无根因证据”的状态。

## 尚未恢复与下一步

当前无法用代码或重启消除 Kimi 账号的上游额度限制。最终恢复需要三选一：

1. 等当前计费周期自动刷新；
2. 由铲屎官升级或购买额外用量；
3. 由铲屎官明确授权后，切换到另一个有额度的 Kimi 账号或 API Key。

上述任一条件满足后，重新运行生产参数真实 smoke，并在 Clowder 内完成一次
`@kimi` 回归，才可把任务从 blocked 转为待验收。

## 验证证据

手工 Runtime Preflight（仓库没有 `scripts/runtime-preflight.sh`，按同字段补齐）：

```text
PORT=3004
PID=49925
START_TIME=Sun Jul 26 12:11:14 2026
HEAD=01fb175ccb624d322964676f7a200c73a5f9d632
TARGET_COMMIT=03e681398d42aa6ee0869505748e934f003bab00
PROCESS_AFTER_TARGET=yes
LOG_EVIDENCE=10 recent-log-files
```

健康检查：

```text
/api/ready: ready（redis ok，sqlite ok）
/api/cats: 24，包含 kimi
3003: HTTP 200
kimi --version: 0.29.1
kimi doctor: All checked config files are valid
API build: PASS
Kimi provider 定向测试: 15/15 PASS
```

最终真实 smoke：参数兼容已通过，但 provider 返回 403 usage limit，因此本任务当前状态为
**BLOCKED（外部额度）**。
