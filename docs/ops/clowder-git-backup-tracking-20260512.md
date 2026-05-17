# clowder-ai slock-like 改造：Git 备份追踪记录

更新时间：2026-05-12 00:55
负责人：@老者-codex
项目路径：`/Users/cy/Documents/03 life/AI design/OrbitOS-CN/20_项目/clowder-ai`

---

## 1. 当前结论

本地 Git 备份已完成，可以继续开发。

GitHub 私有仓库完整历史推送暂未成功，原因是远端 unpack 失败。当前决策是：

- 保留本地完整历史。
- 保留本地 Phase 1 备份 commit。
- 暂不继续硬推完整历史到 GitHub。
- 后续如需云端备份，优先采用“当前工作树快照上传”。

---

## 2. 本地备份状态

### 当前分支

```bash
feature/slock-like-webui
```

### 本地备份提交

```bash
1d880be wip: slock-like shell phase 1
```

### 基准上游提交

```bash
05fd61d feat(F190): console restructure follow-up — complete feature migration (#669)
```

### 当前工作树状态

```bash
clean
```

说明：Phase 1 的代码与设计文档已写入本地 Git commit。后续如果改坏，可以回到 `1d880be`。

---

## 3. Phase 1 提交内容

本地 commit `1d880be` 包含 6 个文件：

```text
packages/web/src/components/AppShell.tsx
packages/web/src/components/ActivityBar.tsx
packages/web/src/app/theme-tokens.css
docs/design/slock-like-webui-spec.md
docs/design/slock-like-webui-mock.html
docs/design/slock-like-visual-checklist.md
```

### 改动摘要

- `AppShell.tsx`：新增 slock-like 三栏壳层，右侧 Context Panel 占位可折叠。
- `ActivityBar.tsx`：导航收敛为对话 / 任务 / 记忆 / 设置，隐藏 signals 入口。
- `theme-tokens.css`：新增 slock-like 语义 token。
- `docs/design/*`：补充设计规范、HTML mock、视觉验收清单。

---

## 4. 运行状态记录

已验证本地服务可运行：

```text
Frontend: http://127.0.0.1:3003
API:      http://127.0.0.1:3004/ready
Redis:    127.0.0.1:6399
```

API ready 检查返回：

```json
{"status":"ready","checks":{"redis":{"ok":true},"sqlite":{"ok":true}}}
```

浏览器访问前端返回 200。

注意：未配置账号/OAuth/API Key 时，控制台出现 `callback-auth` 401 和 `audit/thread/default` 403 属于预期，不影响 UI 壳层验收。

---

## 5. GitHub 私有仓库状态

### 目标私有仓库

```text
https://github.com/yangcyyang/clowder-ai-cy.git
```

### 已添加 remote

```bash
cy-private https://github.com/yangcyyang/clowder-ai-cy.git
```

### 仓库权限

`gh auth status` 显示当前账号是 `yangcyyang`，具备 `repo` 权限。

`gh repo view yangcyyang/clowder-ai-cy` 显示该仓库存在且为 Private。

### 推送失败现象

完整历史推送失败：

```text
error: RPC failed; HTTP 400 curl 22 The requested URL returned error: 400
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
Everything up-to-date
```

加大 `http.postBuffer` 并降为 HTTP/1.1 后，远端仍失败：

```text
remote: fatal: did not receive expected object ...
remote unpack failed: index-pack failed
```

### 判断

这不是权限问题，也不是本地仓库明显损坏。

本地 `git fsck --full --no-reflogs` 已通过。

更可能是空仓库首次接收完整历史包时，HTTPS 传输包或远端 unpack 过程失败。

---

## 6. 当前策略

### 已决定

继续保留本地完整历史与本地备份 commit。

### 暂不做

暂不继续硬推完整历史到 GitHub。

原因：这条路径已经偏离当前产品改造主线，继续排 Git 传输问题性价比低。

### 推荐后续云端备份方式

如果需要把代码放到私有 GitHub，推荐采用“当前工作树快照上传”：

```bash
cd "/Users/cy/Documents/03 life/AI design/OrbitOS-CN/20_项目"
rsync -a --exclude .git clowder-ai/ clowder-ai-cy-snapshot/
cd clowder-ai-cy-snapshot
git init
git remote add origin https://github.com/yangcyyang/clowder-ai-cy.git
git add .
git commit -m "snapshot: slock-like shell phase 1"
git push -u origin main
```

执行前必须先完成敏感内容检查，避免上传 `.env`、token、数据库、日志或本地配置。

---

## 7. 协作分工

### @老者-codex

- 总控 git 与改造节奏。
- 负责最终备份策略和上传操作。
- 防止多人同时 `git add/commit/push`。

### @思考者

- 只做方案判断，不碰仓库。
- 已给结论：备份主方案采用当前工作树快照上传。
- Phase 2 优先级建议：Channel/DM/Project 分组 → thread reply → task 状态。

### @执行者-codex

- 做只读检查，不做写操作。
- 检查范围：仓库大小、大文件来源、`.gitignore`、敏感内容风险。

### @研究生-kimi

- 做轻量辅助。
- 不再碰 git push / commit。
- 可负责 UI 清单、文案、组件改造前信息整理。

---

## 8. 下一步

1. 等 @执行者-codex 输出只读检查结果。
2. 如果无敏感风险，执行“当前工作树快照上传”。
3. 如果有敏感风险，先更新 `.gitignore` / 清理快照目录，再上传。
4. Phase 2 开始前，再建一个新 commit 或新分支节点，避免把备份与功能开发混在一起。

---

## 9. 回退方式

回到 Phase 1 备份点：

```bash
cd "/Users/cy/Documents/03 life/AI design/OrbitOS-CN/20_项目/clowder-ai"
git checkout feature/slock-like-webui
git reset --hard 1d880be
```

注意：`git reset --hard` 是破坏性操作，只能在明确确认要回退时执行。
