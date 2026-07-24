---
feature_ids: []
topics: [frontend, design-review, ux, accessibility, design-system]
doc_kind: research
created: 2026-07-23
---

# Clowder 前端美感与用户体验评审

> 评审方式：三路证据交叉——① 设计系统代码调研（token/字体/暗色/组件/动效）② UX 代码调研（三态/排队/流式/无障碍/性能/文案）③ 真机走查（localhost:3003 实际渲染，桌面+移动视口、日夜切换实测）。全部结论附 `文件:行号` 或实测数据。
> 路径缩写：`web/` = packages/web/src。评审框架：frontend-design-review 三支柱（Frictionless / Quality Craft / Trustworthy）。

---

## 1. 总评

**判定：Needs Work——方向对、工程底子好，但三处功能性硬伤 + 一组家族性对比度失守把体验拖了下来。**

| 支柱 | 状态 | 一句话 |
|---|---|---|
| Frictionless（顺畅完成任务） | 🟠 | Cmd+K、发送失败原地重试很顺；但消息排队黑洞、频道列表被自动 thread 污染、任务卡编号失真在关键路径上制造迷失 |
| Quality Craft（工艺） | 🟠 | token 架构 + lint 治理是真的；但默认主题暗色无效、对比度多处不过 AA、Modal 无基件、微字号泛滥 |
| Trustworthy（可信） | 🟠 | 模型标注、危险操作层层设防做得好；但工具调用全程黑盒、排队静默、授权卡裸代码削弱信任 |

**先说保住的**：slock 主题的 2px 黑描边 + 方角 + 奶油黄/粉是**有主张的 neo-brutalist**，紫渐变/毛玻璃/card 海全部证伪——这不是 AI slop 脸，方向值得坚持。别在"要不要换风格"上浪费时间，问题全在执行层。

---

## 2. Blocking（功能性硬伤，建议本周处理）

### B1 消息排队完全不可见
- **现象**：目标猫忙碌时消息进队列，气泡上无任何标记，用户以为发出去了，实际在内存队列里排着（且后端该队列不持久化，重启即丢——见姊妹报告 Raft 分析 P0）。
- **证据**：后端返回 `deliveryStatus='queued'`，前端 **全 src 零消费**（grep 0 命中）；乐观气泡保留但无排队徽标（web/hooks/useSendMessage.ts:159-167）；QueuePanel 是唯一可见面但藏在面板里（web/components/ChatContainer.tsx:1567）。
- **建议**：气泡消费 deliveryStatus 加"排队中 · 第 N 位"徽标 + 点击展开 QueuePanel；与后端"用户队列持久化"（Raft 报告 Phase 0）同批上线，一次根治"静默丢消息"体感。

### B2 默认主题的夜间模式形同虚设
- **现象**：点月亮按钮 → `data-theme="dark"` 确实写入 → **界面纹丝不动**（真机实测：body 仍 `rgb(255,255,255)`）。同一状态下 claude/slockv1/kami 三套主题都正常变暗，唯独默认的 slock 不变。
- **证据**：实测四主题探针结果 slock=白/其余全暗；重灾区 TasksPanel 52 处硬编码亮色 hex 无暗色分支（web/components/TasksPanel.tsx:69-80）；globals.css:316-333 `.cli-output-md` 写死暗色值。
- **建议**：要么补全 slock 暗色变量映射并清 TasksPanel 硬编码，要么在 slock 主题下隐藏月亮按钮——**现状"按了没反应"是最差的一档**。

### B3 工具调用全程黑盒
- **现象**：猫在执行工具时，用户只看到一行"正在执行工具"标签；执行了什么命令、读了什么文件、返回了什么，全部不可见。
- **证据**：toolEvents 已入库（后端 StoredToolEvent 落在消息上），但前端无组件消费；`web/components/cli-output/CliOutputBlock.tsx` 与 toCliEvents.ts 是**死代码**（无任何 import）；AgentStatusIndicator.tsx:45 仅状态标签。
- **建议**：把 CliOutputBlock 接回渲染链路（数据链路是通的，纯前端工作量）；多 agent 平台的核心信任场景，优先级高于一切视觉打磨。RunLedger API 已就绪（GET /api/run-ledger/:invocationId），可顺手做执行时间线。

---

## 3. Major（工艺与一致性，建议两周内分批）

### M1 对比度家族性不合格（WCAG AA）
- 用户气泡：粉字 `#F46FA7` on 白底 **≈2.7:1**（正文需 4.5:1，实测）；
- muted 文字 `#9a918a` on 浅底 **≈2.9:1**（theme-tokens.css:16）;
- ≤11px 微字号类 **772 处**（text-[10px]×441、text-[11px]×300、更小 38 处），小字+低对比叠加。
- **建议**：用户气泡改"品牌粉底 + 近黑字"（保粉不牺牲可读）；muted 加深一档；微字数量收敛（见 M7）。

### M2 性能结构隐患：流式每 chunk 全列表重渲
- 无虚拟化（react-window/virtuoso 0 命中）；ChatMessage 未 memo（ChatMessage.tsx:399）；**6 处整 store 无 selector 订阅**（ChatContainer.tsx:217、ThreadSidebar.tsx:134、ActivityBar.tsx:227、SplitPaneView.tsx:36、MiniThreadSidebar.tsx:23、useChatHistory.ts:372）。流式回复每个 chunk 更新 store → 全列表重渲，thread 越长越翻越卡（大厅 2500+ 条实测存在）。
- **建议**：先细粒度 selector + ChatMessage memo（收益立竿见影、风险低），再评估虚拟化（滚动工程很扎实，虚拟化要小心别破坏它——见 §5 亮点）。

### M3 Modal 无基础组件
- 13 个 `*Modal*.tsx` + **30 个文件各自手写 `fixed inset-0` 遮罩**；z-index 各自为政（z-50×22、z-[80]×5、z-[100]×4、z-[66]×2，另有 z-[9999] 和 z-[2147483647] 逃逸值）；`role="dialog"` 仅 9-16 处；**focus trap 全站为零**（键盘/读屏用户可 Tab 逃逸到背景）；window.confirm 残留 2 处。
- **建议**：提取 ModalShell 基件（遮罩+dialog 语义+focus trap+Esc+z-token 一次解决），30 处逐步迁移；定义 z-index scale token。

### M4 任务看板信息失真
- **79 张卡只有 2 个编号**（#000178/#000177，真机实测）——编号完全失去标识作用；每卡标签组（测试/Build/截图/Review/Lesson）与"交付证据 0/5"全量相同，是模板噪音不是信息；F194 自动建卡标题直接用原始消息（"https://github.com/hon… 帮我安装这个"、"收到，先说我的理解：…"当标题）。
- **建议**：修编号渲染 bug（大概率取了全局计数器而非 task id）；标签/证据仅在非默认值时显示；自动建卡标题走摘要（后端 classifyWorkAdmission 已有消息上下文，截断前加一步标题生成）。

### M5 Agent 身份视觉系统缺失
- DM 区 24 只猫**全部绿点**（后端证实 CatSupervisor"在册即 online_idle"——presence 无信号量）；10+ 功能 agent 共用同一张灰猫像素头像，视觉不可区分；命名三套惯例并存（"宪宪·领航（Opus4.8）" / "Pi Agent" / "CYCC" / "需求梳理 Agent（asset-card）"）。
- **建议**：presence 改三态（执行中=绿脉冲 / 排队=黄 / 空闲=灰点）——前端可先用 invocationTracker 数据；功能猫按色相区分头像底色（低成本）；roster 分组（人格猫 / 功能流水线）+ 命名规范。

### M6 频道列表被自动 thread 污染
- CHANNELS 91 项，混入任务式长标题（"帮我写一份 F194 全频道路由验证的简短说明（sonnet…"）且带分支重复项；F194 自动建 thread 没有 UI 层治理。
- **建议**：F194/分支 thread 归入"任务讨论"分组或默认折叠，频道区只留人建频道——依赖 Thread.kind 字段（Raft 报告 Phase 1 正好做这个，前后端一批）。

### M7 排版体系失守（三项同源）
- 微字号任意值统治（语义字号 token 采用率 <2%）；圆角写死 518 处（rounded-lg×315/xl×133/2xl×70）——slock 主题声明方角（--slock-radius-*: 0，theme-tokens.css:400-403）但管不到这些组件，**方角主张被组件级写死架空**；阴影 102 处任意值 vs 35 处 token。
- **建议**：扩充 fontSize/radius/shadow token 各 3-4 档，扩展现有 no-hardcoded-colors lint 到这三类（治理机制是现成的，只是没覆盖到）。

### M8 中西文排版断裂 + 无 i18n
- 正文 Space Grotesk（评审标准明确列为避免使用的烂大街字体）仅覆盖拉丁，中文回落系统栈，中英混排风格割裂；display 字体（Fraunces）同样无中文方案；界面中英硬编码混杂（CHANNELS/Saved/「Confirm Delete」与中文同屏，EditChannelModal.tsx:242），无 i18n 框架。
- **建议**：短期统一 UI 语言（受众明确就全中文）；中期选一款中文可用的品牌字体（如霞鹜/思源黑改字重）与拉丁字体配对；Space Grotesk 是否更换属品牌决策，可后置。

### M9 aria-live 几乎缺席
- 全站 aria-live 仅 2 处（AgentStatusIndicator:134、GuideOverlay:280）——流式回复、新消息、排队变化对读屏用户完全静默。aria-label 289 处是好基础，但动态内容无通告。
- **建议**：消息列表容器加 aria-live="polite" 区域 + 新消息通告；配合 M3 的 dialog 语义一起补。

---

## 4. Minor（打磨项，顺手修）

1. 开屏即弹"会话恢复失败"toast（文案尚可行动，但首印象差）——静默重试成功就别打扰。
2. AuthorizationCard 猫名映射硬编码 5 只（AuthorizationCard.tsx:6-12），自定义猫显示裸 catId；action 只显示 code 无白话——授权卡是最需要用户看懂的地方。
3. 部分错误裸状态码（"删除失败 (404)"式，HubCatEditor.tsx:741）。
4. 移动端：黄色 rail 占 375px 宽的 ≈16%；"↓ 到最新"浮钮压在代码块/输入框上；代码块右缘裁切（真机实测）。
5. 图标体系：无图标库，251 处内联 svg（同 path 重复 2-4 次），emoji 当图标 60+ 处混用。
6. 用户消息不渲染 markdown（`**` 裸露、长 URL 不折叠不缩略）——至少做链接缩略。
7. 图片懒加载仅 1 处；skeleton 全站缺席（只有 spinner）。
8. 死代码清理:ThreadItem.tsx（仅测试引用，且其删除按钮无确认）、deliveryMode='queue' 死参数（无 UI 入口）。
9. transition-all 49 处、duration 未 token 化；无列表入场 stagger（粗野主义正适合做干脆的 stagger）。

---

## 5. 亮点（别在优化中弄丢的）

1. **token 架构是真的**：365 个 CSS 变量、data-visual-theme × data-theme 正交双轴、4 主题矩阵；自研 ESLint no-hardcoded-colors + color-audit-report.json 治理门——语义 token 类 3545 次 >> 裸 hex 334 次，纪律在执行。
2. **滚动工程极扎实**：每 thread 滚动位置记忆、上翻 prepend 保位、24px 底部锚定阈值、IntersectionObserver 兜底（useChatHistory.ts:26-45,1039-1065）——虚拟化改造时这是最容易被打碎的资产。
3. **发送失败不丢消息**：原地红框 + 一键重试 + 幂等 key 防重复气泡。
4. **离线韧性**：IndexedDB 快照 + 权威替换 + 三通道连接状态条（API/Socket/上游）。
5. **Liveness 白话分级**："启动中/仍在工作/疑似卡住"附人话解释（ThinkingIndicator.tsx:100-150），远超一般 spinner。
6. **危险操作层层设防**：两段式确认 + 软删除回收站 + 后端确认头。
7. **AI 透明度**：每条猫消息带头像+名字+MetadataBadge（model·provider）——评审标准里的 AI 披露要求天然满足。
8. **新用户闭环**：first-run quest → 训练营 → 空态 CTA，由后端状态驱动防误触发。
9. **无障碍动效**：prefers-reduced-motion 系统性处理；字体自托管有 PROVENANCE.md 许可溯源。

---

## 6. 优化路线图

### 第一批 · 天级 quick wins（全前端，无依赖）
| 项 | 对应 |
|---|---|
| 排队徽标（消费 deliveryStatus） | B1 |
| slock 暗色修复 或 隐藏月亮按钮 | B2 |
| 用户气泡粉底深字 + muted 加深 | M1 |
| 任务卡编号 bug + 默认标签隐藏 | M4 |
| 会话恢复 toast 降噪、授权卡猫名走 registry | Minor 1/2 |
| ChatMessage memo + 6 处 selector 化 | M2（第一步） |

### 第二批 · 周级结构工程
| 项 | 对应 | 依赖 |
|---|---|---|
| CliOutputBlock 复活 + 执行时间线 | B3 | 无（数据链路已通） |
| ModalShell 基件 + z-scale + focus trap，30 处迁移 | M3/M9 | 无 |
| presence 三态 + 功能猫头像色相区分 | M5 | 可先用前端已有数据 |
| 频道列表分组治理 | M6 | Thread.kind（Raft 报告 Phase 1，前后端一批） |
| aria-live 通告区 | M9 | 无 |

### 第三批 · 月级体系收敛
| 项 | 对应 |
|---|---|
| fontSize/radius/shadow/motion token 收敛 + lint 扩展 | M7 |
| 中文字体方案 + UI 语言统一（i18n 视受众决策） | M8 |
| 虚拟化评估（保滚动资产） | M2（第二步） |
| 图标体系统一、skeleton、懒加载 | Minor 5/7 |

**与后端报告的交叉依赖**：B1 与"用户队列持久化"（Raft Phase 0）同批上线效果最佳；M5 的 presence 真实化终局依赖 CatSupervisor 落地真实状态；M6 依赖 Thread.kind（Raft Phase 1）。其余全部纯前端可独立推进。

---

## 7. 证据局限

- 真机走查基于当前生产数据（91 频道/2500+ 消息的大厅），空库新用户首屏未走查（代码层 first-run 闭环已确认存在）。
- 自动化 wheel 滚动事件被页面吞（工具超时但 JS scrollTop 瞬时完成）——真实滚动手感未定罪，建议人工确认触控板滚动是否正常。
- 4 套视觉主题仅深查 slock（当前默认），其余三套只验证了暗色生效性。
- 对比度为按色值计算/实测，未跑完整 axe 扫描；建议 CI 加 axe-core 冒烟。
