---
doc_kind: summary
title: Clowder 阶段性改造总结
created: 2026-05-19
status: draft
---

# Clowder 阶段性改造总结

> 截止 2026-05-19，本轮改造的主线是：把 Clowder 从原来的 Cat Cafe 工具界面，逐步改造成更接近 Slock / Slack 的多 Agent 协作工作台。

## 1. 核心方向

本轮改造不是单点 UI 美化，而是围绕四个目标展开：

1. **Slock-like 协作体验**：频道、线程、DM、mention、任务协作更接近真实团队聊天工具。
2. **Agent 可见化**：Agent 的消息、状态、执行过程尽量出现在主 timeline，而不是隐藏在后台链路里。
3. **本地平台稳定性**：解决 dev server、Next 缓存、provider 配置、API 启动等反复中断的问题。
4. **视觉体系化**：从零散样式修补，升级为可切换、多主题、有设计规则约束的视觉系统。

## 2. 消息与频道体验

### 2.1 频道成员管理

已完成：

- 新增 `participatingCats` 字段，和原有 `preferredCats` 隔离。
- Edit Channel 支持成员添加 / 移除。
- Thread Header 展示当前频道成员头像。
- `@mention` 候选列表优先显示当前频道成员。
- 旧频道没有配置成员时，保留全量 Agent 兜底。

设计结论：

- 成员列表只决定「谁可以被 @」和「头像显示」。
- 消息触发采用 **mention-driven**：只有被 @ 的 Agent 响应，不做全员广播。

### 2.2 Per-agent 独立队列

已完成：

- 修复原来 thread-level 锁导致的阻塞问题。
- 现在 `@Kimi` 正在运行时，再发 `@Codex` 可以直接执行，不必排队。
- 同一个 Agent 自己忙时仍然排队，避免重复调用。
- 不带 @ 的广播消息仍采用保守的 thread 级锁。

效果：

```text
旧逻辑：一个 thread 里任意 Agent 忙 → 所有消息排队
新逻辑：只有目标 Agent 忙 → 该 Agent 的消息排队
```

### 2.3 DM 私聊线程

已完成：

- Thread 增加 `isDM` 标记。
- 新增 `POST /api/threads/dm`，按 `catId` 创建或复用 DM。
- Sidebar 增加 Direct Messages 区域。
- DM 线程隐藏 Edit Channel 按钮。
- DM 线程的 `participatingCats` 固定为目标 Agent。

边界：

- 当前是人和 Agent 的 DM。
- Agent-to-Agent DM 和权限隔离属于后续阶段。

### 2.4 Thread 右侧面板

已完成：

- 消息支持打开右侧 Thread 面板。
- Thread 面板不再撑开主会话布局。
- Thread 面板内部独立滚动，不带动主会话滚动。
- 底部输入框固定在面板底部，行为更接近 Slock。
- 切换频道时自动关闭当前 Thread。
- Thread 面板消息格式复用主会话消息组件，减少视觉割裂。

## 3. 输入框与消息能力

### 3.1 Slash 命令与 mention

已完成：

- 输入 `/` 展示 slash command picker。
- 输入 `@` 展示 mention picker。
- mention 候选支持按频道成员过滤。
- slash / mention picker 作为主输入框能力，而不是隐藏操作。

### 3.2 CVO「先采访」模式

已完成：

- ChatInput 增加一次性「先采访」开关。
- 开启后发送消息会自动注入 CVO 指令，要求 Agent 先问三个问题：
  - 最终产物是什么？
  - 约束和边界是什么？
  - 完成标准是什么？
- 发送后自动关闭，避免普通聊天被长期打断。

定位：

- 这是 Discovery Loop 的轻量入口。
- 先做手动触发，不强制所有需求都走采访流程。

### 3.3 通用文件上传

已完成：

- 原本输入框旁的附件按钮是 disabled 占位。
- 现在新增独立文件 input，支持选择任意文件。
- 图片仍走现有图片预览逻辑。
- 非图片文件展示为文件卡片：文件名、大小、下载入口。
- 单条消息支持多附件草稿。

## 4. Slock 聊天记录迁移

### 4.1 本地导出

已完成：

- 导出 Slock 主频道：24/24。
- 导出 thread 回复：363 个 thread。
- 本地备份目录：

```text
~/Downloads/slock-export-20260518/
```

### 4.2 Clowder 归档导入

已完成：

- 24 个 Slock 频道导入为 Clowder `[slock-archive]` 归档频道。
- 导入 2718 条归档消息。
- 归档频道已出现在 Clowder 左侧 CHANNEL 列表。
- 修复导入时用户索引不一致的问题：`yangcyyang` 与浏览器 `default-user` 可见性对齐。
- 修复归档频道可见但消息为空的问题：历史消息 `userId` 补齐为当前浏览器用户。

当前边界：

- 附件本体还没有完整迁移，只保留了 attachment id。
- Slock thread 回复已导出到本地，但尚未完整映射成 Clowder 子线程。

## 5. Agent 配置与 Skills

### 5.1 本地 Skills 合并

已完成：

- `/api/skills` 不只读取 Clowder 内置 skill。
- 追加扫描本地 `~/.claude/skills/`。
- 两个来源合并返回。
- 同名 skill 以 Clowder 内置版本优先。

目的：

- 让 Clowder 能看到本机已有的 gstack / Claude skill 资产。
- 避免技能列表只显示一小部分。

### 5.2 Agent 配置修复

已完成：

- 修复 OpenCode 模型配置错误导致的 API key invalid。
- 修复 Claude / OpenCode 本地调用路径问题。
- 对 shared-state 配置做了私有远端备份提交。

## 6. 安全与审计

### 6.1 危险动作 Audit MVP

已完成：

- 新增 `dangerous_action` 审计事件。
- 覆盖消息删除、频道删除、队列清空、workspace 文件删除。
- 审计日志写入本地 ndjson。
- 补充测试验证核心字段可读回。

当前边界：

- 这是 audit MVP，只负责追溯。
- 还没有做强制阻断 / UI 二次确认。

后续任务：

- Critical 动作强制 UI 二次确认。
- Workspace actor 绑定，避免审计 actor 落成 `unknown`。

## 7. 知识沉淀

### 7.1 沉淀为知识 MVP

已完成：

- 新增 `POST /api/knowledge`。
- 支持三类知识产物：
  - Feature → `docs/features/Fxxx-slug.md`
  - Lesson → 追加到 `docs/public-lessons.md`
  - Decision → `docs/decisions/0xx-slug.md`
- Chat Header 新增「沉淀为知识」按钮。
- 用户手动填写类型、标题、摘要后生成文档。

定位：

- 先做手动沉淀入口。
- 后续可以接 AI 自动总结。

### 7.2 Lessons 补录

已完成：

- 把近期真实踩坑补录到 `docs/public-lessons.md`：
  - Next/xterm SSR vendor chunk 问题。
  - OpenCode provider/model 配置漂移。
  - per-agent 队列阻塞。
  - Node / better-sqlite3 ABI 版本约束。

## 8. Task 与交付证据

### 8.1 交付证物面板

已完成：

- Task 数据增加 `evidence` 字段。
- Task 面板显示证物进度。
- 支持五类证据：
  - tests
  - build
  - screenshot
  - review
  - lesson
- 前后端均支持保存和展示。

目的：

- 防止 task 只靠口头说「完成」。
- 让交付结果有可回查证据。

### 8.2 Task board 清理

已完成：

- 批量关闭早期协调类 in_review。
- 识别重复任务，例如旧的 CHANNEL 平铺化重复项。
- 把当前待推进任务重新排序。

## 9. 工程稳定性

### 9.1 Next dev 缓存与 vendor chunk

已完成：

- `predev` 自动清理 Next 缓存。
- xterm 相关浏览器库加入 server external packages。
- dev 模式禁用 vendor chunk 拆分，减少 HMR 白屏。
- dev/build 输出目录隔离：
  - dev 使用 `.next-dev`
  - build 使用 `.next`

解决的问题：

- `Cannot find module './vendor-chunks/xxx.js'`
- 白屏、CSS 丢失、图标不加载。
- `next build` 覆盖运行中 3003 dev 产物。

### 9.2 统一启动入口

已完成：

- 根目录 `pnpm dev` 作为统一入口。
- Web 固定 3003。
- API 固定 3004。
- API 启动自动读取根目录 `.env`。
- 文档更新，避免裸跑子包 dev。

## 10. 视觉设计改造

### 10.1 视觉方法论引入

已完成：

- 读取并吸收三份方法论文档：
  - UI skills 对照 AI 视觉改造方法论。
  - 用 AI 推进前端视觉改造完整指南。
  - B 端监控类产品交互体验 Checklist。
- 锁定 Clowder taste vector：

```text
冷静、克制、专注、中等密度、信息优先、去装饰
```

### 10.2 Phase 1：排版与侧边栏层级

已完成：

- 建立专用视觉 token：
  - panel title
  - body
  - sender
  - meta
  - section label
- 消息正文统一为 14px / 1.55。
- sender 名称、时间戳、meta 层级统一。
- Sidebar 当前频道增加左侧强调线。
- Section label 降噪，使用更小、更淡的 uppercase。
- DM 头像默认降噪，只在 active / working 时突出。

### 10.3 Thread 面板视觉修正

已完成：

- Thread 面板底色改为和主会话一致。
- 只用分割线区分主会话和 Thread。
- 去掉「盒中盒」感。
- Thread 面板进出增加 180ms slide 动效。

### 10.4 消息 hover 态复刻 Slock

已完成：

- hover 时整条消息被 1px 黑色细线框包住。
- 头像、正文、右上角操作按钮都在同一个框内。
- 去掉多余背景变化和内外双层 ring。
- 操作按钮固定在 hover 框右上角内侧。

设计原则：

- hover 态表示「这一整条消息被选中」。
- 不让工具按钮漂浮在框外，避免破坏整体性。

### 10.5 Claude / Slack / Tesla 三主题

已完成：

- 左下角 ActivityBar 增加视觉主题切换按钮。
- 支持三套主题：
  - Claude：暖米色、珊瑚橙、克制阅读感。
  - Slack：深茄紫侧栏、白色主内容、Slack 蓝 accent。
  - Tesla：白底、Carbon 文本、Tesla 蓝、弱分割线、无阴影。
- 使用 `data-visual-theme="claude|slack|tesla"`。
- 使用 localStorage 记住选择。

### 10.6 夜间模式适配

已完成：

- 三套视觉主题都增加夜间模式组合 token。
- 使用组合选择器：

```css
[data-theme="dark"][data-visual-theme="slack"]
[data-theme="dark"][data-visual-theme="tesla"]
```

- 修复主题变量互相覆盖的问题。
- sender 名称统一为主文字色，不再跟头像/背景色联动。
- inline code / link pill 颜色跟随当前主题，不再固定旧桃色。

## 11. 消息编辑与分支

### 11.1 编辑消息不再自动产生分支

已完成：

- 原逻辑：编辑消息 = 创建新 thread branch。
- 新逻辑：编辑消息 = 原地修改消息，并显示「已编辑」。
- 显式「从这里分支」能力保留。

### 11.2 旧分支隐藏

已完成：

- 既有 title 含 `(分支)` 的 legacy branch thread 不物理删除。
- Sidebar 主列表默认过滤，避免侧边栏被分支刷屏。

## 12. 当前仍未完全收口的方向

下面这些不是本轮失败项，而是下一阶段可以继续推进的方向：

1. **附件迁移**：Slock 导出的 attachment id 还没有批量下载和导入 Clowder。
2. **Slock thread 映射**：thread 回复已导出，但还未完整恢复成 Clowder 子线程。
3. **安全 Phase 2**：危险动作还只是 audit，未强制二次确认。
4. **审计 UI**：后端已有审计日志，前端还没有查询界面。
5. **FILES Tab**：目前文件消息有了，独立 Files 汇总页仍可继续做。
6. **Emoji Reaction**：基础消息反应还未完成。
7. **Agent 常驻化**：Clowder 仍偏按需调用，和 Slock 常驻 Agent 体验还有差距。

## 13. 一句话总结

本轮改造已经把 Clowder 从「能调用多 Agent 的实验界面」推进到「接近 Slock/Slack 的本地多 Agent 协作工作台」：频道、DM、Thread、mention、文件、知识沉淀、安全审计、Slock 历史迁移、工程稳定性和三套视觉主题都已经落地，下一阶段重点应从「补功能」转向「收敛体验一致性 + 补齐权限/审计/文件中心」。
