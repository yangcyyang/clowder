# Slock Sidebar 改造参数表

来源：
- 任务：task #49
- 页面：Slock 当前会话页左侧栏截图
- 附件：`slock-sidebar-redbox.png`
- 说明：`app.slock.ai` 浏览器访问当前需要登录，无法直接读取真实 computed CSS。本规格基于截图做视觉反推，并按截图 2x 像素折算为 CSS px。用于 task #50 的前端实现输入，不作为 Slock 源码复用。

## 1. 总体结构

```text
[Activity Rail 52px] | [Sidebar 244px] | [Main Chat]
```

- Activity rail 宽度：约 `52px`
- Sidebar 宽度：约 `244px`
- Sidebar 背景：暖浅米色，约 `#f6efe7`
- Sidebar 右边界：`1px solid #ded3c8`
- Sidebar 内边距：左右约 `12px`
- Sidebar 内容从上到下：
  1. Header：标题 + 小图标 + `+ 新对话`
  2. Search
  3. Quick nav：Inbox / Saved / 私信
  4. CHANNEL 区：header + 频道列表
  5. DIRECT MESSAGES 区：Agent 私信列表
  6. Bottom：回收站 / 设置类入口

## 2. Header

- 高度：约 `56px`
- 标题字号：`20px`
- 标题字重：`700`
- 标题颜色：约 `#241f1b`
- Header 水平布局：
  - 左：标题 `对话`
  - 中右：训练营/状态小图标，建议 Clowder 暂时移除
  - 右：`+ 新对话` 主按钮
- `+ 新对话`：
  - 高度：约 `34px`
  - 宽度：约 `76px`
  - 圆角：约 `14px`
  - 背景：橙棕色，约 `#cc6743`
  - 文本：白色，`14px`，字重 `700`

task #50 建议：
- 保留标题和 `+ 新对话`
- 移除 Bootcamp/训练营按钮
- Header 不需要复杂状态图标

## 3. 搜索框

- 位置：Header 下方约 `8px`
- 高度：约 `34px`
- 宽度：填满 sidebar 内容区
- 圆角：约 `10px`
- 背景：约 `#f0e6dc`
- 边框：无明显边框
- placeholder 字号：`14px`
- placeholder 颜色：约 `#9b938c`
- 内边距：左 `12px`

建议 Clowder placeholder：
- `搜索对话、频道或成员...`

## 4. Quick Nav

包含：
- Inbox
- Saved
- 私信 / Direct Messages 入口

参数：
- 每行高度：约 `34px`
- 行间距：约 `0-2px`
- 左 padding：约 `12px`
- 图标尺寸：`16px`
- 图标和文字间距：约 `12px`
- 默认文字颜色：约 `#6f6861`
- 默认字号：`15px`
- hover 背景：约 `rgba(0,0,0,0.04)`
- active 背景：约 `#ead8cc`
- active 圆角：约 `12px`

task #50 建议：
- Quick nav 保持在搜索框下方
- 顺序固定为：`Inbox` → `Saved`
- `私信` 不再做单一按钮，改到下方 `DIRECT MESSAGES` 区域展开具体 Agent 列表

## 5. CHANNEL 区

Section header：
- 顶部间距：约 `18px`
- 高度：约 `20px`
- 文案：`CHANNEL`
- 字号：约 `12px`
- 字重：`700`
- 字距：`0.16em`
- 颜色：约 `#a29a93`
- 全大写
- 右侧可放 `+` 添加频道按钮

频道 item：
- 高度：活跃频道约 `58px`，普通频道可收敛到 `32-36px`
- 圆角：约 `12px`
- active 背景：约 `#ead8cc`
- active 文本颜色：约 `#241f1b`
- active 标题字号：约 `17px`
- active 字重：`700`
- 次要时间/状态文本：右下角，`12px`，约 `#9b938c`
- 默认频道文本字号：`14-15px`
- 默认频道文本颜色：约 `#6f6861`
- hover 背景：约 `rgba(0,0,0,0.04)`

task #50 建议：
- 去掉 `PROJECT` 标题，把现有 project/thread 分组视觉上并入 `CHANNEL` 列表。
- 删除 `全部展开 / 全部折叠` 控制条。
- `CHANNEL` header 右侧加 `+` 按钮，第一版可做占位，不接后端。

## 6. DIRECT MESSAGES 区

Section header：
- 文案：`DIRECT MESSAGES`
- 样式同 `CHANNEL` header
- 放在 `CHANNEL` 列表下方

DM item：
- 高度：约 `34-38px`
- 左 padding：约 `12px`
- Avatar：`22-24px`
- Avatar 圆角：`6px`，保持方形圆角
- 名称字号：`14-15px`
- 名称颜色：约 `#6f6861`
- 在线/状态点：可选，`6-8px`
- hover 背景：约 `rgba(0,0,0,0.04)`
- active 背景：约 `#ead8cc`

task #50 建议：
- 从现有 cat catalog/runtime cats 读取 Agent 列表。
- 第一版点击行为可先复用当前“私信过滤/入口”能力；若没有真实 DM thread API，先打开或创建普通 thread，但视觉上按 DM 列表呈现。

## 7. 底部区域

- 固定在 sidebar 底部
- 高度：约 `36px`
- 左右内边距：约 `12px`
- 背景：可和 sidebar 相同，或 hover 时浅底
- 上边距：自动撑开
- `回收站` item：
  - 高度：`36px`
  - 圆角：约 `10px`
  - 图标：`15-16px`
  - 文字：`14px`
  - 颜色：约 `#6f6861`

## 8. Clowder task #50 实施优先级

第一刀只做前端展现层，不改 store/API/schema：

1. Header 清理：移除 Bootcamp，保留 `对话` 和 `+ 新对话`
2. 删除 `全部展开 / 全部折叠`
3. Quick nav 调整：只保留 `Inbox`、`Saved`
4. `CHANNEL` header 加 `+`
5. `PROJECT` 视觉合并到 `CHANNEL` 列表，不再显示 PROJECT 字样
6. 新增 `DIRECT MESSAGES` section，列出具体 Agent
7. 保留底部回收站

## 9. 建议 CSS Token

```css
--slock-sidebar-bg: #f6efe7;
--slock-sidebar-border: #ded3c8;
--slock-sidebar-muted: #a29a93;
--slock-sidebar-text: #6f6861;
--slock-sidebar-strong: #241f1b;
--slock-sidebar-hover: rgba(0, 0, 0, 0.04);
--slock-sidebar-active: #ead8cc;
--slock-sidebar-action: #cc6743;
```

当前 Clowder 已是深色主题，task #50 实施时应把这些参数映射为暗色等价 token，而不是把左侧栏改回亮色：

```css
--clowder-sidebar-bg: var(--console-sidebar-bg);
--clowder-sidebar-border: var(--slock-border-color);
--clowder-sidebar-muted: var(--cafe-text-muted);
--clowder-sidebar-text: var(--cafe-text-secondary);
--clowder-sidebar-strong: var(--cafe-text);
--clowder-sidebar-hover: rgba(255, 255, 255, 0.04);
--clowder-sidebar-active: rgba(224, 84, 122, 0.14);
--clowder-sidebar-action: var(--cafe-accent);
```
