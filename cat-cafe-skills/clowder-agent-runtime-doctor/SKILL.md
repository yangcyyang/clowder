---
name: clowder-agent-runtime-doctor
description: >
  Clowder Agent 运行态检查与修复流程。Use when: 左侧 DIRECT MESSAGES 显示“暂无 Agent”、
  @Agent 不触发、/api/cats 为空或失败、3004 API 不通、重启后 Agent/主题/功能没加载。
  Output: 根因结论 + 最小修复 + 验证证据 + 后续防复发建议。
triggers:
  - "暂无 Agent"
  - "检测不出 agent"
  - "链接不上 agent"
  - "/api/cats"
  - "3004"
  - "Agent 不见"
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
lsof -nP -iTCP:3003 -sTCP:LISTEN
lsof -nP -iTCP:3004 -sTCP:LISTEN
tail -n 120 cat-cafe-daemon.log
```

## 判定规则

- `3003 running` 但 `3004 not running`：Web 是空壳，Agent 一定加载不出来。
- `/api/ready` 失败：先修 API，不要改前端。
- `/api/cats` 返回 0 或请求失败：检查 `CatRegistry initialized` 日志和 `.cat-cafe/cat-catalog.json`。
- 日志出现 `better-sqlite3 NODE_MODULE_VERSION`：Node ABI 不兼容，需要用当前运行 Node 重新编译 native module。
- Web 仍显示旧状态但 `/api/cats` 正常：让用户 `Cmd+Shift+R` 硬刷新，或重启 3003。

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

### 3. 重启后验证

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

