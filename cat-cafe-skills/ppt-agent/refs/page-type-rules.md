# 页面类型分配规则

## 19 种 pageType 完整定义

### 结构页（自动分配）

| pageType | 用途 | 自动规则 |
|----------|------|---------|
| cover | 封面 — 建立第一印象 | 第一页 |
| agenda | 目录 — 预告汇报结构 | 大纲明确标注"目录/议程" |
| chapter | 章节页 — 呼吸节奏 | 大纲中的章/篇分隔 |
| closing | 结尾 — 行动号召 | 最后一页 |

### 内容页（需要理解论证目的）

| pageType | 用途 | 何时选用 |
|----------|------|---------|
| viewpoint | 提出核心观点或洞察 | 这页要让受众接受一个判断 |
| mechanism | 解释工作原理或流程 | 这页要让受众理解"怎么运作" |
| judgement | 呈现决策依据 | 这页要让受众基于证据做判断 |
| summary | 精炼要点 | 这页要让受众记住 3-5 个要点 |
| comparison | 对比分析 | 这页要让受众看清差异化优势 |
| process | 展示步骤流程 | 这页要让受众理解完整流程 |
| architecture | 展示系统架构 | 这页要让受众理解系统结构 |
| capability | 展示核心能力 | 这页要让受众知道"我们有什么" |
| scenario | 展示应用场景 | 这页要让受众代入使用场景 |
| roadmap | 展示时间线规划 | 这页要让受众了解未来方向 |

### 证据页（需要理解证据类型）

| pageType | 用途 | 何时选用 |
|----------|------|---------|
| data-insight | 用数据量化价值 | 证据是数字/指标/趋势 |
| case-proof | 用客户案例证明 | 证据是真实落地案例 |
| cost-comparison | 对比成本/ROI | 证据是投入产出比 |
| security-proof | 展示安全合规 | 证据是认证/等保/合规标准 |
| demo-screenshot | 展示产品界面 | 证据是产品实际截图 |

## 分类决策原则

**不要匹配标题关键词。** 理解每页的**论证目的**来分配类型。

决策流程：
1. 这页在叙事中的角色是什么？（从 narrative_plan 的 stage 判断）
2. 这页要让受众得出什么结论？
3. 支撑这个结论的是观点、机制、数据、案例、还是产品演示？
4. 基于 3 的答案选 pageType

**常见易错**：
- "AI 安全架构" → 看论证目的：如果是展示安全能力 → security-proof；如果是展示系统设计 → architecture
- "ROI 分析" → 看论证目的：如果是用数据说服 → data-insight；如果是对比成本 → cost-comparison
- "客户案例" → 看论证目的：如果是证明价值 → case-proof；如果是展示场景 → scenario

## 叙事阶段 → pageType 关联

| 叙事阶段 | 常见 pageType |
|---------|-------------|
| Context | cover, agenda, viewpoint |
| Transition | chapter |
| Core Muscle | mechanism, architecture, capability, comparison, scenario, judgement, process |
| Proof | data-insight, case-proof, cost-comparison, security-proof, demo-screenshot |
| Decision | closing, summary, roadmap |

## Layout 映射

| pageType | 默认 layout |
|----------|------------|
| cover | fullbleed |
| agenda | single-column |
| chapter | fullbleed |
| closing | fullbleed |
| viewpoint | two-column |
| mechanism | process-flow |
| judgement | two-column |
| summary | single-column |
| comparison | comparison-matrix |
| process | process-flow |
| architecture | architecture-capability |
| capability | architecture-capability |
| scenario | two-column |
| roadmap | process-flow |
| data-insight | data-insight |
| case-proof | two-column |
| cost-comparison | comparison-matrix |
| security-proof | two-column |
| demo-screenshot | whitespace |

## Density 目标

| 密度 | pageType | 留白目标 |
|------|----------|---------|
| low | cover, agenda, chapter, closing, summary | 45-60% |
| moderate | viewpoint, mechanism, capability, comparison, architecture, scenario, judgement, process | 35-40% |
| high | data-insight, case-proof, cost-comparison, security-proof, demo-screenshot, roadmap | 28-32% |

## 动画映射

| pageType | 入场动画 | 过渡动画 |
|----------|---------|---------|
| cover | fade-in + scale-up | - |
| agenda | stagger-in | crossfade |
| chapter | slide-from-right | fade |
| closing | zoom-in | fade-to-brand-color |
| viewpoint | fade-in-up | crossfade |
| mechanism | sequential-reveal | slide-left |
| data-insight | fade-in | crossfade |
| case-proof | fade-in-up | crossfade |

其余 pageType 默认 `fade-in + crossfade`。
