# UI Skills 全目录（ui-skills.com）

> **网站**: https://www.ui-skills.com/
> **定位**: Skills for Design Engineers — Claude Code / AI Agent 的前端设计技能库
> **维护方**: Interface Office（interfaceoffice.com）
> **收录时间**: 2026-05-25

---

## 费曼介绍（~100 字）

ui-skills.com 是一个给 AI 编码助手（主要是 Claude Code）用的"设计技能包"市场。你可以把它想象成给 AI 装上"设计审美插件"——每个 skill 是一份 SKILL.md 文件，告诉 AI 在写前端代码时应该遵循什么设计原则、用什么配色、怎么做动画、怎么保证无障碍。比如装上 `shadcn` skill，AI 就知道怎么正确使用 shadcn/ui 组件；装上 `impeccable`，AI 写出来的界面就不会像默认模板。本质上是用 prompt engineering 把人类设计师的经验注入 AI 的代码生成流程。

---

## 目录

- [一、按主题分类总览](#一按主题分类总览)
- [二、全部 Skill 详情](#二全部-skill-详情)
  - [Taste 审美风格](#1-taste-审美风格)
  - [Craft 执行工艺](#2-craft-执行工艺)
  - [Motion 动效](#3-motion-动效)
  - [Systems 设计系统](#4-systems-设计系统)
  - [Visual 视觉](#5-visual-视觉)
  - [Interaction 交互](#6-interaction-交互)
  - [Performance 性能](#7-performance-性能)
  - [Accessibility 无障碍](#8-accessibility-无障碍)
  - [Frameworks 框架专属](#9-frameworks-框架专属)
  - [3D / Three.js](#10-3d--threejs)
- [三、作者索引](#三作者索引)

---

## 一、按主题分类总览

| 主题 | 说明 | Skill 数 |
|------|------|----------|
| **Taste** | 审美判断、风格方向、反模板化 | ~20 |
| **Craft** | 执行质量、间距、打磨、生产就绪 | ~15 |
| **Motion** | 动画系统、过渡、交互节奏 | ~15 |
| **Systems** | 设计系统、组件架构、可扩展 UI 基础 | ~20 |
| **Visual** | 视觉打磨、层级、有意图的界面方向 | ~20 |
| **Interaction** | 微交互、反馈回路、UX 行为模式 | ~15 |
| **Performance** | 渲染、打包、运行时优化 | ~10 |
| **Accessibility** | 无障碍模式、WCAG 审计、修复流程 | ~8 |

---

## 二、全部 Skill 详情

### 1. Taste 审美风格

#### `ibelick/baseline-ui` — Baseline UI
- **作者**: Ibelick
- **描述**: 在 Tailwind CSS 项目中校验动画时长、强制排版比例、检查组件无障碍性、防止布局反模式。适用于构建 UI 组件、审查 CSS 工具类、样式化 React 视图或强制设计一致性。
- **费曼**: 给 AI 装一个"Tailwind 质检员"——写组件时自动检查你有没有用错字号、动画时长是否合理、布局有没有反模式。

#### `anthropics/frontend-design` — Frontend Design
- **作者**: Anthropic（官方）
- **描述**: 创建独特的、生产级的前端界面，具有高设计质量。生成创意、精致的代码和 UI 设计，避免通用 AI 美学。
- **费曼**: Anthropic 官方出品的"反 AI 模板脸"技能——让 AI 写出来的页面不像 AI 写的。

#### `anthropics/canvas-design` — Canvas Design
- **作者**: Anthropic（官方）
- **描述**: 使用设计哲学在数字画布上创建原创视觉设计和艺术，聚焦形式、空间和色彩。
- **费曼**: 让 AI 在 HTML Canvas 上搞艺术创作——不是画图表，是真的做视觉艺术。

#### `emilkowalski/emil-design-eng` — Emil Design Eng
- **作者**: Emil Kowalski
- **描述**: Emil Kowalski 的设计工程哲学，覆盖 UI 打磨、组件、动画和生产就绪的前端工艺。
- **费曼**: 把 Emil Kowalski（知名设计工程师）的审美方法论打包给 AI——怎么做精致的组件、怎么调动画节奏。

#### `leonxlnx/brutalist-skill` — Industrial Brutalist UI
- **作者**: Leonxlnx
- **描述**: 原始的、机械感的界面方向，混合瑞士印刷结构和终端风格的粗野主义美学。
- **费曼**: 让 AI 生成"工业粗野风"界面——终端感、机械感、瑞士网格打底。

#### `leonxlnx/minimalist-skill` — Minimalist
- **作者**: Leonxlnx
- **描述**: 编辑级极简界面，单色调色板、排版对比、克制的视觉元素。
- **费曼**: 让 AI 做"杂志极简风"——黑白为主、字体当主角、留白就是设计。

#### `leonxlnx/soft-skill` — Soft
- **作者**: Leonxlnx
- **描述**: 高端视觉设计指导，覆盖高级排版、间距、深度和动画系统。
- **费曼**: 让 AI 做"柔和高端风"——精致的阴影、流畅的动画、优雅的间距。

#### `leonxlnx/taste-skill` — Taste
- **作者**: Leonxlnx
- **描述**: 资深 UI/UX 前端技能，强制反低质量设计决策、动效质量和架构纪律。
- **费曼**: 给 AI 装一个"品味过滤器"——自动拒绝丑的设计选择。

#### `leonxlnx/redesign-skill` — Redesign
- **作者**: Leonxlnx
- **描述**: 审计和升级现有界面到高级视觉质量，同时保留产品功能。
- **费曼**: 让 AI 做"UI 翻新"——在不改功能的前提下把界面提升到高级感。

#### `leonxlnx/gpt-tasteskill` — GPT Taste
- **作者**: Leonxlnx
- **描述**: 高能动性 UX/UI 技能，严格限制布局变化、排版和 GSAP 动效工程约束。
- **费曼**: 给 AI 装 GSAP 动效引擎+严格的布局纪律——写出来的页面动效专业级。

#### `leonxlnx/output-skill` — Output
- **作者**: Leonxlnx
- **描述**: 强制完整、非截断的代码输出，阻止占位符或半成品响应。
- **费曼**: 解决 AI "写一半就停"的问题——强制输出完整代码。

#### `leonxlnx/stitch-skill` — Stitch
- **作者**: Leonxlnx
- **描述**: Google Stitch 的语义设计系统技能，严格的反通用 UI 生成规则。
- **费曼**: 为 Google Stitch 设计工具定制的"反模板"技能。

#### `pbakaus/impeccable` — Impeccable
- **作者**: pbakaus
- **描述**: 旗舰设计技能，生产级、反通用前端界面，强工艺和一致性。
- **费曼**: pbakaus 的"王牌技能"——让 AI 写出来的界面达到设计师水准，不糊弄。

#### `pbakaus/bolder` — Bolder
- **作者**: pbakaus
- **描述**: 增加视觉冲击力和个性，适用于太安全、太无聊或太通用的界面。
- **费曼**: 界面太"安全"了？这个技能让 AI 大胆一点——加颜色、加对比、加个性。

#### `pbakaus/quieter` — Quieter
- **作者**: pbakaus
- **描述**: 降低过度强烈的设计，同时保持质量和保留层级。
- **费曼**: 界面太吵了？这个技能让 AI 安静下来——降饱和、减动效、留层级。

#### `pbakaus/delight` — Delight
- **作者**: pbakaus
- **描述**: 通过精心设计的交互细节和情感 UX 触点，增加个性和难忘时刻。
- **费曼**: 让 AI 在界面上藏"小惊喜"——hover 微动效、加载小动画、情感化反馈。

#### `zeke/swiss-design` — Swiss Design
- **作者**: Zeke
- **描述**: 瑞士设计系统技能，聚焦网格纪律、排版层级和干净的编辑式界面构图。
- **费曼**: 让 AI 用"瑞士国际主义风格"做设计——严格网格、清晰层级、干净利落。

#### `rams/rams` — Rams
- **作者**: Rams
- **描述**: 实时设计反馈技能，聚焦无障碍、间距、排版、对比度和组件质量。
- **费曼**: 以 Dieter Rams 的设计原则给 AI 实时反馈——"少即是多"的质检员。

#### `bencium/bencium-innovative-ux-designer` — Innovative UX Designer
- **作者**: Bencium
- **描述**: 创建独特的、生产级的前端界面，高设计质量。生成创意、精致的代码，避免通用 AI 美学。
- **费曼**: 另一个"反 AI 模板脸"技能——强调创新和独特性。

---

### 2. Craft 执行工艺

#### `ibelick/fixing-accessibility` — Fixing Accessibility
- **作者**: Ibelick
- **描述**: 审计和修复 HTML 无障碍问题，包括 ARIA 标签、键盘导航、焦点管理、颜色对比和表单错误。
- **费曼**: AI 的"无障碍修复专家"——自动检查你的按钮有没有 label、表单能不能用键盘操作。

#### `ibelick/fixing-motion-performance` — Fixing Motion Performance
- **作者**: Ibelick
- **描述**: 审计和修复动画性能问题，包括布局抖动、合成器属性、滚动关联动效和模糊效果。
- **费曼**: 动画卡了？这个技能帮 AI 诊断——是不是触发了 layout 重排、blur 是不是太重了。

#### `ibelick/fixing-metadata` — Fixing Metadata
- **作者**: Ibelick
- **描述**: 审计和修复 HTML 元数据，包括页面标题、meta 描述、canonical URL、Open Graph 标签、Twitter Cards、favicon、JSON-LD 结构化数据和 robots 指令。
- **费曼**: AI 的"SEO 元数据检查员"——确保每个页面的 title、OG 标签、结构化数据都正确。

#### `pbakaus/polish` — Polish
- **作者**: pbakaus
- **描述**: 最终质量检查——间距、对齐和一致性，为上线做准备。
- **费曼**: 上线前的"最后一道打磨"——AI 检查所有间距和对齐。

#### `pbakaus/layout` — Layout
- **作者**: pbakaus
- **描述**: 修复间距、构图和层级节奏，当 UI 布局感觉拥挤、平坦或错位时使用。
- **费曼**: 界面挤在一起？这个技能让 AI 重新调间距和构图。

#### `pbakaus/typeset` — Typeset
- **作者**: pbakaus
- **描述**: 改进排版系统、层级、可读性和文本节奏，让界面更有意图感。
- **费曼**: AI 的"字体排版教练"——教 AI 怎么用字号、行高、字重建立视觉层级。

#### `pbakaus/shape` — Shape
- **作者**: pbakaus
- **描述**: 在编码前规划功能 UX，通过结构化的设计访谈产出可执行的设计简报。
- **费曼**: 写代码前先让 AI 做"设计访谈"——问清楚需求再动手，不是上来就写。

#### `pbakaus/harden` — Harden
- **作者**: pbakaus
- **描述**: 让界面生产就绪——健壮的空状态、边界情况、错误处理、新手引导和国际化。
- **费曼**: AI 的"生产加固器"——确保空列表有提示、错误有兜底、多语言不炸。

#### `pbakaus/clarify` — Clarify
- **作者**: pbakaus
- **描述**: 改进标签、微文案和 UX 消息，让界面文本更清晰、更容易操作。
- **费曼**: AI 的"文案优化器"——把"Submit"改成"发布文章"，把"Error"改成"网络断了，请重试"。

#### `dammyjay93/interface-design` — Interface Design
- **作者**: Dammyjay93
- **描述**: 界面设计专项技能：仪表盘、管理后台和 SaaS 应用。聚焦工艺和一致性。
- **费曼**: 专门教 AI 做"后台管理系统"——表格、卡片、侧边栏、数据面板。

#### `jakubkrehel/make-interfaces-feel-better` — Make Interfaces Feel Better
- **作者**: Jakub Krehel
- **描述**: 设计工程原则，让界面感觉精致，聚焦微交互、排版和视觉细节。
- **费曼**: 教 AI 注意"手感"——按钮按下去的反馈、文字和图标的对齐、微妙的阴影。

#### `nextlevelbuilder/ui-ux-pro-max` — UI/UX Pro Max
- **作者**: NextLevelBuilder
- **描述**: 全面的 UI/UX 设计智能，50+ 风格、97 种调色板和 9 种技术栈，用于构建专业界面。
- **费曼**: 给 AI 装一个"设计百科全书"——50 种风格随便选，97 套配色直接用。

#### `pbakaus/audit` — Audit
- **作者**: pbakaus
- **描述**: 运行技术 UI 质量审计，覆盖无障碍、性能、主题化、响应式行为和反模式。
- **费曼**: AI 的"全面体检"——一次性检查无障碍、性能、响应式、反模式。

#### `pbakaus/critique` — Critique
- **作者**: pbakaus
- **描述**: 用结构化 UX 评分、persona 检查和可操作的修复指导来评估设计质量。
- **费曼**: 让 AI 当"设计评审员"——给界面打分，指出问题，给出修复建议。

---

### 3. Motion 动效

#### `pbakaus/animate` — Animate
- **作者**: pbakaus
- **描述**: 用有目的的动画和微交互增强 UX，支持可用性和愉悦感。
- **费曼**: AI 的"动效导演"——教 AI 什么时候该加动画、加什么动画、多快多慢。

#### `pbakaus/overdrive` — Overdrive
- **作者**: pbakaus
- **描述**: 把界面推入高冲击力领域——高级动画、着色器和雄心勃勃的交互系统。
- **费曼**: 界面太普通？这个技能让 AI 上"超载模式"——WebGL、粒子、高级动效。

#### `raphaelsalaja/12-principles-of-animation` — 12 Principles of Animation
- **作者**: Raphael Salaja
- **描述**: 把迪士尼 12 条动画原则应用到 Web 界面，让动效感觉自然、有机、人性化。
- **费曼**: 把迪士尼动画师的 12 条黄金法则教给 AI——挤压拉伸、预备动作、缓入缓出。

#### `raphaelsalaja/mastering-animate-presence` — Mastering AnimatePresence
- **作者**: Raphael Salaja
- **描述**: 审计 Motion 和 Framer Motion 的退出/存在模式，提供 AnimatePresence 的实用修复方案。
- **费曼**: Framer Motion 的 `AnimatePresence` 总是出问题？这个技能教 AI 正确用法。

#### `raphaelsalaja/morphing-icons` — Morphing Icons
- **作者**: Raphael Salaja
- **描述**: 构建在 SVG 形状之间变形的图标组件，实现流畅的线条变换。
- **费曼**: 教 AI 做"图标变形动画"——汉堡菜单变叉号、播放变暂停。

#### `raphaelsalaja/to-spring-or-not-to-spring` — To Spring or Not to Spring
- **作者**: Raphael Salaja
- **描述**: 审计动画时机选择，判断弹簧动画和缓动曲线哪种产生更好的动效。
- **费曼**: 教 AI 选"弹簧还是缓动"——不是所有动画都该用 spring。

#### `raphaelsalaja/pseudo-elements` — Pseudo Elements
- **作者**: Raphael Salaja
- **描述**: 审计 CSS 伪元素和 View Transitions 的使用，用于 hover 效果、装饰层和过渡。
- **费曼**: 教 AI 用 `::before` `::after` 做装饰——不用额外 HTML 就能加视觉层。

#### `jakubantalik/transitions-dev` — Transitions Dev
- **作者**: Jakub Antalik
- **描述**: 生产就绪的 CSS 过渡模式，为卡片、模态框、下拉菜单、面板和页面过渡提供可直接使用的代码片段。
- **费曼**: 给 AI 一套"过渡代码模板库"——卡片翻转、模态弹出、下拉展开，直接抄。

#### `ibelick/fixing-motion-performance` — (见 Craft 分类)

#### `cloudai-x/threejs-animation` — Three.js Animation
- **作者**: CloudAI-X
- **描述**: Three.js 动画指导——关键帧、骨骼动画、变形目标和动画混合。
- **费曼**: 教 AI 在 Three.js 里做 3D 动画——骨骼绑定、关键帧、动作混合。

---

### 4. Systems 设计系统

#### `shadcn-ui/shadcn` — shadcn/ui
- **作者**: shadcn-ui（官方）
- **描述**: 项目感知的 shadcn/ui 工作流——搜索、添加、组合和修复组件，使用正确的模式。
- **费曼**: 教 AI 正确使用 shadcn/ui——不是复制粘贴，是理解组件 API 后正确组合。

#### `0xdesign/design-lab` — Design Lab
- **作者**: 0xDesign
- **描述**: 交互式设计探索工作流——进行访谈、生成变体、通过反馈精炼 UI 设计。
- **费曼**: 让 AI 像设计师一样"探索"——先问需求、再出多个方案、根据反馈迭代。

#### `addyosmani/frontend-ui-engineering` — Frontend UI Engineering
- **作者**: Addy Osmani
- **描述**: 前端 UI 工程指导——组件架构、响应式设计、无障碍和可维护实现模式。
- **费曼**: Google Chrome 工程经理 Addy Osmani 的前端工程方法论——怎么组织组件、怎么做响应式。

#### `addyosmani/web-quality-audit` — Web Quality Audit
- **作者**: Addy Osmani
- **描述**: Web 质量审计技能——Lighthouse 风格的分析，覆盖性能、无障碍、最佳实践和 SEO 信号。
- **费曼**: 让 AI 跑一次"Lighthouse 审计"——性能、无障碍、SEO 一次查完。

#### `pbakaus/colorize` — Colorize
- **作者**: pbakaus
- **描述**: 为感觉单调、单色或视觉平淡的界面引入战略色彩系统。
- **费曼**: 界面太灰了？这个技能让 AI 建立一套配色方案。

#### `pbakaus/distill` — Distill
- **作者**: pbakaus
- **描述**: 通过去除非必要复杂性、恢复清晰视觉焦点来简化嘈杂的界面。
- **费曼**: 界面太乱？这个技能让 AI 做"减法"——砍掉多余元素，留核心。

#### `jakubkrehel/oklch-skill` — OKLCH Skill
- **作者**: Jakub Krehel
- **描述**: 实用的 OKLCH 色彩工作流技能，用于构建一致的、无障碍的、可调的现代 UI 色彩系统。
- **费曼**: 教 AI 用 OKLCH 色彩空间——比 HSL 更感知均匀，调色更科学。

#### `dammyjay93/interface-design` — (见 Craft 分类)

---

### 5. Visual 视觉

#### `antfu/web-design-guidelines` — Web Design Guidelines
- **作者**: Anthony Fu
- **描述**: 审查 UI 代码是否符合 Web 界面指南，包括无障碍和 UX 最佳实践。
- **费曼**: Anthony Fu 的 Web 设计规范——教 AI 写符合标准的界面。

#### `antfu/unocss` — UnoCSS
- **作者**: Anthony Fu
- **描述**: UnoCSS 原子 CSS 引擎指导——规则、快捷方式和预设（Wind、Icons、Attributify）。
- **费曼**: 教 AI 用 UnoCSS——比 Tailwind 更灵活的原子 CSS 引擎。

#### `antfu/slidev` — Slidev
- **作者**: Anthony Fu
- **描述**: 用 Slidev 创建开发者幻灯片——Markdown、Vue 组件、代码高亮和动画。
- **费曼**: 教 AI 用 Markdown 做幻灯片——代码高亮、Vue 组件、动画过渡。

#### `vercel-labs/web-design-guidelines` — Web Design Guidelines (Vercel)
- **作者**: Vercel Labs
- **描述**: 审查 UI 代码是否符合 Web Interface Guidelines——无障碍和 UX 对标 Vercel 最佳实践。
- **费曼**: Vercel 版本的 Web 设计规范——和 Vercel 的产品保持一致。

#### `raphaelsalaja/generating-sounds-with-ai` — Generating Sounds with AI
- **作者**: Raphael Salaja
- **描述**: 审计 Web Audio API 代码的程序化声音合成质量、UX 决策和参数最佳实践。
- **费曼**: 教 AI 用 Web Audio API 生成音效——按钮点击声、通知提示音。

#### `raphaelsalaja/sounds-on-the-web` — Sounds on the Web
- **作者**: Raphael Salaja
- **描述**: 审计界面声音反馈的 UX 质量、无障碍和实用实现模式。
- **费曼**: 教 AI 给界面加声音——但要确保不会打扰用户、不会影响无障碍。

#### `zarazhangrui/frontend-slides` — Frontend Slides
- **作者**: Zarazhangrui
- **描述**: 从零创建动画丰富的 HTML 演示文稿，或将 PPT/PPTX 文件转换为精致的 Web 幻灯片。
- **费曼**: 让 AI 把 PPT 变成 Web 幻灯片——带动画的那种。

---

### 6. Interaction 交互

#### `wshobson/interaction-design` — Interaction Design
- **作者**: wshobson
- **描述**: 设计和实现微交互、动效设计、过渡和用户反馈模式，打造愉悦的用户体验。
- **费曼**: AI 的"交互设计师"——教 AI 怎么让按钮有反馈、怎么让表单有引导。

#### `wshobson/wcag-audit-patterns` — WCAG Audit Patterns
- **作者**: wshobson
- **描述**: 进行 WCAG 2.2 无障碍审计——自动化测试、手动验证和修复指导。
- **费曼**: 让 AI 按 WCAG 2.2 标准逐条检查——颜色对比度、键盘操作、屏幕阅读器兼容。

#### `pbakaus/adapt` — Adapt
- **作者**: pbakaus
- **描述**: 跨断点、设备上下文和平台约束适配设计，保持响应式交互质量。
- **费曼**: 教 AI 做"响应式适配"——不只是缩小，是每个尺寸都有最佳交互。

#### `microsoft/playwright-cli` — Playwright CLI
- **作者**: Microsoft（官方）
- **描述**: 官方 Playwright CLI 技能——浏览器自动化、测试生成、追踪和会话驱动的端到端测试工作流。
- **费曼**: 教 AI 用 Playwright 做自动化测试——打开浏览器、点击按钮、截图验证。

#### `vercel-labs/agent-browser` — Agent Browser
- **作者**: Vercel Labs
- **描述**: AI Agent 的浏览器自动化 CLI——导航、表单操作、内容提取、截图、QA 和应用测试。
- **费曼**: 让 AI 自己开浏览器——打开网页、填表单、截图、检查页面内容。

---

### 7. Performance 性能

#### `pbakaus/optimize` — Optimize
- **作者**: pbakaus
- **描述**: 诊断和改进界面性能——渲染、动效流畅度、资源和加载速度。
- **费曼**: AI 的"性能优化器"——检查渲染卡顿、资源过大、加载太慢。

#### `millionco/react-doctor` — React Doctor
- **作者**: Million Co
- **描述**: 运行 React Doctor 检测安全、性能、正确性和架构的回归，基于评分的质量检查。
- **费曼**: 给 React 项目做"全科体检"——安全漏洞、性能瓶颈、架构问题一次查清。

#### `callstackincubator/react-native-best-practices` — React Native Best Practices
- **作者**: Callstack
- **描述**: React Native 性能优化指南——FPS、TTI、包大小、内存泄漏、重渲染和动画。
- **费曼**: 教 AI 优化 React Native 应用——帧率、启动速度、内存管理。

#### `antfu/pnpm` — pnpm
- **作者**: Anthony Fu
- **描述**: pnpm 包管理器指导——严格依赖解析、工作空间、目录、补丁和覆盖。
- **费曼**: 教 AI 用 pnpm 管理依赖——比 npm 更严格、更快、更省空间。

#### `antfu/tsdown` — tsdown
- **作者**: Anthony Fu
- **描述**: 用 tsdown 打包 TypeScript 和 JavaScript 库——包括声明文件和多格式构建。
- **费曼**: 教 AI 用 tsdown 打包库——生成 CJS、ESM、声明文件一步到位。

#### `antfu/turborepo` — Turborepo
- **作者**: Anthony Fu
- **描述**: Turborepo 单体仓库构建系统指导——流水线、缓存、过滤、CI 和包边界。
- **费曼**: 教 AI 用 Turborepo 管理 monorepo——构建缓存、任务编排、包隔离。

#### `millionco/budge` — Budge
- **作者**: Million Co
- **描述**: 在 Next.js App Router 项目中做单属性 CSS 或 Tailwind 视觉调整。提供浮动控制面板进行实时调参后持久化。
- **费曼**: 让 AI 做"可视化微调"——改一个 CSS 属性时实时预览，满意了再保存。

---

### 8. Accessibility 无障碍

#### `accesslint/audit-and-fix` — Audit and Fix
- **作者**: AccessLint
- **描述**: 无障碍审计和修复工作流——检测、优先级排序和 WCAG 问题的实用修复。
- **费曼**: AI 的"无障碍审计+修复一条龙"——发现问题、排优先级、直接修。

#### `accesslint/contrast-checker` — Contrast Checker
- **作者**: AccessLint
- **描述**: AccessLint 市场技能集的 contrast-checker 兼容性列表。
- **费曼**: 检查颜色对比度是否达标——WCAG 要求至少 4.5:1。

#### `accesslint/link-purpose` — Link Purpose
- **作者**: AccessLint
- **描述**: AccessLint 市场技能集的 link-purpose 兼容性列表。
- **费曼**: 检查链接文字是否有意义——"点击这里"是不行的，要写清楚链接去哪。

#### `accesslint/refactor` — Refactor
- **作者**: AccessLint
- **描述**: AccessLint 市场技能集的 refactor 兼容性列表。
- **费曼**: 重构代码以提升无障碍性——把 div 改成 button，给图片加 alt。

#### `accesslint/use-of-color` — Use of Color
- **作者**: AccessLint
- **描述**: AccessLint 市场技能集的 use-of-color 兼容性列表。
- **费曼**: 检查是否仅靠颜色传达信息——色盲用户看不到红绿区别。

---

### 9. Frameworks 框架专属

#### Vue 生态（antfu 系列 + vuejs-ai 系列）

| Skill | 描述 |
|-------|------|
| `antfu/vue` | Vue 3 Composition API 和响应式指导——SFC、script setup 宏和内置组件 |
| `antfu/vue-best-practices` | Vue.js 最佳实践——强调 Composition API + script setup + TypeScript |
| `antfu/vue-router-best-practices` | Vue Router 4 模式——导航守卫、路由参数和路由生命周期 |
| `antfu/vue-testing-best-practices` | Vue 测试指导——Vitest、Vue Test Utils、组件测试、Mock 和 Playwright E2E |
| `antfu/vueuse-functions` | 应用 VueUse composable 构建简洁、可维护的 Vue/Nuxt 功能 |
| `antfu/nuxt` | Nuxt 全栈 Vue 框架指导——SSR、自动导入、文件路由和服务器路由 |
| `antfu/pinia` | Pinia 状态管理最佳实践——类型安全的 Vue store、getter 和 action |
| `vuejs-ai/vue-best-practices` | Vue 开发核心最佳实践——组件架构、响应式和可维护代码 |
| `vuejs-ai/create-adaptable-composable` | 创建库级 Vue composable——支持普通值、ref 和 getter |
| `vuejs-ai/vue-debug-guides` | Vue 调试工作流——诊断和修复响应式、渲染和状态问题 |
| `vuejs-ai/vue-jsx-best-practices` | Vue JSX 编写指导——类型安全、可读的 JSX 组件 |
| `vuejs-ai/vue-options-api-best-practices` | Options API 最佳实践——结构化和扩展 Vue 应用 |
| `vuejs-ai/vue-pinia-best-practices` | Pinia store 模式——干净、可扩展的状态管理 |
| `vuejs-ai/vue-router-best-practices` | Vue Router 路由架构和导航模式 |
| `vuejs-ai/vue-testing-best-practices` | Vue 测试策略——组件测试、集成测试和可靠性模式 |

#### Next.js / React 生态（Vercel 系列）

| Skill | 描述 |
|-------|------|
| `vercel-labs/next-best-practices` | Next.js 最佳实践——文件约定、RSC 边界、数据模式、异步 API、元数据、错误处理 |
| `vercel-labs/next-cache-components` | Next.js 16 Cache Components——PPR、use cache 指令、cacheLife、cacheTag、updateTag |
| `vercel-labs/next-upgrade` | 升级 Next.js 到最新版本——官方迁移指南和 codemod |
| `vercel-labs/react-best-practices` | Vercel React 最佳实践——渲染性能、包效率和可扩展组件架构 |

#### 其他框架

| Skill | 描述 |
|-------|------|
| `sveltejs/svelte-code-writer` | 官方 Svelte 代码编写技能——现代 Svelte 模式、组件组合和生产就绪实现 |
| `remix-run/react-router-framework-mode` | React Router 框架模式——loader、action、中间件、路由模块和全栈渲染 |
| `remotion-dev/remotion-best-practices` | Remotion 领域知识库——用 React 构建视频 |
| `dimillian/swiftui-ui-patterns` | SwiftUI 最佳实践和示例驱动指导——Tab 架构和屏幕组合 |

#### 工具链（antfu 系列）

| Skill | 描述 |
|-------|------|
| `antfu/vite` | Vite 配置和插件指导——SSR 和 Vite 8 Rolldown 迁移模式 |
| `antfu/vitepress` | VitePress 文档站指导——配置、主题和 Markdown + Vue 内容 |
| `antfu/vitest` | Vitest 测试最佳实践——单元测试、Mock、覆盖率、fixture 和测试过滤 |
| `antfu/antfu` | Anthony Fu 的 JavaScript/TypeScript 项目偏好工具链和约定 |

---

### 10. 3D / Three.js

`cloudai-x` 提供了完整的 Three.js 技能包（10 个）：

| Skill | 描述 |
|-------|------|
| `threejs-fundamentals` | 场景搭建——相机、渲染器配置、对象层级和变换 |
| `threejs-animation` | 动画——关键帧、骨骼动画、变形目标和动画混合 |
| `threejs-geometry` | 几何体——内置形状、BufferGeometry、自定义网格和实例化 |
| `threejs-interaction` | 交互——射线检测、控制器、指针输入和对象选择 |
| `threejs-lighting` | 光照——灯光类型、阴影、环境光和性能调优 |
| `threejs-loaders` | 资源加载——GLTF、纹理、HDR、异步加载和进度处理 |
| `threejs-materials` | 材质——PBR、经典材质、ShaderMaterial 和材质优化 |
| `threejs-postprocessing` | 后处理——EffectComposer、bloom、景深和屏幕空间效果 |
| `threejs-shaders` | 着色器——GLSL、ShaderMaterial、uniform 和自定义顶点/片元效果 |
| `threejs-textures` | 纹理——贴图类型、UV 映射、环境贴图和纹理配置 |

---

## 三、作者索引

| 作者 | 技能数 | 代表作 |
|------|--------|--------|
| **pbakaus** | 16 | impeccable, animate, polish, layout, typeset |
| **antfu** (Anthony Fu) | 16 | vue, nuxt, vite, vitest, unocss |
| **leonxlnx** | 8 | brutalist-skill, minimalist-skill, taste-skill |
| **cloudai-x** | 10 | threejs-* 系列（10 个） |
| **vuejs-ai** | 8 | vue-best-practices, vue-debug-guides |
| **raphaelsalaja** | 7 | 12-principles-of-animation, morphing-icons |
| **vercel-labs** | 6 | next-best-practices, react-best-practices |
| **accesslint** | 5 | audit-and-fix, contrast-checker |
| **ibelick** | 4 | baseline-ui, fixing-accessibility |
| **anthropics** | 2 | frontend-design, canvas-design |
| **addyosmani** | 2 | frontend-ui-engineering, web-quality-audit |
| **wshobson** | 2 | wcag-audit-patterns, interaction-design |
| **jakubkrehel** | 2 | make-interfaces-feel-better, oklch-skill |
| **millionco** | 2 | react-doctor, budge |
| **emilkowalski** | 1 | emil-design-eng |
| **shadcn-ui** | 1 | shadcn |
| **0xdesign** | 1 | design-lab |
| **nextlevelbuilder** | 1 | ui-ux-pro-max |
| **bencium** | 1 | bencium-innovative-ux-designer |
| **dammyjay93** | 1 | interface-design |
| **zarazhangrui** | 1 | frontend-slides |
| **dimillian** | 1 | swiftui-ui-patterns |
| **zeke** | 1 | swiss-design |
| **rams** | 1 | rams |
| **jakubantalik** | 1 | transitions-dev |
| **microsoft** | 1 | playwright-cli |
| **sveltejs** | 1 | svelte-code-writer |
| **remix-run** | 1 | react-router-framework-mode |
| **remotion-dev** | 1 | remotion-best-practices |
| **callstackincubator** | 1 | react-native-best-practices |

---

## 总计: **~105 个 Skill**，覆盖 30+ 位作者，8 大主题分类

---

*文档生成于 2026-05-25，数据来源: ui-skills.com*
