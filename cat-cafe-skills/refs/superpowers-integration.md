# Superpowers Integration — 选择性集成说明

**决策日期**：2026-06-09  
**决策者**：cy（CVO）  
**执行者**：Claude/宪宪 (@opus-45)

---

## 📌 核心决策

**采用方案A：选择性集成 + 增强现有 Clowder Skills**

从 obra/superpowers 借鉴核心理念，增强 Clowder 现有技能体系，**不全盘替换**。

---

## 🎯 集成内容

### ✅ 已集成

| 来源 | 集成到 Clowder | 说明 |
|------|--------------|------|
| **Superpowers brainstorming 哲学** | `collaborative-thinking` Mode A | 新增"强制需求澄清"检查点 |
| **Superpowers 子代理并行** | 新建 `subagent-dispatch` skill | 适配 Clowder 的 @mention 机制 |

### ❌ 未集成（及理由）

| Superpowers Feature | 为什么不引入 | Clowder 替代方案 |
|---------------------|-------------|----------------|
| `using-superpowers` 元技能 | 与 `manifest.yaml` 触发机制冲突 | 保留 manifest 路由 |
| 完整的 14个 skills | 与 Clowder 37个 skills 重复 | 保留 Clowder 体系 |
| 子代理自动分派 | Clowder 是多猫协作，不是单猫+子代理 | 用 @mention 手动路由 |

---

## 📊 对比表：Superpowers vs Clowder

| 维度 | Superpowers | Clowder（集成后） |
|------|-------------|-----------------|
| **核心哲学** | 先澄清需求，不直接写代码 | ✅ 已集成到 collaborative-thinking |
| **TDD** | Red-Green-Refactor | ✅ 已有 `tdd` skill |
| **Code Review** | requesting / receiving | ✅ 已有 `request-review` / `receive-review` |
| **并行执行** | 子代理自动分派 | ✅ 新建 `subagent-dispatch` + @mention |
| **Git Worktree** | using-git-worktrees | ✅ 已有 `worktree` skill |
| **多Agent协作** | ❌ 单猫+子代理 | ✅ 多猫平等协作（Claude/GPT/Gemini） |
| **企业集成** | ❌ 无 | ✅ 飞书/企微/PPT/视频工具链 |
| **设计支持** | ❌ 无 | ✅ Pencil/PPT/视频制作 |

---

## 🔧 使用指南

### 何时触发 Superpowers 模式？

#### 1. Brainstorming（强制需求澄清）

**自动触发场景**：
用户说：
- "做个XX功能"
- "帮我实现XX"
- "加个XX"

**行为**：
- ❌ 不直接写代码
- ✅ 先问清楚：谁用？什么场景？边界？
- ✅ 写 spec 后再实现

**例外**：
- 用户已有详细 spec
- Trivial 改动（≤5行）
- 用户明确说"不用问，直接做"

#### 2. Subagent Dispatch（子任务并行）

**触发场景**：
- 有多个独立子任务
- 任务间无数据依赖
- 可以并行执行

**示例**：
```
用户："并行实现3个独立API"

→ 触发 subagent-dispatch
→ 分派给 @codex / @opencode / @Pi
→ 汇总结果 → 验证整合
```

**不触发**：
- 任务有依赖关系（用串行）
- 需要协作讨论（用 @mention + collaborative-thinking）
- 单个任务（直接执行）

---

## 📋 决策理由（Why）

### 为什么不全盘替换？

1. ✅ **Clowder 已有完整流程** —— feat-lifecycle → tdd → quality-gate → review → merge-gate
2. ✅ **多猫协作是差异化能力** —— Claude/GPT/Gemini 平等协作，不是单猫+子代理
3. ✅ **企业工具链是竞争力** —— 飞书、企微、PPT、视频制作 Superpowers 没有
4. ⚠️ **触发机制冲突** —— Superpowers 的 `using-superpowers` 与 Clowder 的 manifest.yaml 冲突

### 为什么借鉴这两个？

1. ✅ **Brainstorming 哲学是好习惯** —— "不直接写代码"减少返工，值得默认启用
2. ✅ **子代理并行是好理念** —— 补充 Clowder 的 @mention 机制，适合独立任务

---

## 🎓 学习价值

**从 Superpowers 学到的**：
- **需求澄清的重要性** —— "先问清楚要什么"比"快速写代码"更高效
- **并行执行的边界** —— 独立任务可并行，有依赖必须串行
- **方法论 > 工具集** —— Superpowers 的价值在哲学，不在具体 skill 数量

---

## 🔗 参考资源

- **Superpowers 官方仓库**：[obra/superpowers](https://github.com/obra/superpowers)
- **Clowder Skills 列表**：`cat-cafe-skills/BOOTSTRAP.md`
- **Superpowers 集成 PR**：*(待补充)*

---

## ✅ 验收标准

集成完成的标志：

1. ✅ `collaborative-thinking/SKILL.md` 包含 Superpowers 模式说明
2. ✅ `subagent-dispatch/SKILL.md` 创建完成
3. ✅ `manifest.yaml` 注册 subagent-dispatch
4. ✅ `BOOTSTRAP.md` 更新 skill 数量和列表
5. ✅ `refs/superpowers-integration.md`（本文档）存在
6. ✅ 测试验证通过

---

**结论**：Superpowers 是优秀的参考标准，Clowder 从中学习并适配到多猫协作场景，保持差异化竞争力。
