---
name: ppt-forge
description: >
  PPT 制作全链路：内容规划 → 风格定调 → Slide 制作 → 视觉审查 → 导出验证 → 交付。
  Use when: 做 PPT、做演示文稿、做 slide、做海报、PPT review、视觉审查。
  Not for: 纯代码开发（用 worktree/tdd）、纯文档写作（直接写）。
  Output: 高密度 HTML slide + 多猫审查通过 + 导出验证。
---

# PPT Forge — AI 演示文稿生产线

## 核心原则

**PPT 不是一个人的活，是多猫流水线。** 角色按当前 roster 可用猫分配。

- 主执行猫（当前持球猫）：内容规划 + HTML 制作 + density gate
- QA/审查猫（跨 family）：布局/信息审查 + Export Truth Gate
- 视觉把关猫（跨 family）：审美/品牌审查 + 风格定调

## 页面类型约束（开工前必读）

**不同页面类型有不同的内容约束。** 详见 [ppt-page-types.md](../refs/ppt-page-types.md)。

速查：
- **封面 (cover)**：只有标题+副标题，❌ 禁止长段落正文
- **目录 (toc)**：短问题列表（≤18 字/条），❌ 禁止长说明
- **章节页 (chapter)**：1-2 句过渡判断，❌ 禁止长段落和列表
- **内容页**：才是密度填充的主战场

**页面类型是第一道门禁，密度是第二道门禁。**

## 开局参数（必须声明）

| 参数 | 说明 | 示例 |
|------|------|------|
| 页型（archetype） | 决定密度、字号矩阵和信息组织方式 | 华为高密战略页 / KPI Dashboard / 发布会结论页 |
| 品牌 | 对标公司的视觉基因 | 华为 / Apple / 阿里 |
| 受众 | 谁看这个 PPT | CTO / 投资人 / 技术团队 |
| 场景 | PPT 用在哪 | 年会汇报 / 客户提案 / 内部分享 |
| 主观看模式 | 影响字号/密度/留白标准 | presentation（大屏）/ document（PDF 阅读） |

**没有开局参数 = 开工和审查都没有标准。开工前必须先锁这 5 项。**

## 场景路由

| 触发 | 场景 | 主导 | 脚本/工具 | 详细文档 |
|------|------|------|----------|---------|
| 铲屎官说"做个 PPT" | → **ppt-agent** 先做内容规划 | — | — | 用 ppt-agent skill |
| ppt-agent 交接包到达 | **B: 风格定调** | 视觉把关猫审 + 主执行猫做 | `design_taste.py` + `deck_to_html.py` | 见下方 Stage B |
| 风格确认 | **C: Slide 批量制作** | 主执行猫 | `deck_to_html.py` | [ppt-slide-authoring.md](../refs/ppt-slide-authoring.md) |
| Slide 做完 | **D: 视觉审查 Gate** | QA/审查猫(D1) + 视觉把关猫(D2) | `review_html_deck.py` + `narrative_critic.py` | [ppt-visual-review.md](../refs/ppt-visual-review.md) |
| 审查通过 | **E: Export Truth Gate** | QA/审查猫 | `export_pptx.py` | 见下方 Stage E |
| 导出验证通过 | **F: 交付** | 主执行猫 | — | [ppt-delivery.md](../refs/ppt-delivery.md) |
| 需要对比竞品 | **G: Benchmark 对拍** | QA/审查猫 + 视觉把关猫 | — | 主 skill 最小规则（ref 待补） |
| 铲屎官不满意 / 连续 2 轮 P1>0 | **R: 翻盘重来** | 全部参与猫 | — | 主 skill 最小规则（ref 待补） |

## 还没拆成 ref 的场景（当前最小真相源）

### A: 内容规划 → 已移交 ppt-agent

内容规划链路（Brief → 叙事 → 页面计划）现由 ppt-agent skill 负责。
ppt-forge 从 Stage B 开始，接收 ppt-agent 的交接包。

### B: 风格定调（必经门禁）

**输入**：ppt-agent 交接包（deck.json + narrative_plan.json + brand tokens CSS）

**流程**：

1. 选 2 页代表性样稿（cover + 信息最密的内容页）
2. 对每个样稿生成 3 套风格变体：
   - Variant 1: spacious-minimal（low × minimal × soft）
   - Variant 2: balanced-default（moderate × balanced × standard）
   - Variant 3: dense-bold（high × rich × bold）
3. 每套变体执行：
   ```bash
   python3 design_taste.py --variant N --token-css brand.tokens.css \
     --output style-pack.css --report style-pack-report.json
   ```
4. 合并 CSS：`cat brand.tokens.css style-pack.css > combined.css`
5. 渲染 2 页预览：
   ```bash
   python3 deck_to_html.py --input sample-deck.json --output preview.html \
     --schema deck-schema.json --token-css combined.css --report render-report.json
   ```
6. 输出 taste-report.json

**人审门禁**：人选定一个 variant。未选定 = 不进 Stage C。

### C: Slide 批量制作（脚本命令）

```bash
python3 deck_to_html.py --input deck.json --output deck.html \
  --schema deck-schema.json --token-css combined.css \
  --report render-report.json
```

### D: 视觉审查（脚本命令）

D1 布局/信息审查：
```bash
python3 review_html_deck.py --html deck.html --deck deck.json \
  --report review-report.json --require-token
```

D2 叙事连贯性：
```bash
python3 narrative_critic.py --deck deck.json \
  --narrative-plan narrative_plan.json --report narrative-review.json
```

### E: Export Truth Gate

- 检查：`native text / native chart / native table / screenshot fallback / repair dialog`
- 任何一项说不清 → 不进 F

### G: Benchmark 对拍

- 必须同 archetype、同主题、同观看模式比较
- 至少对拍：`信息密度 / 事实保留 / 说服力 / 品牌贴合度`

### R: 翻盘重来

- 连续 2 轮 P1>0 或铲屎官说"方向不对" → 直接回到 A/B，不准在坏页型上缝补
- 先写 `Author Synthesis`，说明这次为什么要重开

## 视觉审查 6 件套（D 场景输入包）

每次发起视觉审查，作者必须附带：

1. **品牌+受众 brief** — "华为风格，受众 CTO，1 页讲清 moat"
2. **页型（archetype）+ 主观看模式** — 防止 reviewer 把页面改型
3. **本页目的** — 一句话说清这页要达成什么
4. **截图/预览 URL** — 渲染结果
5. **HTML/CSS 源码** — 定位布局 bug 用
6. **密度数据** — whitespace%、element count、overflow

> 没有 6 件套 = 观感点评；有 6 件套 = P1/P2 级审查。

## 审查维度速查

### D1: 布局/信息审查（QA/审查猫）

| 级别 | 维度 | 判定 |
|------|------|------|
| P1 | 页面类型违规 | 封面有长正文/目录有长说明/章节页有列表（见 [ppt-page-types.md](../refs/ppt-page-types.md)） |
| P1 | 布局 bug | 真实 CSS/HTML 错误 |
| P1 | 信息失败 | 没讲清重点 / 层级错 / 受众看不懂 |
| P1 | 密度失衡 | 该密不密 / 该疏不疏 |

### D2: 审美/品牌审查（视觉把关猫）

| 级别 | 维度 | 判定 |
|------|------|------|
| P2 | 品牌偏移 | 不像目标公司的设计语言 |
| P2 | 视觉一致性 | 字号/卡片/边框/图标语言不统一 |

审美五维：色彩体系 · 字体排印 · 空间网格 · 视觉元素 · 密度平衡

## HTML Slide 预览（ref: browser-preview skill）

Slide 做完必须先自己看一遍再交活。预览走 **Hub 内嵌浏览器**（browser-preview skill），禁止用 Chrome MCP / `open` 命令 / Playwright。

### 预览流程

```
1. 图片内联 — 所有 <img src="xxx.png"> 必须转成 data URI
   原因：Preview Gateway 要求每个请求带 __preview_port 参数，
   相对路径请求（如 /image.png）不带此参数 → 400 错误 → 图裂。

2. 起 HTTP server — 每个 slide 用独立端口
   原因：BrowserPanel 按 port 去重，同 port 只创建 1 个 tab。
   N 个 slide → N 个端口 → N 个 tab。
   python3 -m http.server PORT（每个 slide 一个端口）

3. 调 auto-open API — 每个端口调一次
   curl -X POST http://localhost:3003/api/preview/auto-open \
     -H "Content-Type: application/json" \
     -d '{"port": PORT, "path": "/slide.html"}'
   间隔 300ms 避免 socket 事件丢失。
```

### 图片内联参考

```python
import base64, re, os
def inline_images(html_path):
    with open(html_path) as f: content = f.read()
    def replace(m):
        src = m.group(1)
        if not os.path.exists(src): return m.group(0)
        b64 = base64.b64encode(open(src,'rb').read()).decode()
        mime = 'image/png' if src.endswith('.png') else 'image/jpeg'
        return f'src="data:{mime};base64,{b64}"'
    return re.sub(r'src="([^"]+\.(?:png|jpg|jpeg|gif|webp))"', replace, content)
```

### 陷阱速查

| 现象 | 根因 | 修法 |
|------|------|------|
| 图片裂了 | 相对路径缺 `__preview_port` | 图片转 data URI |
| 只有 1 个 tab | 同 port 去重 | 每 slide 独立端口 |
| proxy error | HTTP server 没跑 | 先 `curl localhost:PORT` 验证 |

## 密度填充手法

详见 [ppt-density-playbook.md](../refs/ppt-density-playbook.md)

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 封面/目录/章节页违反类型约束 | PPT 结构混乱，观众认知负担增加 | 开工前读 ppt-page-types.md，审查时优先检查类型约束 |
| 没声明开局参数 | 开工和审查没有标准 | 开工前锁 `archetype + 品牌 + 受众 + 场景 + 主观看模式` |
| 20 页全做完才审 | 返工成本爆炸 | B 场景：先做 1-2 页核心页定调 |
| 自己说"没问题"不截图 | 布局 bug 漏检 | 自检必须截图看一遍再交活 |
| 审查只给截图没给 HTML | 只能说"这里怪" | 必须带 6 件套 |
| 主 skill 挂死链 ref | 执行时靠口头补流程 | 没写出来的 ref 不准继续写成可执行路由 |
| 跳过 Export Gate | 导出后不可编辑/乱码 | 独立验证导出质量 |

## 和其他 Skill 的区别

- `request-review` / `receive-review`：**代码**审查 — ppt-forge D 场景是**视觉**审查
- `expert-panel`：多猫分析报告 — ppt-forge 是做 PPT
- `quality-gate`：代码自检 — ppt-forge 有自己的 density gate

## 从 ppt-agent 接收的交接包

| 交接物 | 格式 | 来源 |
|--------|------|------|
| deck.json | JSON (deck-schema.json) | ppt-agent Stage 3 |
| narrative_plan.json | JSON | ppt-agent Stage 2 |
| brand tokens CSS | CSS | L0 / 用户提供 |
| archetype | 文本 | Brief |
| brand | 文本 | Brief |
| audience | 文本 | Brief |
| scenario | 文本 | Brief |
| view-mode | 文本 | Brief |

## 下一步

完成交付(F) 后 → 如果是 feature 的一部分 → `feat-lifecycle`
