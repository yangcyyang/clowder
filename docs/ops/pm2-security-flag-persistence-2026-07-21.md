# pm2 安全关键 flag 持久化 — 授权配置 + 迁移/重启验证计划

- Author: @sonnet
- Gate: @专家-Claude
- Apply（真重启迁移）: 等 yangcyyang 在场 + 回滚就绪，不在本次范围
- 背景：F194 排查时发现 `clowder-api` 的自定义 env（含安全关键 flag）只活在
  pm2 daemon 内存里，daemon/机器重启会静默重置为代码默认值。

## 已完成（本次范围）：授权配置，仅文件编辑，零 live 影响

`ecosystem.config.cjs`（`clowder-api` 专属 env，不混进 `clowder-web`）新增
10 个纯行为开关，commit `cf209b99`（worktree `clowder-sonnet-pm2-persistence`
/ branch `sonnet/pm2-security-flags-persistence`）：

| Flag | 持久化值 | 语义 |
|---|---|---|
| `CLOWDER_CAPABILITY_RECEIPT_MODE` | `enforce` | #401 焊死的能力回执强制模式，绝不能回退成宽松默认 |
| `CLOWDER_CAPABILITY_RECEIPT_EXECUTOR_ALLOWLIST` | `antigravity.native.run_command` | 能力回执 executor 白名单 |
| `CLOWDER_CAPABILITY_RECEIPT_CAT_ALLOWLIST` | `antigravity` | 能力回执猫白名单 |
| `CLOWDER_CAPABILITY_RECEIPT_THREAD_ALLOWLIST` | `thread_mrqr35sjajks9qlg` | 能力回执线程白名单 |
| `ANTIGRAVITY_AUTO_APPROVE` | `false` | 绝不能变 `true`——那等于跳过能力回执确认 |
| `CAT_CAFE_MEMORY_PROMOTION_MODE` | `shadow` | 票C 记忆晋级评审门模式 |
| `CLOWDER_AUTO_TASK_THREAD_ROUTING` | `true` | F194 自动建任务+线程，已全频道放量 |
| `CLOWDER_AUTO_TASK_THREAD_THREADS` | `thread_mrqr35sjajks9qlg,thread_mrrmu5i66vxj55ia` | F194 canary 线程白名单（历史遗留，现已全局开，留着不影响） |
| `CLOWDER_THREAD_ADDRESS_ROUTING` | `false` | 线程地址路由开关 |
| `CLOWDER_THREAD_ADDRESS_THREADS` | `thread_mrqr35sjajks9qlg` | 线程地址路由白名单 |

**明确排除、本次不碰**：
1. 7 个真凭证/API key（`BOCHA_API_KEY`/`CAT_CAFE_CALLBACK_TOKEN`/`MIMO_API_KEY`/
   `OPENROUTER_API_KEY`/`WEIXIN_BOT_TOKEN`/`XIAOMI_API_KEY`/
   `XIAOMI_TOKEN_PLAN_CN_API_KEY`）——`ecosystem.config.cjs` 是 git 追踪文件，
   写进去等于把密钥提交进 git 历史。这批的持久化策略（keychain？票B B1 同款
   纪律？）是独立、更高优先级的 follow-up，需要 yangcyyang/专家-Claude 定，
   不在本文档范围。
2. pm2 从某 agent/Claude-Code 会话 shell 启动时误带进来的会话/机器噪音
   （`PATH`/`SLOCK_AGENT_ID`/`CLAUDE_CODE_SESSION_ID`/`CONDA_*`/`HOMEBREW_*`
   等）——不是应用配置，不该持久化。
3. **其他非安全类自定义 env**（如 `CAT_CAFE_SUMMARY_*`、`CAT_CAFE_HISTORY_*`、
   `CAT_CAFE_DELIVERY_ONLY_THREADS`、`CAT_CAFE_PERSONAL_SKILL_*` 等）——这些
   同样只活在 daemon 内存里，同样会被重启静默重置，但不属于"安全关键"范围
   （功能/体验漂移，不是安全门失效）。**这是一个相邻但独立的风险**，本次
   任务范围明确限定为专家-Claude 点名的安全关键 flag，这批不在本次授权配置
   里，需要另开一票评估是否也要持久化。

## 待执行（不在本次范围）：真重启迁移

**为什么需要人在场**：`pm2 restart --update-env` 会用 `ecosystem.config.cjs`
里的 env **完全替换**当前进程的自定义 env——如果本文档遗漏了某个仍在被依赖
的安全 flag（哪怕只是上面第 3 类里的某一个，只要代码里其实检查了它），重启
瞬间就是真实的安全门失效或功能中断，不是"配置漂移"那个级别。必须有人能在
重启后立刻验证、必要时立刻回滚。

### 执行清单（yangcyyang 在场时）

1. **重启前基线快照**：`pm2 env 1 > /tmp/pre-restart-env-$(date +%s).txt`
   （完整 173 行自定义 env，不只是本文档这 10 个），留作回滚参照。
2. **确认 canonical HEAD** 已包含本次 commit（`cf209b99` 或其后续 merge
   commit），`ecosystem.config.cjs` 内容跟本文档表格一致。
3. **执行**：`pm2 restart clowder-api --update-env`。
4. **立即验证**（重启后 <1 分钟内）：
   - `pm2 env 1` 重新抓取，跟步骤1的基线逐行 diff。
   - 断言本文档表格 10 个 flag 全部存在且值正确（尤其
     `CLOWDER_CAPABILITY_RECEIPT_MODE=enforce`、`ANTIGRAVITY_AUTO_APPROVE=false`
     这两个直接关系安全门）。
   - `curl /api/ready` 绿。
   - 跑一次 `runtime-doctor` 冒烟脚本（`#381` 产出）确认基础链路没退化。
5. **若发现遗漏**：立刻用 F194 flip 时验证过的单 flag 追加流程（抓当前 env
   → 过滤 pm2 内部 key → 补齐遗漏值 → 重新 `--update-env`）补回，不要等下一次
   计划性重启。
6. **回滚预案**：若重启后行为明显异常（比如能力回执被绕过的迹象），
   立刻 `pm2 restart clowder-api`（不带 --update-env，回到刚才的进程状态是
   不可能的——env 已经变了；真正回滚手段是从步骤1的快照文件手动重新
   export 后再 `--update-env` 一次）。这也是为什么必须有人在场：自动化脚本
   发现异常后的正确响应需要判断"是配置错了还是代码本身有问题"，不适合无人
   值守执行。

### 验收标准
- [ ] 10 个安全 flag 重启后在 `pm2 env 1` 里全部存在，值跟本文档表格一致
- [ ] `/api/ready` 绿
- [ ] runtime-doctor 冒烟脚本通过
- [ ] 重启前后 `pm2 env 1` 完整 diff 已人工过一遍，没有意外丢失的其他自定义 var
- [ ] yangcyyang 确认可以收尾
