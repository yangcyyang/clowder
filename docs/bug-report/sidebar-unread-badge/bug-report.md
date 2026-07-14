# Clowder 侧边栏未读红点消失

## Bug 诊断胶囊

| 栏位 | 内容 |
| --- | --- |
| **1. 现象** | 用户发现 Clowder 左侧频道列表的未读红点消失，且新消息也不再稳定出现红点。期望是只有用户在可见、获得焦点的页面里阅读当前频道时才确认已读；未读状态在页面刷新后应可恢复。 |
| **2. 证据** | 2026-07-14 02:08 API/Web 从 `7288b4a` 后重启。runtime preflight 证明 PID 4392 晚于 HEAD 启动。最近上线窗口没有改 `RedisThreadReadStateStore` / `chatStore` / `ThreadSidebar`。Live 约 338 个 thread 只有约 91 个 `read-state` key。API 日志显示多个客户端端口为同一 thread 反复 POST `/read/latest`。对照 smoke 在已有 cursor 的后台 thread 投递 `Clowder Reminder`：API 立即返回 `unreadCount=1`，新页面 DOM 真实渲染 `.slock-unread-badge=1`。 |
| **3. 根因** | 根因 A：`ChatContainer` 在 `messages.length` 变化时无条件 POST `/read/latest`，不检查 `document.visibilityState` / `document.hasFocus()`；隐藏标签页会推进共享全局 cursor，吞掉其他页面的新未读。根因 B：`RedisThreadReadStateStore.getUnreadSummaries()` 对无 cursor thread 永久返回 0，导致 Web 内存未读在刷新后丢失，且未打开的旧 thread 无法建立以后可计数的 baseline。 |
| **4. 诊断策略** | 按“真实可见新消息 → `/api/threads` 原始 unread → Web store → DOM badge”逐层取证；并行审计回归 commits、read/delivery/mention cursor namespace 和浏览器 ack effect。 |
| **5. 超时策略** | 单一假设 20 分钟无法用代码+运行证据闭环时转向下一层；真实 Agent final 不稳定时使用可见 reminder connector 作确定性样本。 |
| **6. 预警策略** | 如果修复要求删除 cold-start guard 并把所有旧消息翻成未读，立即停止；这会产生数百个历史红点。如果 3 次修复仍在不同层暴露新共享状态问题，停止叠加补丁并升级架构讨论。 |
| **7. 用户可见修正** | 隐藏或失焦的标签页不再自动清除未读；当该页重新可见并获得焦点时，才确认当前频道已读。旧的 cursorless thread 首次 hydrate 只建立“当前为已读”的 baseline，不点亮全部历史；此后新消息可跨刷新保留红点。 |
| **8. 验收** | Web 红测：隐藏或失焦页在新消息到达时不 POST `/read/latest`，恢复可见焦点后只 ack 一次；非 2xx/网络异常也必须结算 suppression 账本并允许重试。API 红测：cursorless thread 首次 summary 返回 0 并持久化 latest baseline，后续新可见 Agent/connector 消息返回 1，用户自己的消息仍不计数。最终以定向测试、隔离 Redis、API/Web build/lint 和真实 reminder+DOM smoke验收。 |

## 报告人

- 发现：@yangcyyang
- 诊断/修复：@老者-codex
- 验收：@专家-Claude

## 复现步骤

1. 在标签页 A 打开任意频道，随后切到其他标签页/应用，使 A 隐藏或失焦。
2. 在另一页面 B 等待 A 对应频道的 Agent 可见新消息。
3. 观察 A 仍会 POST `/api/threads/:id/read/latest`，共享 cursor 被推到最新。
4. 用无 read-state cursor 的 thread 重复刷新；`GET /api/threads` 始终返回 `unreadCount=0`。

## 修复方案

1. 将读确认收口为“当前页可见且获得焦点”才能执行，并在 `visibilitychange`/`focus` 恢复时补一次 ack。
2. 保留 legacy cold-start 不翻历史未读的语义，但首次 hydrate 要把当前 latest message 持久化为 baseline，让此后新消息能稳定计数。
3. 不修改 `delivery-cursor` / `mention-ack` / reset-context 语义。

## Quality Gate Report

检查时间：2026-07-14 15:40（Asia/Shanghai）

### 愿景与验收矩阵

| # | 原始需求/边界 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 新消息重新显示左侧未读红点 | ✅ | 真实 reminder 产生 `unreadCount=1`，新页面 DOM 渲染 `.slock-unread-badge=1`；Web 未读链路定向 87/87。 |
| 2 | 隐藏或失焦标签页不能代替用户读消息 | ✅ | Web 测试分别覆盖 hidden+focused、visible+unfocused。 |
| 3 | 页面恢复可见且聚焦时只确认一次 | ✅ | `visibilitychange` + `focus` 连续事件由 ack key 去重。 |
| 4 | ack 失败不能永久吞掉红点 | ✅ | 非 2xx 与网络异常都会结算 pending suppression，attention 返回后重试；目标组件 10/10。 |
| 5 | cursorless 旧 thread 不翻出全部历史红点，但以后新消息可跨刷新保留 | ✅ | 隔离 Redis 17/17，覆盖 current baseline、下一条 unread=1、空 thread 和多实例共享 cursor。 |
| 6 | 不改变 delivery / mention / reset-context cursor | ✅ | 改动只写 `read-state:{userId}:{threadId}`；三路独立终审未发现越界。 |

### Fresh 验证结果

- Web 未读相关套件：87/87 PASS（4 files）。
- `RedisThreadReadStateStore` 隔离 Redis：17/17 PASS（`127.0.0.1:16482/15`，未连接 live 6399）。
- `read/latest` + `mark-all-read` endpoints：12/12 PASS。
- API lint/build：PASS。
- Web lint/build：PASS；lint 仅仓库既有 warning。
- Workspace recursive build（shared/api/mcp-server/web）：PASS。
- 当前 worktree 的 production build 在隔离端口 `127.0.0.1:3313` 浏览器实测：HTTP 200、Clowder 主界面正常渲染、0 page errors；截图存于 `/tmp/task-374-unread-current-build.png`，取证后已停止该临时服务。
- 目标文件 Biome：PASS；`git diff --check`：PASS。
- Web 全量：2944/3025 PASS，81 个既有失败（37 files）；失败集中于既有 UI/主题/Sidebar 基线，目标 `chat-container-read-ack-race` 为 10/10 PASS。
- 官方 `pnpm test:api:redis`：FAILED。该脚本实际执行整套 API；当前被既有 capabilities/Queue 基线以及 Node 25 与 `better-sqlite3` ABI 141/127 不匹配阻断。目标 Redis 测试单独隔离复跑为 17/17 PASS，不把官方全量写成绿灯。
- `pnpm check`：FAILED，1538 个既有错误，首批来自仓库外 `/Users/cy/.claude/skills/gstack`，另含既有 `packages/web/tsconfig.json` 格式基线；五个目标文件的 Biome 单独为 PASS。

### 设计、fallback 与工件卫生

- `designs/**/*.pen` 按 unread/sidebar/badge/374/F069 检索无匹配：⚠️ 本次有 UI 行为改动，但无设计稿，跳过视觉对照。
- quality-gate 引用的 `check-hotfix-pattern.mjs`、`check-fallback-layers.mjs` 在当前仓库不存在；已手工确认没有新增多层 fallback，并保留 @专家-Claude 跨猫终审。
- 根目录媒体/设计工件：工作树无命中；远端默认基线为 `origin/feature/slock-like-webui`（仓库无 `origin/main`），提交差异无根目录媒体命中。
- 本轮不重启 `localhost:3003/3004`；真实 DOM smoke 是诊断证据，不冒充未提交代码的 runtime 证据。
