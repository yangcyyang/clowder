# Clowder Local Slock Mode WebUI 改造规范

> 目标：让 clowder-ai 的本地版看起来、用起来更像 Slock 的协作消息平台，同时保留 clowder 的本地多 Agent 执行底座。

## 1. 改造边界

### 1.1 本阶段要做

- Phase 1：视觉与壳层改造
- Phase 2：slock 交互语义改造
- 只改 WebUI 信息架构、视觉系统、消息流、输入框、右侧上下文面板
- 底层继续使用现有 `thread / cat / invocation / Redis / Evidence Store`

### 1.2 本阶段不做

- 不重写 A2A 路由
- 不重写 invocation queue
- 不改 Redis 存储结构
- 不改 Evidence Store
- 不改 CLI adapter
- 不引入真正的 slock channel / member / permission 后端模型

## 2. 产品心智

当前 clowder 的心智是：

```text
猫猫团队工作台
Thread → Cat → Invocation → Tool Status
```

改造后的心智应变成：

```text
本地 AI 团队协作台
Project / Channel → Message → Thread Reply → Task / Agent Status
```

关键原则：

- 用户不要先理解“猫猫品种”，而是先理解“我在一个协作空间里指挥多个 Agent”
- 猫猫体系可以保留为底层和头像人格，但主界面文案要弱化“游戏感”
- 复杂运行状态收进右侧 Context Panel，不挤占主消息流

## 3. 信息架构

### 3.1 主布局

```text
┌────────────────────────────────────────────────────────┐
│ Activity Rail                                           │
├──────────────┬────────────────────────────┬────────────┤
│ Space List   │ Message Timeline           │ Context    │
│              │                            │ Panel      │
│ Project      │ Thread Header              │ Tasks      │
│ Channel      │ Messages                   │ Agents     │
│ DM / Agents  │ Composer                   │ Evidence   │
│ Recent       │                            │ Files      │
└──────────────┴────────────────────────────┴────────────┘
```

### 3.2 左侧 Space List

左侧从 `ThreadSidebar` 演进为“空间列表”。

首版不新增后端 channel，只做前端分组模拟：

- `项目空间`：按 `projectPath` 分组
- `最近对话`：现有 threads
- `Agent DM`：按 cat/agent 展示快捷入口
- `Pinned`：保留现有 pinned / favorite 语义
- `Trash`：保留现有回收站能力，但降低视觉权重

### 3.3 中间 Message Timeline

中间是核心区域，必须优先保证消息阅读。

消息类型：

- 用户消息
- Agent 消息
- 系统消息
- 工具/CLI 输出
- Task 状态消息
- Evidence / 引用消息

### 3.4 右侧 Context Panel

右侧只放“上下文”，不放主操作。

首版 Tab：

- `Tasks`：当前 thread 任务板
- `Agents`：Agent 执行状态、queue、invocation
- `Evidence`：证据、记忆、引用材料
- `Files`：工作区文件、预览、terminal 入口

## 4. 视觉规范

### 4.1 设计方向

方向：克制的协作控制台。

关键词：

- 协作
- 稳定
- 清晰
- 本地工作台
- 低游戏感
- 低噪声

避免：

- 过多猫猫装饰
- 过多渐变和卡片阴影
- 每个区域都像独立产品
- 工具状态默认全部展开

### 4.2 色彩

继续复用现有 console token，但收敛到更接近 slock 的低对比 UI：

- 外层：`--console-shell-bg`
- 左栏：`--console-rail-bg`
- 面板：`--console-panel-bg`
- 卡片：`--console-card-bg`
- 分隔：`--console-border-soft`
- 强调：`--cafe-accent`

建议新增语义 token：

```css
--slock-channel-active: var(--console-active-bg);
--slock-message-hover: var(--console-hover-bg);
--slock-thread-accent: var(--cafe-accent);
--slock-task-todo: #94a3b8;
--slock-task-active: #d97757;
--slock-task-review: #2563eb;
--slock-task-done: #16a34a;
```

### 4.3 圆角与密度

- 主面板：12px
- 消息卡片：10px
- 输入框：12px
- 标签：999px 或 6px
- 左侧列表行高度：40-52px
- 消息垂直间距：10-14px
- 主消息最大宽度：不要超过 860px，避免长文本太宽

### 4.4 字体

生产代码可继续使用现有字体体系，不在 Phase 1 引入新字体。

重点是密度：

- 正文：14px / 1.6
- 元信息：12px
- 标签：11px
- 标题：15-16px semibold

## 5. 组件规范

### 5.1 Activity Rail

保留窄 rail，但导航语义改为：

- Messages
- Tasks
- Memory
- Settings

隐藏或降级：

- Pixel Brawl
- Signals
- 社区运营
- 排行榜
- 游戏入口

### 5.2 Space List

列表行结构：

```text
[图标] 标题                 [未读/状态]
       摘要 / 最近 Agent
```

状态：

- 当前选中：淡色背景 + 左侧 2px accent bar
- 有未读：标题加粗 + unread dot
- 有 active invocation：小型 pulse dot
- pinned：右侧 pin icon

### 5.3 Message

消息结构：

```text
Avatar  Sender · Time · Status
        Content
        Actions: Reply / Copy / Task / Evidence
```

用户消息不再必须右对齐。为了接近 slock，建议改为统一左对齐消息流。

如果保留右对齐，也只在移动端或短消息场景使用。桌面协作平台首选左对齐。

### 5.4 Task 状态

Task 不应独立成一个全新页面，应该嵌入消息和右侧面板。

消息内状态：

- `todo`
- `in_progress`
- `in_review`
- `done`

展示方式：

```text
[task #12 · in_progress] 重做左侧侧边栏
```

### 5.5 Agent 状态

Agent 状态更像“成员状态”，不要像游戏角色状态。

状态：

- idle
- queued
- running
- waiting_auth
- failed
- done

展示位置：

- message header
- right panel Agents tab
- input area 上方轻提示

### 5.6 Chat Input

保留现有能力：

- `@mention`
- 图片上传
- whisper
- queue / force
- path completion

文案调整：

- `Send`：发送
- `Queue`：排队发送
- `Force`：立即打断并发送
- `Whisper`：私发给 Agent

## 6. 文件改造映射

### Phase 1 文件

- `packages/web/src/components/AppShell.tsx`
- `packages/web/src/components/ActivityBar.tsx`
- `packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx`
- `packages/web/src/app/theme-tokens.css`
- `packages/web/src/app/console-shell.css`

### Phase 2 文件

- `packages/web/src/components/ChatMessage.tsx`
- `packages/web/src/components/ChatInput.tsx`
- `packages/web/src/components/ChatContainerHeader.tsx`
- `packages/web/src/components/MessageActions.tsx`
- `packages/web/src/components/ReplyPill.tsx`
- `packages/web/src/components/RightStatusPanel.tsx`

## 7. 验收标准

### Phase 1

- 首屏视觉像协作消息平台，而不是猫猫游戏工作台
- 左侧能清楚看到“空间/项目/对话”结构
- 隐藏社区、游戏、IM 等本地版不需要的入口
- 发送消息、切换 thread、查看历史不受影响
- 深色和浅色主题都可用

### Phase 2

- 用户能清楚看到谁在说话、谁在处理、任务是什么状态
- thread reply 入口明确
- task 状态能直接从消息流识别
- 右侧能查看任务、Agent 状态、Evidence
- Agent 执行状态不再淹没在主消息流里

## 8. 第一版 Mock 场景

Mock 只覆盖一个核心路径：

```text
用户选择“Clowder 本地改造”项目
  ↓
中间看到用户、Codex、Kimi、Claude 的多 Agent 对话
  ↓
右侧看到 Phase 1 / Phase 2 任务状态
  ↓
底部输入框支持 @Agent 与排队发送
```

该 Mock 只用于确认方向，不代表最终生产代码。

