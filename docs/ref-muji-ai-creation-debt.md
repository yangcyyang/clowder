---
feature_ids: []
topics: [vision, orchestration, strategy, reference]
doc_kind: reference
created: 2026-06-28
source: "https://mp.weixin.qq.com/s/3_4EPQoqmW6TRDhd1KxMQA"
source_author: "Muji（Seede AI）"
---

# 参考：Muji《AI 创业一年复盘》→ Clowder 方向映射

> 一篇外部复盘文章对 Clowder 的双重价值：**战略上验证方向，战术上提供功能清单。**
> 原文 2w 字，作者是 Seede AI 的 co-founder，负责产品/研发/GTM。
> 本地剪藏：`OrbitOS-CN/Clippings/AI 创业一年复盘：第一次 Build 的成就感，是创业最大的幻觉 1.md`

## 一、核心论点：为什么这篇文章对 Clowder 重要

作者的暴论：**AI 让"做出来"变快了，但维护、review、权限、数据、文档、协作边界、验收这些债务一个没少，反而来得更快。**

由此推出的判断：
- 真正的机会不在 build 端（Cursor 已经吃掉了），而在 **"keep it running" 的 AI-native infra**：承接 building 之后的维护、治理、协作、交付。
- 旧 SaaS 会被重写，新 SaaS 会围绕 AI-native 的生产关系重新诞生。
- 程序员不失业，但要从"记者"变"编辑"：审阅、筛选、整合 AI 写的代码，对系统质量负责。
- AI native 组织最深的变化不是代码生成，而是协作模式——人人都是 builder 时，组织结构会被重塑。

**Clowder 就是这个东西。** 它不是又一个 coding 工具，而是"人人都能 build 之后，谁来兜底、谁来协作、谁来守门"的基础设施。这篇文章给了我们一个清晰的对外叙事锚点，且与 `docs/VISION.md`（"把想法做成能运行的世界"、"养的是团队不是工具"）方向一致。

## 二、文章痛点 → Clowder 已有设计

| 文章痛点 | Clowder 对应能力 |
|---|---|
| 谁来 review AI 写的屎山？守门员缺失 | cross-cat review、quality-gate、merge-gate、no-self-review 硬规则 |
| spec 必要但不充分，要把"需求/实现/影响范围/验收标准"串起来 | project-init 脚手架（brief.md / progress.md / handoff-log.md） |
| 多 builder 协作很快变混乱 | governance bootstrap + shared-rules 家规注入 |
| 黑盒等待无聊，要"活人感"、过程可见 | agent 状态指示、thread、rich block 实时输出 |
| 文档跟不上代码变化 | handoff-log 自动追加、context-index |
| 变更上下文要完整（为什么做/影响哪些模块/怎么回滚） | A2A 五元组 handoff（What/Why/Tradeoff/Open Questions/Next Action） |

## 三、文章里值得抄的功能点（Clowder 尚未做或可强化）

### 1. planner / execute 两阶段拆分 + 四种执行模式
作者把 agent 拆成：
- **planner**：理解意图、判断任务类型、规划执行路径（输出结构化 plan + 连续 toolSteps）。
- **execute**：按复杂度分四种模式执行——
  - `fast-exec`：任务确定、工具链路明确 → 直接 tool call，不进 agent loop（省时省 token）。
  - `agent-loop`：单任务循环执行直到达成。
  - `coordinator`：多指令混合意图 → 拆成 content/image/layout 等子任务并行，再整合。
  - `ask-user`：干活前先对齐一次（用户能容忍对齐，不能容忍假装理解后改错）。

→ 对 Clowder 的 QueueProcessor / A2A 调度有直接参考价值。`fast-exec` 正好呼应 Codex reasoning effort / fast_mode 提速方向。

### 2. ask-user 模式产品化
把"AI 干活前先确认一次"做成显式协作协议，而不是靠运气。

### 3. skill 编组、批量执行
把高频稳定的 agent 行为沉淀成工程化 skill，不要每步都重跑 loop。呼应 Skill Router 方向。

### 4. 沙箱 / 权限给非技术同学
让非研发能在"可预览、可 diff、可回滚、可审计"的隔离空间里动手，影响生产前必须过权限校验、风险扫描、自动测试、人工 review。Clowder 长期可做的差异化。

### 5. spec → 实现 → 对齐 的闭环（喵神思路）
让 AI 写代码前先定义 spec，写完后再用文档形式把实现和 spec 对齐，降低人维护成本。

## 四、结论

- **战略层**：文章验证了 Clowder "AI-native 协作 infra"的方向是对的，可作为对外叙事的理论支撑。
- **战术层**：planner/execute 分层、四种执行模式、ask-user 协议、skill 编组、非技术沙箱——这几个是可落地的功能候选。
- **建议**：下次做 orchestration 优化（QueueProcessor / A2A / Skill Router）时回头看本文的 planner/execute 模型。
- **落地**：改造 1（fast-exec 快车道机制）的执行方案见 `docs/exec-fast-lane-mechanism.md`。

## 五、当前推进顺序

先推进 **改造 1：execute 分层 / fast-exec 快车道**，原因是它同时满足三点：

1. Clowder 已经有 QueueProcessor、task events、usage、artifact 这些基础零件。
2. 本地已经有 `project-init` 这种确定性脚本，可作为第一条低风险快车道。
3. 它能直接改善体验：确定性任务更快、更省 token，也减少 agent 自由发挥带来的格式漂移。

后续顺序：

```text
改造 1：fast-exec 快车道
  → 改造 2：ask-user 模式产品化
  → 改造 3：变更上下文串联
  → 改造 4：非技术同学安全沙箱
```

不要并行铺太多。先打通一条快车道，再复制方法。
