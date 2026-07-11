# Clowder 本地启动手册

这份文档只解决一个问题：下次重新打开 Clowder 时，确保 **Web、API、Agent、头像、主题** 都完整加载。

## 1. 固定启动目录

当前本机统一从这个目录启动：

```bash
cd ~/.slock/worktrees/clowder-ai-slock-like-webui
```

不要再从旧目录启动：

```bash
~/Documents/03 life/AI design/OrbitOS-CN/20_项目/clowder-ai-slock-like-webui
```

原因：两个目录是独立 worktree/clone。代码修复在一个目录，服务从另一个目录启动，就会出现“代码修了但页面没变化”“Agent 不见了”“头像丢了”。

## 2. 标准启动方式

优先使用 `tmux` 持久会话启动完整栈，避免 Agent/终端会话结束时把 API 带停：

```bash
tmux new-session -d -s clowder-runtime \
  'cd ~/.slock/worktrees/clowder-ai-slock-like-webui && pnpm start:direct'
```

如果只是当前手动调试，也可以分别启动，但不要把它当成稳定运行方式：

```bash
pnpm --filter @cat-cafe/api run start
pnpm --filter @cat-cafe/web exec next start -p 3003 -H 0.0.0.0
```

关键要求：**3003 Web 和 3004 API 必须都在**。只启动 3003 不算启动成功。
不要用一次性 shell/PTY 直接跑 `node dist/index.js` 后就离开；这种进程可能随着执行会话结束而退出，表现为页面还在、Agent/DM 列表消失。

## 3. 启动后体检

启动完成后执行：

```bash
pnpm runtime:doctor
```

它会检查：

- Web 3003 是否启动
- API 3004 是否启动
- Web/API 是否都从正确 worktree 启动
- `.env` 是否存在
- `.cat-cafe/cat-catalog.json` 是否存在
- `~/.cat-cafe/uploads` 是否存在
- `/api/cats` 是否能返回 Agent
- Web 首屏是否已注入 Slock 主题

只有 doctor 全部 `OK`，才说明 Clowder 启动完整。

## 4. 运行时资源位置

不要把运行时资源放散在多个代码目录里。

当前统一口径：

```text
代码目录:
  ~/.slock/worktrees/clowder-ai-slock-like-webui

Agent 配置:
  ~/.slock/worktrees/clowder-ai-slock-like-webui/.cat-cafe/cat-catalog.json

本机环境配置:
  ~/.slock/worktrees/clowder-ai-slock-like-webui/.env

头像/附件/上传资源:
  ~/.cat-cafe/uploads

旧上传路径:
  packages/api/uploads -> ~/.cat-cafe/uploads
```

## 5. 常见故障判断

### 页面能打开，但 Agent 一个都没有

通常是 API 3004 没启动。

检查：

```bash
lsof -nP -iTCP:3004 -sTCP:LISTEN
curl http://localhost:3004/api/cats
```

### Slock 风格没出来

通常是 Web 3003 从旧目录启动，或浏览器加载了旧 bundle。

检查：

```bash
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -p <PID> | grep ' cwd '
```

`cwd` 应该指向：

```text
~/.slock/worktrees/clowder-ai-slock-like-webui/packages/web
```

### 头像消失

通常是 uploads 没在统一目录。

检查：

```bash
ls -ld ~/.cat-cafe/uploads
ls -ld packages/api/uploads
```

`packages/api/uploads` 应该指向 `~/.cat-cafe/uploads`。

## 6. 最小恢复流程

如果状态乱了，按这个顺序恢复：

```bash
cd ~/.slock/worktrees/clowder-ai-slock-like-webui
pnpm --filter @cat-cafe/api run build
tmux kill-session -t clowder-runtime 2>/dev/null || true
tmux new-session -d -s clowder-runtime \
  'cd ~/.slock/worktrees/clowder-ai-slock-like-webui && pnpm start:direct'
pnpm runtime:doctor
```

如果 doctor 仍报错，再按报错项处理，不要只刷新浏览器。
