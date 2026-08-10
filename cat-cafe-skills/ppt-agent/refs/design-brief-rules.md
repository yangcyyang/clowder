# 设计意图规则

## designBrief 四维度

每页必须生成 designBrief，包含 4 个维度：

| 维度 | 说明 | 示例 |
|------|------|------|
| purpose | 这页在视觉上要达成什么 | "建立第一印象 + 品牌识别" |
| principle | 设计原则 | "极简聚焦、品牌基因最大化" |
| task | 设计任务（用受众视角） | "一句话抓住注意力，3 秒内传递核心价值主张" |
| direction | 视觉方向 | "全幅视觉 + 品牌色主导 + 超大字号标题" |

## 各 pageType 的 designBrief 参考

### 结构页

**cover**：
- purpose: 建立第一印象 + 品牌识别
- principle: 极简聚焦、品牌基因最大化
- task: 一句话抓住注意力，3 秒内传递核心价值主张
- direction: 全幅视觉 + 品牌色主导 + 超大字号标题 + 副标题点明受众/场景

**agenda**：
- purpose: 降低认知负荷，预告汇报结构
- principle: 清晰节制、编号引导
- task: 让读者 5 秒内掌握整个叙事的逻辑线
- direction: 编号列表 + 当前高亮 + 大面积留白

**chapter**：
- purpose: 章节切换信号，给观众呼吸节奏
- principle: 过渡感、最小元素
- task: 1-2 句过渡判断，预告下一章方向
- direction: 大字 + 品牌辅色满版 + 最少元素

**closing**：
- purpose: 记忆锚点 + 行动号召
- principle: 收束聚焦、情感升华
- task: 让读者带走一句话 + 一个行动指引
- direction: 品牌主色满版 + 核心结论 + CTA + 联系方式

### 内容页

**viewpoint**：让读者接受一个关键判断。标题即观点 + 2-3 个支撑证据 + 留白聚焦。

**mechanism**：让读者理解工作原理。流程图/步骤图 + 简明标注 + 层层递进。

**judgement**：让读者基于证据得出判断。判断标题 + 正反论据 + 结论。

**summary**：让读者记住 3-5 个核心要点。编号列表 + 粗体关键词 + 数字放大。

**comparison**：让读者看清差异化优势。矩阵表格/左右分栏 + 维度对齐 + 高亮优劣势。

**architecture**：让读者理解系统整体结构。架构图 + 分层标注 + 数据流向。

**capability**：让读者知道我们的能力。卡片网格 + 图标 + 能力名称 + 一句话描述。

**scenario**：让读者代入使用场景。场景标题 + 用户旅程 + 效果对比。

**roadmap**：让读者了解未来方向。时间轴 + 里程碑节点 + 关键交付物。

### 证据页

**data-insight**：用数据说话。大数字 + 趋势线 + 对比锚点。

**case-proof**：用案例证明。客户名称 + 挑战→方案→结果 + 关键指标。

**cost-comparison**：对比投入产出。成本矩阵 + 性价比高亮 + ROI 计算。

**security-proof**：展示安全能力。认证列表 + 安全架构图 + 合规标准。

**demo-screenshot**：展示产品实物。主截图 + 标注 + 一句话说明。

## visualAtmosphere 原则

视觉氛围描述页面的背景、图片风格和情绪：

| pageType | 背景类型 | 情绪 |
|----------|---------|------|
| cover | gradient (accent→fg) | tech-forward, trustworthy |
| chapter | solid (accent) | transition, breathing-space |
| closing | gradient (accent→fg) | memorable, call-to-action |
| agenda | solid (surface) | clean, structured |
| 内容页 | 根据内容选择 | 匹配论证目的 |

## 原则总结

1. designBrief 必须针对具体页面内容生成，不要使用通用模板
2. task 维度用受众视角写（"让读者..."），不用作者视角
3. direction 维度要具体到视觉元素，不写空泛描述
4. 上述参考是默认值，执行猫可以根据实际内容调整
