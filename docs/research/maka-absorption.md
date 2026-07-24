---
feature_ids: []
topics: [maka, theme, design-system, architecture-absorption, recovery, observability]
doc_kind: research
created: 2026-07-24
---

# Maka 挖掘：主题规格 + 架构吸收清单

> 来源：对 /Users/cy/Downloads/maka-agent-main 4 的两线只读调研（设计系统线 + 架构线），全部结论附文件路径。Maka = local-first Agent 工作台（Electron 桌面 + TUI/CLI + Headless），北极星"「The Companion Command Center」——克制、可审查、非拟人化"。

## 1. 设计结论：一套语言 + 十套换色皮肤

**Maka 只有一套统一设计语言，不应硬拆多套。**其上叠加 `[data-maka-theme="onedark|catppuccin-mocha|tokyo-night|nord|coral|azure|forest|dusk|sand|mono"]` 十套 accent 调色盘（apps/desktop/src/renderer/maka-tokens.css:704-922），只重写 6 个基色，几何/阴影/字体全继承——**"1 基底 + N 换色"机制本身就是要抄的东西**，Clowder 可借此一次上多套风格。

两个比颜色更值钱的方法论（现有四主题都没有）：
1. **6 基色 + 全派生**（maka-tokens.css:8-17）：只定义 background/foreground/accent/info/success/destructive，border/muted/hover/ring 全部 color-mix 派生，不存在独立灰色字面量——换 accent 皮肤成本极低的根本原因。
2. **暗色阴影收缩为单描边环**（:635-641）：亮色=1px 描边环+两层 0.06 透明度柔光；暗色只留描边环。

### 主题规格卡：maka「冷静指挥室」

气质：克制/冷中性/工程感/非拟人。DESIGN.md:106-108 明确排斥紫蓝渐变、发光边框、玻璃拟态、吉祥物。

| 层级 | 亮 | 暗 |
|---|---|---|
| 背景板 canvas | #f7f7f7 | #09090b |
| 卡片 background | #ffffff | #171719 |
| 卡片 elevated | #ffffff | #1b1b1e |
| 文字主 | #0f0f12 | #e4e4e7 |
| 文字次/弱 | ≈#3a3a3d / ≈#87878a | ≈#c9c9cc / ≈#8e8e91 |
| 边框 | foreground@10-16% 透明度派生 | 白@8-10% |
| Accent（Maka蓝） | #57a3ef | #58b0ff |
| Info / Success / Warning / Destructive | #3ca2e0 / #098926 / #e26c00 / #e6000c | #52b5f4 / #279936 / 同相提亮 / #ff6367 |
| 用户气泡 | #e9e9e9（刻意中性灰不用 accent） | #2a2e33 |

圆角：control 6 / surface 8 / modal 12 / pill 999，同心嵌套（:379-396）。间距 4px 基准。字体：**去品牌化系统栈**（-apple-system 优先 + PingFang SC 回退链），等宽 Geist Mono 仅用于代码/路径/数字证据。动效：自定义 cubic-bezier，120/150/180/280ms 四档 + press-scale 0.96。

**查重预警**：几何上与现有 kami（4/6/8 分级小圆角）最接近，靠色彩基调（冷灰蓝 vs 暖纸藏青）+ 柔光描边环阴影（kami 无阴影）拉开。字体注意：Clowder 的 body 字体是全局的（Space Grotesk），无 per-theme 先例——maka 主题要覆盖 body 字体需新开 font-family token 并接入主题块。

### 落地建议（任务 #5）
maka 基底（亮+暗）+ 先挑 2-3 套 accent 皮肤（候选：onedark / nord / catppuccin-mocha）。等批次 1-B 落地 theme-tokens.css 后实施，避免同文件冲突。

## 2. 组件/交互线索（喂给批次 2/3 实现时参考）

| 组件 | 路径 | 与 Clowder 的关系 |
|---|---|---|
| 工具时间线折叠（thinking+tools 折成 Processing 块） | packages/ui/src/timeline-fold.ts | 批次 2 工具调用渲染复活的直接参考 |
| 工具活动行（图标化+可展开） | packages/ui/src/tool-activity.tsx、tool-format.ts | 同上 |
| 平滑流式渲染（EMA 速率+RAF+grapheme 感知） | packages/ui/src/smooth-stream.ts | 治"一坨一坨跳字" |
| 思考流二次脱敏+双重截断 | packages/ui/src/thinking-stream.ts | thinking 展示安全 |
| 权限审批弹窗（按 reason 分级视觉） | packages/ui/src/permission-dialog.tsx | AuthorizationCard 升级参考 |
| 任务六态面板 | packages/ui/src/task-ledger-panel.tsx | TaskBoard 参考 |
| Artifact 右侧面板（IPC 路径边界+iframe sandbox） | apps/desktop/src/renderer/artifact-pane.tsx | 产物一等对象（目标架构 Artifact） |
| 会话分支横幅/中断恢复按钮/内容搜索 IPC | apps/desktop/src/renderer/{branch-banner,interrupted-resume,use-thread-search}.ts | 分支 UX / 恢复 UX |

## 3. 架构吸收清单（按价值排序）

| 序 | Maka 机制 | 原理 | 对应 Clowder 缺口 | 吸收方式 | 成本 |
|---|---|---|---|---|---|
| 1 | RecoveryResolver 决策表（packages/runtime/src/recovery-resolver.ts） | dispatch 事件区分"未派发/不确定/已完成"，fail-closed 不瞎重放 | 重启后 running→failed 一刀切 | 借鉴：InvocationRecord 加 dispatch 边界事件，重启查表 | 1-2周 |
| 2 | Terminal Invariant（runtime-runner.ts） | 终态必须由唯一终止事实支撑，防悬空 running | 假在线/悬空状态 | 照抄：完成前先落不可变终止事实 | 3-5天 |
| 3 | 工具时间线物化（RuntimeEvent→TimelineItem） | 事件流投影成前端时间线 | 执行可观测（组件死代码） | 照抄思路：RunLedger 已有，补投影器+前端 | 1周 |
| 4 | Provider 错误分类（provider-error-classification.ts） | 结构化码优先分级，仅特定类触发确定性恢复 | 无重试策略 | 借鉴：先分类表后按类决定重试/退避 | 3-5天 |
| 5 | 三层预算 enforceCaps（headless/task-run-store.ts） | 硬 cap，自定义策略不可绕过 | budget_exhausted 枚举没接线 | 照抄：接到强制检查点 | 2-3天 |
| 6 | Tool Result 四层分离+Active Prune（active-tool-result-prune.ts） | 先归档拿 ref 再裁剪，失败保原文 | Tool Result 不裁剪 | 借鉴 archive-then-placeholder 协议 | 1-2周 |
| 7 | Permission Profile（core/src/permission-profile.ts） | path/special+read/write/deny 建模，.git 强制只读 | bypassPermissions 裸跑 | 借鉴：子进程文件系统策略层 | 1-2周 |
| 8 | Stream Watchdog 分阶段+pause（stream-watchdog.ts） | 等审批时暂停超时检测，不误判卡死 | 审批等待与 liveness 混淆 | 照抄 pause 模式 | 2天 |
| 9 | 分支 UX（branch-from-turn + parentSessionId 横幅） | 从某 turn 派生新 session | 通用价值 | 借鉴："从某条消息分叉给另一只猫" | 3-5天 |

### 明确不吸收
- **V2 History Compaction 全套**（rolling checkpoint+digest+lineage）：为单人千轮会话设计，Clowder 12k 窗口量级用不上；只记一条原则"checkpoint 复用前必须重新过当前 policy 校验"。
- **Durable Task Loop 的 workspace lease/throwaway copy**：基于 local-first 单进程假设，与多 agent 服务端持久 workspace 冲突。
- **T1/T2 SQLite 事务化 tool journal**：Maka 文档自标未落地，且绑定 SQLite canonical store 选型。
- **AHE 自迭代层**：Maka 特有产品形态，无对应缺口。

## 4. 并入批次计划

| 吸收项 | 并入 |
|---|---|
| #3 工具时间线 + 组件线索（timeline-fold/tool-activity/smooth-stream） | 批次 2 的"工具调用渲染复活"，从"接回死代码"升级为"按 Maka 模式重做投影" |
| #5 enforceCaps | 批次 3 预算项的具体实现模式（成本降到 2-3 天，优先级可回升） |
| #2 Terminal Invariant → #4 错误分类 → #1 RecoveryResolver | 批次 3 的"task↔run 联动 + 自动重试"扩展为三步递进（先不变量、再分类、后决策表） |
| #8 Watchdog pause | 批次 3 权限治理附带（2 天） |
| #6 Tool Result 裁剪、#7 Permission Profile、#9 分支 UX | 批次 4 候选（新开） |
| 主题落地 | 任务 #5（等 1-B），maka 基底 + 2-3 accent 皮肤 |
