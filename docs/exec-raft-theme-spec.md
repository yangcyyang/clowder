---
feature_ids: []
topics: [ui, theme, raft-parity, execution-plan]
doc_kind: spec
created: 2026-07-02
author: 专家-Claude
status: proposed
context: "路线A：Raft 视觉复刻主题——基于两端实测值的逐项对照规格"
---

# 路线 A：Raft 视觉复刻规格（实测对照版）

> 执行者 @老者-codex，验收 @专家-Claude（双端截图逐项对照）。
> **重要纠偏**：我此前说 Raft 是"细灰边框素雅风"——**实测证伪**。Raft 实际同样是"黑边框 + 0 圆角 + 粉/黄强调"的新粗野语言（Clowder 的风格本来就源自 Slock/Raft）。**真正的差距不是设计语言，是"度"**：Raft = 纯白底 + 元素更紧凑 + 强调色面积克制；Clowder = 米白底 + 元素偏大 + 强调色大块涂。

## 一、Raft 实测值（OpenCLI 从 app.raft.build 扒的 computed style）

| 项 | Raft 实测 |
|---|---|
| body 背景 | `rgb(255,255,255)` 纯白 |
| 正文字号 | 16px（消息区），channel 项 14px |
| 文字色 | `rgb(20,17,17)` 近黑 |
| 按钮边框 | **2px 黑**（oklch(0 0 0)） |
| 按钮圆角 | **0px** |
| 选中频道项 | bg `rgb(254,125,168)` 粉、**0 圆角**、pad `4px 8px`、14px、fw 500 |
| tab 栏高 | 28px（昨日实测） |
| 字体 | Space Grotesk（昨日实测，已对齐 ✅） |

## 二、Clowder 目标改动（token 级）

1. **背景分层**：主聊天区保持 `#ffffff` 纯白；频道侧栏使用 Raft 实测奶油色 `#fffaef`，不要整块都刷白。
2. **密度收紧**：
   - 频道列表项：pad 收到 ~`4px 8px`、字号 14px、行高收紧（现状偏大）。
   - 左侧"对话"标题、按钮等整体缩一号。
3. **强调色面积克制（关键）**：
   - 保留粉/黄强调色（这就是 Raft 语言），但**只用于**：选中频道条（Raft 同款 pad 4x8 小条）、小徽章、主按钮。
   - 去掉错误大色块：文件路径不再黑底长条（改为细边框 chip 或 inline code 样式）。
   - Activity rail 不收窄：Raft 实测为 `64px` 正黄 `#ffd440`，只去掉非激活图标的白盒。
4. **边框统一 2px 黑、0 圆角**：对齐 Raft（昨天右上按钮改的 1px/6px 圆角要**再对一次**：实测 Raft 是 2px/0px——以实测为准）。
5. **阴影**：Raft 几乎无投影；Clowder 的硬阴影(chip shadow)只保留极小或去掉。

## 三、做法与边界
- 做成**主题预设**（新 token set 或覆盖现 slock 主题），可切换、可回退；不动功能代码、不动 dark mode。
- 分两个 commit：①token 层（背景/边框/圆角/阴影）②密度层（频道列表/标题/按钮尺寸）。
- 每个 commit 我用 browse(Clowder) + OpenCLI(Raft) 双端截图对照验收。

## 三·五、复刻标准图（2026-07-02 增补，优先级高于上文文字描述）

yangcyyang 提供的 Raft 高清参照：`docs/raft-target-reference.png`。**验收以此图为准。**

由此图纠正/增补的目标：
1. **Chat/Tasks/Files tab = 连体分段控件（segmented control）**：三段共享边框连成一条、外圈黑边；每段 icon+文字（💬 Chat / ☰ Tasks / 📎 Files）；选中段黄色填充。**不是**分开的三个盒子，也**不是**无边框轻条（我此前"去盒化只留分隔线"的说法作废）。删掉尾部空盒。
2. **频道标题行**：`#` 放黄底黑边小方块 + 频道名。
3. **右上角**：统一方形黑边图标按钮（文字按钮"技能库/沉淀为知识"收成图标+tooltip）。
4. **thread 回复入口 chip**：对齐 Raft 的 "▶ #N @某某" 青色 chip + "N replies · N new" 白底黑边 chip 样式。
5. **数量徽章**：统一 Raft 的粉色小胶囊（如 Activity 99+）。
6. **三区色带**：Activity rail `#ffd440 / 64px` → 频道侧栏 `#fffaef` → 主聊天区 `#ffffff`。黄条图标默认黑色裸图标，仅当前激活项使用白底黑边盒。

## 四、验收标准
- 并排截图：底色、边框粗细/圆角、频道项尺寸、强调色面积——逐项与 Raft 实测值一致或明显靠近。
- 现有测试零回归；`NEXT_PUBLIC_*` 或主题切换可回旧观感。
- 路线 B（thread 右面板）等本规格验收后单独开。
