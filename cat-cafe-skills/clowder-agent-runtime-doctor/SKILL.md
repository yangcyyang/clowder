---
name: clowder-agent-runtime-doctor
description: >
  Clowder Agent 运行态检查与修复流程。Use when: 左侧 DIRECT MESSAGES 显示”暂无 Agent”、
  @Agent 不触发、/api/cats 为空或失败、3004 API 不通、重启后 Agent/主题/功能没加载、
  Claude agent 报 401 鉴权失败、服务崩溃连不上。
  Output: 根因结论 + 最小修复 + 验证证据 + 后续防复发建议。
triggers:
  - “暂无 Agent”
  - “检测不出 agent”
  - “链接不上 agent”
  - “刷不出 agent”
  - “/api/cats”
  - “3004”
  - “Agent 不见”
  - “clowder 挂了”
  - “clowder 崩溃”
  - “重启 clowder”
  - “Clowder 白屏”
  - “401”
  - “Failed to authenticate”
---

# Clowder Agent Runtime Doctor

用于处理 Clowder “Agent 不见了 / 连不上 Agent / @Agent 不触发”这类运行态问题。

核心原则：**先判定 API 是否活着，再看前端显示。**
前端可能显示缓存页面，但 Agent 列表来自 `/api/cats`，API 3004 不通时左侧会显示“暂无 Agent”。

## 快速诊断

在 Clowder worktree 根目录执行：

```bash
pnpm start:status
curl -sS http://127.0.0.1:3004/api/ready
curl -sS http://127.0.0.1:3004/api/cats | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); const a=j.cats||j; console.log(a.length); console.log(a.map(c=>c.id).join(', '));})"
curl -sS -I http://127.0.0.1:3003 | head
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -nP -iTCP:3004 -sTCP:LISTEN
pm2 status
pm2 logs clowder-api --lines 80 --nostream
pm2 logs clowder-web --lines 80 --nostream
tail -n 120 cat-cafe-daemon.log
```

## 判定规则

- `3003 running` 但 `3004 not running`：Web 是空壳，Agent 一定加载不出来。
- `/api/ready` 失败：先修 API，不要改前端。
- `/api/cats` 返回 0 或请求失败：检查 `CatRegistry initialized` 日志和 `.cat-cafe/cat-catalog.json`。
- 日志出现 `better-sqlite3 NODE_MODULE_VERSION`：Node ABI 不兼容，需要用当前运行 Node 重新编译 native module。
- Web 仍显示旧状态但 `/api/cats` 正常：让用户 `Cmd+Shift+R` 硬刷新，或重启 3003。
- `pm2 status` 显示 `clowder-api/clowder-web online` 且 `/api/ready` 正常：后端没崩；优先判断浏览器缓存、Electron 桌面壳或前端运行时异常。
- PM2 `↺` 重启次数增加但当前 online：服务已被 PM2 拉起；要从 `pm2 logs` 找上一次退出原因，而不是盲目反复重启。

## 启动自检为什么可能没兜住

`better-sqlite3` 自检只在 `start-dev.sh` 启动阶段运行。

如果当前服务是一个早已启动的 `tsx watch` / direct API 进程，后续代码热重载只会让 API 子进程重跑，
**不会重新进入 `start-dev.sh` 的 native module 自检阶段**。这时 Node 版本或 native module ABI 变化后，
watch 进程会反复拉起 API，又反复在 `better-sqlite3` 加载处 crash。

判断证据：

```bash
ps aux | rg "tsx watch src/index.ts|packages/api|start-dev"
tail -n 120 cat-cafe-daemon.log
```

如果看到 `tsx watch src/index.ts` 仍在，但 3004 没监听，必须做完整 runtime restart，
不能只等热重载自愈。

## 修复步骤

### 1. native module 不兼容

优先使用启动脚本自检：

```bash
pnpm start:direct --quick
```

如果仍失败，手动重编译：

```bash
pnpm rebuild better-sqlite3
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('ok')"
```

注意：重编译必须使用和 API 启动一致的 Node 版本。

### 2. 端口残留或旧 Web 进程

先确认监听进程：

```bash
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -nP -iTCP:3004 -sTCP:LISTEN
```

如果 3003 是旧进程、3004 已挂，可以释放旧端口后重启：

```bash
pnpm stop
pnpm start:direct --quick
```

如果 `pnpm stop` 只清理 stale daemon，没有杀掉 direct 进程，再按 PID 精准停止占用 3003/3004 的旧进程。

如果 `pnpm start:status` 显示 daemon stale，但 `direct api-3004/web-3003` 正常，说明服务已经可用，
但后台管理 PID 不干净；先向用户说明“不影响当前可用性”，再单独排 daemon wrapper。

### 3. PM2 托管环境

如果 Clowder 已由 PM2 托管，优先使用 PM2 观察和恢复，避免再开一个 direct 进程抢端口或 Redis lease。

```bash
pm2 status
pm2 restart clowder-api clowder-web
pm2 logs clowder-api --lines 80 --nostream
pm2 logs clowder-web --lines 80 --nostream
```

判定：

- `online` + `/api/ready` ready：服务已恢复，用户侧硬刷新即可。
- `errored` 或反复重启：读取 error log 的第一条 fatal error，先修根因。
- 日志出现 `Redis namespace already has a live API instance`：说明已有 API 持有 lease，新的 API 被拒绝启动；不要继续叠加启动，先确认谁在监听 3004。
- 日志出现持续外部集成 DNS/网络失败但 API ready：通常不是 Clowder 崩溃根因，只影响对应集成。

### 4. 服务健康但页面显示崩溃

如果以下三项都成立，后端可判定健康：

```text
3003 HTTP 200
/api/ready ready
/api/cats 返回 Agent 数量 > 0
```

这时不要重启后端，先处理用户侧：

1. 浏览器页面：`Cmd+Shift+R` 硬刷新。
2. Electron 桌面壳：退出 App 后重开。
3. 仍白屏：打开 DevTools Console，抓第一条 client-side exception；这是前端组件/数据状态问题，不是 3004 API 崩溃。

### 5. 重启后验证

必须拿到这些证据才算修复完成：

```text
/api/ready: ready，redis/sqlite 都 ok
/api/cats: 至少返回当前 catalog 中的 Agent 数量
3003: HTTP 200
日志: CatRegistry initialized: ... 包含目标 Agent
```

当前 Clowder 常见健康样例：

```text
/api/cats → 18
包含：gpt52, kimi, pi, ppt-designer, requirements-analyst 等
```

## 场景 6：服务完全无响应（3003/3004 都 connection refused）

**症状**：`curl -m 3 http://localhost:3003/api/ready` 直接 curl: (7)，不是 timeout 而是立刻失败。

**诊断**：

```bash
# 1. 检查是否有僵尸 start-dev.sh 进程（只有 bash 壳，没有 Node 进程）
ps aux | grep "start-dev\|tsx.*api\|node.*3003\|node.*3004" | grep -v grep

# 2. 如果只看到 bash start-dev.sh，没有 node/tsx 进程，说明 Node 服务死了而父 shell 还活着
# 这些 bash 进程是无害的，不需要 kill，直接重启服务即可
```

**修复**：

```bash
cd ~/.slock/worktrees/clowder-ai-slock-like-webui
pnpm start:direct --quick
```

> 注意：`start:direct` 比 `start-dev.sh` 更可靠——`start-dev.sh` 是一个 bash 包装脚本，
> 如果 Node 服务崩溃，bash 父进程仍会残留（僵尸进程），看起来"在跑"实际服务已死。
> `start:direct` 直接启动 Node 进程，状态更透明。

等 30 秒后再验证：`curl -m 5 http://localhost:3004/api/ready`

---

## 场景 7：Claude agent 报 401（Failed to authenticate）

**症状**：@布偶猫4.5 等 Claude agent 回复 `Failed to authenticate. API Error: 401 Invalid authentication credentials` + `Error: Claude CLI: CLI 异常退出 (code: 1, signal: none)`。

**根因**：Claude CLI 的 OAuth token 在 subscription 模式下约每 90 天需要刷新。token 刷新窗口期内可能出现短暂 401。

**诊断**：

```bash
# 1. 确认 CLI 本身是否正常
claude auth status

# 2. 测试直接调用
echo "hi" | claude -p "say hi" --output-format json 2>&1 | head -3
```

**修复**：

如果 `claude auth status` 显示 loggedIn: false 或 CLI 直接调用也 401：

```bash
claude auth login  # 刷新 OAuth token
```

然后重启 Clowder 服务，让子进程继承新的 auth 状态：

```bash
pnpm start:direct --quick
```

如果 `claude auth status` 正常，CLI 直接调用也正常：说明 401 是瞬间的 token 刷新窗口造成的，**等待重试即可**，不需要操作。

**验证**：`@布偶猫4.5 hi` → 正常回复。

---

## 汇报模板

```markdown
根因：Web 3003 还在，但 API 3004 没起来，导致 `/api/cats` 请求失败，左侧 DIRECT MESSAGES 显示“暂无 Agent”。

修复：
- 释放旧进程/重启 Clowder
- 确认 native module 可加载
- API 重新初始化 CatRegistry

验证：
- `/api/ready` ready
- `/api/cats` 返回 N 个 Agent
- 3003 返回 200

用户侧动作：请 `Cmd+Shift+R` 硬刷新页面。
```
