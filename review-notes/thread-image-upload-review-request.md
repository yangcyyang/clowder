# Review Request: Thread 回复图片上传

Review-Target-ID: slock-like-webui
Branch: feature/slock-like-webui

## What

为 `InlineThreadPanel` 补上选图与粘贴图片入口、可移除缩略图预览，以及复用 `/api/messages` 的 multipart 发送。保留 `threadId` 和 `replyTo`，使后端现有内容块与 Agent 图片路径链路继续生效。

## Why

Thread 输入框此前绕过主频道的图片发送组件，只能发送 JSON；用户必须退回主频道发图。

## Original Requirements（必填）

> thread 回复框支持发图片：先确认主频道与 thread 面板差异；复用上传通道；支持选图和粘贴；消息显示缩略图，猫能读到图片路径。
- 来源：thread `thread_mrgqa1d4vq7yo0ir`，消息 `0001783832837914-000268-20a6168a`
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

仅支持图片，不把主频道完整的文件附件、草稿持久化和工具栏一并搬入 Thread，避免扩大本功能范围。

## Open Questions

- 请重点检查 multipart 与 `replyTo` 同时存在时的分支线程归属。
- 请检查缩略图、错误与禁用状态是否符合现有 Slock composer 工艺。

## Next Action

请进行跨家族代码审查，并明确放行或退回及原因。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/slock-like-webui/opus-48`
- Start Command: `pnpm review:start`
- Ports: `web=3201`, `api=3202`

## 自检证据

### Spec 合规

- 根因：Thread 面板自行发送 JSON，未接入主频道的 multipart 上传流程。
- 覆盖：选图、粘贴、预览、multipart 中的 `threadId/replyTo/images`；后端既有内容块及 CLI 图片路径逻辑未改动。
- 设计稿：`designs/**/*.pen` 无匹配。
- 前端预览：当前 worktree 的 `localhost:3103` 返回 HTTP 200，已向 Hub 发出预览打开事件；未改动在线 runtime。
- 门禁阻塞：Web 全量测试被既有 `HubTraceTree.tsx:391-394` 的 F056 原色审计失败阻断，与本提交无关。

### 测试结果

- `pnpm exec vitest run ...inline-thread...`：19 passed
- `pnpm exec tsc --noEmit --pretty false`：通过
- `pnpm --dir packages/api build && ... test/image-upload.test.js`：17 passed
- `pnpm --filter @cat-cafe/web build`：通过（仅既有 warnings）
- `pnpm --filter @cat-cafe/web test`：未通过，仅上述既有 F056 失败

### 相关文档

- Commit: `fd909e6 feat(web): support images in thread replies`
