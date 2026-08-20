# RAFT.build 上下文机制观察报告

**日期**: 2026-07-13  
**对象**: RAFT.build 内部工作频道（实例与 channel id 已脱敏）  
**方法**: opencli browser 登录态 Chrome → 网络抓包 + 产品层观察  
**执行**: Pi Agent  
**关联**: F004 Token 消耗治理（调研输入）

---

## 一、核心结论

**RAFT 采用服务端上下文组装架构，Client 只传增量消息。这是 RAFT 与 Clowder 在 token 效率上最根本的架构差异。**

| 维度 | RAFT | Clowder |
|------|------|---------|
| 上下文组装位置 | 服务端 | Client 端（每次重建 System Prompt + 历史） |
| 消息上行 payload | 仅新消息文本 + channelId | 全量 System Prompt + 历史 + 消息 |
| 历史管理 | 服务端 cursor 轮询 (`since_seq`) | Client 端重放 |
| 上下文窗口 | `/api/messages/context/{msgId}` 返回 7~16 条边界窗口 | 无服务端 context API，全量重放 |
| Agent 调用 | 发消息 → 服务端检测 @mention → 组装上下文 → 调 Agent | ContextAssembler 客户端拼接 → 传完整 prompt 给 Agent |

---

## 二、网络抓包证据

### 2.1 发送消息 POST（上行 payload = 仅增量）

```
POST https://api.raft.build/api/messages
Content-Type: application/json
Size: 934 bytes

{
  "channelId": "<redacted>",
  "content": "🔍 Raft context observation...",
  "senderType": "user",
  "senderId": "<redacted>",
  "mentions": [],
  "messageType": "chat",
  "taskStatus": "todo"
}
```

**关键发现**: 上行 payload 不含任何历史消息、不含 System Prompt、不含上下文。只有新消息文本 + 频道 ID + 可选 @mention。

### 2.2 消息同步（cursor 增量轮询）

```
GET https://api.raft.build/api/messages/sync?since_seq=<cursor>&limit=200&channel_id=<redacted>
Response: 1 new message (ours), 799 bytes
```

**机制**: Client 维护一个 `since_seq` cursor，每次轮询只拉增量。Client 不开 session 时不会重放历史。Agent 被 @ 时，服务端用 cursor + channelId 从数据库取历史组装上下文。

### 2.3 上下文窗口 API（边界取词）

```
GET https://api.raft.build/api/messages/context/{messageId}?channelId={channelId}
Response: {
  messages: array(7~16),  // bounded window
  hasOlder: boolean,
  hasNewer: boolean,
  historyLimited: boolean,
  channelArchived: boolean
}
```

**机制**: 以某条消息为中心取上下文窗口，有 `hasOlder`/`hasNewer` 标记是否可继续翻页。Response 带 `historyLimited` 标记（容量控制）。**不是全量历史传输**。

### 2.4 初始加载消息列表

```
GET https://api.raft.build/api/messages/channel/{channelId}?limit=50
Response: 50 messages, ~90KB
```

只在首次进入频道时加载最近 50 条。之后靠 `sync` 增量轮询。

### 2.5 WebSocket / Push

- 检测到 Service Worker (`hasSW: true`)
- 有 `Push API` 相关端点 (`/api/push/vapid-key`)
- 消息同步主要靠 REST polling (`/api/messages/sync`) + Push 通知（非 WebSocket 全双工）
- 无客户端存储的历史缓存（localStorage 干净）

---

## 三、产品层观察

### 3.1 频道结构
- **Chat / Tasks / Files** 三标签页结构
- 20 个 Agent（Kimi, Claude, GPT, Gemini 等多模型），分布在 1 台 Machine 上
- 1 个 Human（Owner），套餐档位已省略

### 3.2 线程系统
- 每条消息可有 thread replies（当前频道 24 个 thread）
- Thread 独立加载（`/api/channels/{id}/threads`）+ 独立 context API
- Thread 也是 cursor-based 增量同步

### 3.3 系统消息
- 分组折叠（"There are 2 system messages"）
- 不占用主聊天流 token

### 3.4 超长会话处理
- 消息列表 `limit=50` 限制
- context API 有 `hasOlder`/`historyLimited` 标记
- 无限滚动加载旧消息（`data-testid=message-scroller`）
- **未发现前端层面的"压缩/摘要/context window indicator"类 UI**

---

## 四、对 Clowder F004 的可借鉴点

### 立即可借鉴（架构级）

| RAFT 做法 | Clowder 对应改造 | 预期效果 |
|-----------|----------------|---------|
| Client 只传增量消息 | ContextAssembler 不再全量重建，改用 cursor-based 增量组装 | 消除 gpt52 每次 63M token 重放 |
| 服务端 `context/{msgId}` API | 新增服务端上下文窗口 API，按需取历史 | Client 端不再维护全量历史 |
| `since_seq` cursor 轮询 | Redis/SQLite 维护 per-session 消息 cursor | 历史只传一次，后续只传增量 |
| `historyLimited` 标记 | 治理层用 historyLimited 决定裁剪策略 | 从 `observe` 升级为主动裁剪 |

### 不可直接抄的部分

- **服务端上下文组装**需要架构改动（Clowder 当前是 Client 端拼接 System Prompt，Agent 运行在本地进程而非 RAFT 的 daemon）。这是 F004 二期可能的方向，但不是一期 P0 的范畴。
- RAFT 的 Agent 运行在 daemon 上（`/api/agents` 返回 runtime/machine 绑定），上下文由 daemon 进程注入。Clowder 的 Agent 是独立 CLI 进程，上下文由 ContextAssembler 作为 prompt 参数传入。

### F004 一期推荐姿态

一期（P0）固定注入按猫分级是正确方向——与 RAFT 的思路一致：**轻量猫不需要全量上下文**。建议在一期方案中加入：

1. **SystemPrompt 分级**：minimal（Pi/Kimi/点点，~500 tokens）/ standard（芝芝/宪宪，全量）/ full（Codex，含项目上下文）
2. **共享规则裁剪**：花名册、任务门禁、A2A 派工上下文对轻量猫移除
3. **评估指标**：测量分级前后的轻量猫 input token 变化

---

## 五、数据局限

- **服务端注入未观测到**：RAFT 的服务端 System Prompt 在 daemon 侧组装，网络层看不到（除非 RAFT 开源或提供 `/api/agents/{id}/prompt` debug 端点）
- **Context 策略未完全确定**：context API 返回 7~16 条，但服务端取多少条给 Agent 未知
- **未发送含 @mention 的消息**：@Agent 时的上下文组装逻辑未观测（会在频道触发 Agent 响应，污染频道）

---

## 六、洋哥备案建议（引用）

洋哥去 RAFT 频道问那边的 Claude 三个问题：

1. "每轮请求你的时候，平台给你多少条历史消息？是全文还是摘要？"
2. "你的 System Prompt 大概多长？有哪些固定的部分？"
3. "如果这个频道有 500 条消息，你还能看到前 50 条吗？还是只能看最近几十条？"

它的回答与这份网络层证据对照，就能拼出 RAFT 的完整策略。

---

*观察时间: 2026-07-13 03:31 UTC*
*工具: opencli v1.8.4 + Chrome DevTools Protocol*
