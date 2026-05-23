# Clowder 冷启动资源清单

这份清单用于解释 Clowder 重启、切 worktree、清浏览器缓存后，哪些本地资源必须存在，哪些只是 UI 偏好。

## 必需运行态资源

- `.env`
  - 作用：保存端口、默认 Agent、IM/微信等 connector 凭证。
  - 缺失症状：微信显示未配置、默认 Agent 回退、部分服务端能力不可用。
  - 保障：`packages/api/src/config/load-project-env.ts` 会从项目根目录加载；connector gateway 也会兜底读取项目 `.env`。

- `.cat-cafe/cat-catalog.json`
  - 作用：保存 Agent 成员、模型、mentionPatterns、资产卡绑定。
  - 缺失症状：本地 Agent 列表为空或只剩模板入口。
  - 保障：`cat-catalog-store.ts` 会在缺失时 bootstrap 空 catalog，但不会凭空恢复已有 Agent；因此这个文件必须随 runtime worktree 同步。

- `.cat-cafe/accounts.json`
  - 作用：保存模型账号绑定引用。
  - 缺失症状：Agent 存在但账号/模型绑定失效。
  - 保障：`runtime-worktree.sh` 会同步该文件。

- `.cat-cafe/credentials.json`
  - 作用：保存本地敏感凭据映射。
  - 缺失症状：需要重新授权或部分 provider 不可用。
  - 保障：`runtime-worktree.sh` 会以 `600` 权限同步该文件。

- `packages/api/uploads/`
  - 作用：保存头像、图片、附件等用户上传内容。
  - 缺失症状：头像消失、历史图片/附件打开失败。
  - 保障：默认上传目录固定为 `packages/api/uploads`；`runtime-worktree.sh` 会只补齐缺失文件，不覆盖已有文件。

## Runtime worktree 同步入口

生产/稳定运行建议用：

```bash
pnpm runtime:start
```

它会在启动前执行 `runtime-worktree.sh` 的同步逻辑，把 `.env`、关键 `.cat-cafe` 文件和 uploads 从启动源同步到 runtime worktree。

如需只同步不启动：

```bash
pnpm runtime:sync
```

启动后建议执行一次：

```bash
pnpm runtime:doctor
```

这条命令会同时检查：

- 3003 Web 是否启动，且 `cwd` 是否指向当前稳定 worktree。
- 3004 API 是否启动，且 `cwd` 是否指向当前稳定 worktree。
- `.env`、`.cat-cafe/cat-catalog.json`、`packages/api/uploads/` 是否存在。
- `/api/ready`、`/api/cats` 是否可用，Agent 数量是否大于 0。
- Web 首屏 HTML 是否已注入 `data-visual-theme="slock"`。

如果 doctor 报错，不要只刷新浏览器；优先从当前稳定目录重启完整栈。

## 当前本机运行约定

- 当前稳定开发/运行目录：`/Users/cy/.slock/worktrees/clowder-ai-slock-like-webui`
- 不建议从旧目录启动 Web：`/Users/cy/Documents/03 life/AI design/OrbitOS-CN/20_项目/clowder-ai-slock-like-webui`

原因：这两个目录是独立 worktree/clone。此前主题修复提交到了 `~/.slock/worktrees/...`，但 3003 仍从旧 Documents 目录启动，导致浏览器一直加载旧代码。

如果 3003 又出现“代码已修但页面不生效”，先检查：

```bash
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -p <PID> | grep ' cwd '
```

`cwd` 应该指向 `~/.slock/worktrees/clowder-ai-slock-like-webui/packages/web`。

## 当前端口健康检查

Clowder Web 和 API 必须同时运行：

```bash
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -nP -iTCP:3004 -sTCP:LISTEN
curl http://localhost:3004/api/ready
curl http://localhost:3004/api/cats
```

常见症状：

- 3003 存在、3004 不存在：页面能打开，但 Agent 列表为空、消息发送失败、头像/上传资源可能无法加载。
- 3003 的 `cwd` 指向旧 Documents 目录：页面样式和功能回到旧版本，Slock 主题、最近修复不会生效。
- 3004 存在但 `/api/cats` 返回空：优先检查 `.cat-cafe/cat-catalog.json` 是否同步到当前运行目录。

当前本机手动恢复方式：

```bash
cd /Users/cy/.slock/worktrees/clowder-ai-slock-like-webui
pnpm --filter @cat-cafe/api run start
pnpm --filter @cat-cafe/web exec next start -p 3003 -H 0.0.0.0
```

注意：长期建议仍使用 `pnpm runtime:start`，避免只启动前端、漏启动 API。

## 浏览器本地状态

这些状态存放在 `localStorage` / `sessionStorage`，不是系统能力的唯一来源，丢失后应有默认值：

- `clowder:visual-theme`：视觉主题。当前默认和一次性迁移均为 `slock`。
- `clowder-channel-sort-order`：频道排序。默认 `recent`。
- `cat-cafe:sidebarWidth`、`cat-cafe:chatBasis`、`cat-cafe:statusPanelWidth`、`cat-cafe:inlineThreadPanelWidth`：布局宽度。均有代码默认值。
- `clowder-pinned-sections`、project pins、collapse state：侧边栏折叠/置顶偏好。默认空。
- `cat-cafe:cvoMode`：先采访开关。默认关闭。
- `taskboard-collapsed`：任务面板折叠状态。默认进行中/阻塞展开，待办/已完成折叠。
- `clowder:message-reactions:v1`、`clowder:saved-messages:v1`：纯前端收藏/反应缓存。默认空。
- `cat-cafe-input-history`、`cat-cafe-voice-settings`：输入历史和语音偏好。均有默认/容错。

## 已知边界

- 不能把 `.env`、`credentials.json` 合并进 git 或普通文档；它们包含敏感信息，必须保持本地运行态资源。
- 如果绕过 `pnpm runtime:start`，直接从另一个 worktree 手动启动 API，需要确认 `.env`、`.cat-cafe`、`uploads` 已同步。
- 浏览器如果存过旧主题值，可能覆盖默认主题；当前已加一次性迁移，旧浏览器也会在首次加载后切回 Slock。
