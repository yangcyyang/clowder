---
feature_ids:
  - F-G
topics:
  - cli-session-rotation
  - rollback
  - concurrency
  - archive-retention
doc_kind: bug-report
created: 2026-07-26
---

# CLI 原生 Session 轮转防护补强

> 当前状态（2026-08-10）：仅保留红测与设计边界。并发串行化、归档保留策略和失败回滚尚未实现，相关定向测试仍有 4 项失败；不得视为可合并或已上线。

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 现有轮转在启动新 CLI 前先把旧 session 目录改名归档。若新 CLI 未产出新的 `session_init` 就失败，Clowder 的 active 绑定仍指向旧 session id，但旧路径已经不存在；并发 invocation 还可能在等待旧 session 锁后继续使用过期绑定。归档目录没有回收策略，会持续占用磁盘。 |
| **2. 证据** | `cli-native-session-rotation.ts` 在 `maybeRotateCliNativeSession()` 内先执行 `rename()`；`invoke-single-cat.ts` 随后把本地 `sessionId` 清空，只有收到新 `session_init` 后才走 `cli_session_replaced` 封存旧链。小体量会话已验证可轮转，大体量会话仍需完成首次真实轮转验证。 |
| **3. 确认根因** | 轮转当前只有“已改名”一个阶段，没有“候选归档 → 新会话确认 → 提交”事务边界；失败路径没有补偿操作。进程级 `SessionMutex` 虽能串行同一旧 session，但等待者拿锁后没有重新读取 active 绑定。归档策略只生成文件，不定义保留期、数量或容量边界。 |
| **4. 诊断策略** | 用集成测试构造三条路径：新 CLI 无 `session_init` 即失败、两次并发读取同一旧绑定、成功轮转后清理精确匹配的历史归档。用临时目录和超过轮转阈值的稀疏文件验证 rename/size 边界，不触碰真实 session。 |
| **5. 超时策略** | 单项设计或红测 30 分钟无进展时，缩小为纯文件事务单测；连续两次无法在现有 invocation 生命周期内可靠判定提交点，则停止实现并回报需要新增显式 rotation transaction abstraction。 |
| **6. 预警策略** | 任何测试需要访问生产 Redis、真实 `~/.grok` 删除数据、修改 `.env` 或重启 runtime，立即停止；任何清理逻辑无法限定到 `.rotated-YYYY-MM-DD[-N]` 精确模式，也立即停止。 |
| **7. 用户可见交互修正** | 成功通知延后到新 `session_init` 已确认后；启动失败时明确提示旧目录已恢复。归档清理默认关闭，只有显式配置后才执行。 |
| **8. 验收** | 红测覆盖：启动失败恢复旧目录、成功启动保留归档、并发只提交一次有效轮转且等待者刷新绑定、超过阈值的稀疏目录原子改名、清理只处理精确归档且保留最新一份。定向测试、相关 session mutex/环境注册回归和 TypeScript 构建全部通过。 |

## 修复边界

- 保留现有仅 Grok、8MB 灰度，不扩展其他 provider。
- 不修改生产环境变量，不重启 runtime。
- 不删除任何真实归档；清理测试仅操作隔离临时目录。
- 完成实现后先请求跨家族审查，审查通过后再由 Owner 决定部署与配置。
