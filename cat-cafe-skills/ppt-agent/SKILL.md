---
name: ppt-agent
description: >
  PPT 内容规划全链路：Brief 补齐 → 叙事规划 → 页面计划 → 交付给 ppt-forge。
  模型在规则约束下推理，不用关键词硬编码。
  Use when: 用户要做 PPT、需要从大纲/资料规划页面结构、需要叙事设计。
  Not for: 风格定调/HTML 渲染/导出（用 ppt-forge）、纯代码开发。
  Output: narrative_plan.json + deck.json + 交接包给 ppt-forge。
triggers:
  - "ppt-agent"
  - "PPT Agent"
  - "页面计划"
  - "Brief补齐"
  - "资料理解"
  - "叙事规划"
  - "从大纲生成 PPT"
  - "PPT蓝图"
---

# PPT Agent — 内容规划链路（L1-L3）

## 核心原则

AI 不直接做 PPT。先理解要解决什么问题，再规划每一页讲什么、凭什么讲。

```
大纲/资料
  → Stage 1: Brief 补齐 ─── 人审 ✓
  → Stage 2: 叙事规划 ─── 人审 ✓
  → Stage 3: 页面计划 ─── 人审 ✓
  → 交接包 → ppt-forge
```

**关键设计决策**：Stage 2 和 Stage 3 由模型推理完成，不调用脚本。叙事模型选择、pageType 分配、designBrief 生成都需要理解内容和受众，不能用关键词匹配硬编码。规则和原则见 refs/。

## Stage 1: Brief 补齐

**输入**：用户的模糊需求 + 大纲/资料。

**必填 5 项（开局参数）**：

| 参数 | 说明 | 示例 |
|------|------|------|
| archetype | 页型原型 | 华为高密战略页 / Apple 发布会 |
| brand | 品牌 | gov-enterprise / tech-startup |
| audience | 受众 | CTO / 投资人 / 技术团队 |
| scenario | 场景 | 客户提案 / 年会汇报 / 内部分享 |
| view-mode | 观看模式 | presentation（大屏）/ document（PDF） |

**交互规则**：
- 一次最多问 3-5 个问题
- 用户答不全时，输出 Brief 摘要 + 暂定假设（标注"暂定"）
- 没有这 5 项 = 后续所有步骤没有标准

**人审门禁**：Brief 确认后才能进 Stage 2。

## Stage 2: 叙事规划

**输入**：已确认 Brief + 大纲/资料。

**执行方式**：模型推理，参考 [narrative-rules.md](refs/narrative-rules.md)。

**核心任务**：
1. **选叙事模型** — 理解受众决策模式 + 场景沟通目的 + 内容论证结构后，从 3 种模型中选最合适的（不是匹配关键词）
2. **写故事主线** — 一句话概括叙事弧线（包含受众、起点、终点、价值）
3. **标注章节** — 为每个章节标注叙事阶段、核心判断、证据需求
4. **写过渡语** — 相邻章节之间的衔接

**产物**：`narrative_plan.json`（schema 见 refs/narrative-rules.md 底部）

**人审门禁**：叙事结构确认后才能进 Stage 3。

## Stage 3: 页面计划

**输入**：已确认 Brief + narrative_plan.json + 大纲/资料。

**执行方式**：模型推理，参考 [page-type-rules.md](refs/page-type-rules.md) + [design-brief-rules.md](refs/design-brief-rules.md)。

**核心任务**：
1. **分配 pageType** — 理解每页的论证目的后，从 19 种类型中选最贴切的（不是匹配标题关键词）
2. **生成 designBrief** — 针对每页内容生成 purpose/principle/task/direction
3. **设定 density** — 结构页低密度、内容页中密度、证据页高密度
4. **选择 layout** — 根据 pageType 选默认 layout
5. **映射 animation** — 根据 pageType 选入场/过渡动画
6. **写 bridge** — 页面之间的衔接语

**产物**：`deck.json`（符合 deck-schema.json）

每页包含：
```json
{
  "id": "slide-01",
  "pageType": "cover",
  "stage": "Context",
  "layout": "fullbleed",
  "designBrief": { "purpose", "principle", "task", "direction" },
  "visualAtmosphere": { "background", "imageStyle", "mood", "imagePrompt" },
  "content": { "headline", "subheadline", "body", "bullets", "evidence" },
  "density": { "target": "low", "whitespace": "55%", "elementCount": 5 },
  "assets": { "images": [], "icons": [], "charts": [] },
  "animation": { "enter", "transition", "duration" },
  "bridge": { "next": "衔接语" }
}
```

**人审门禁**：页面计划确认后才能交接给 ppt-forge。

## 交接协议（→ ppt-forge）

Stage 3 完成后，输出交接包：

| 交接物 | 格式 | 说明 |
|--------|------|------|
| deck.json | JSON | 页面计划 IR（符合 deck-schema.json） |
| narrative_plan.json | JSON | 叙事结构 |
| brand tokens CSS | CSS | 品牌设计语言（L0 产物或用户提供） |
| Brief 元数据 | 文本 | archetype / brand / audience / scenario / view-mode |

ppt-forge 从 Stage B（风格定调）接手。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 用标题关键词匹配 pageType | "AI安全架构"被分成 security-proof | 理解论证目的：展示系统设计→architecture |
| Brief 没锁就开始规划 | 后续所有步骤没标准 | 必填 5 项确认后再动 |
| 叙事模型用 regex 选 | 多场景重叠时选错 | 理解受众决策模式后推理 |
| designBrief 用固定模板 | 每页都一样，失去针对性 | 针对具体内容生成 |
| 一页塞多个观点 | PPT 难读难讲 | 一页只让观众记住一件事 |
| 跳过叙事规划直接做页面 | 缺叙事主线，页面堆砌 | 先确认叙事结构再规划页面 |

## 和其他 Skill 的关系

- `ppt-forge`：接收本 skill 的交接包，做风格定调 → 渲染 → 质检 → 导出
- `ppt-agent-workflow-san`：旧版通用 workflow skill，本 skill 是它的具体化实现

## 参考文件

- [refs/narrative-rules.md](refs/narrative-rules.md) — 叙事模型定义 + 选择原则 + 输出 schema
- [refs/page-type-rules.md](refs/page-type-rules.md) — 19 种 pageType 定义 + 分配原则 + layout/density/animation 映射
- [refs/design-brief-rules.md](refs/design-brief-rules.md) — designBrief 四维度 + visualAtmosphere 原则
