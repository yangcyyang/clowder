---
name: subagent-dispatch
description: >
  子任务并行分派与执行（借鉴 Superpowers）。
  Use when: 有多个独立子任务可以并行执行，且任务间无依赖。
  Not for: 需要跨猫协作决策、有复杂依赖关系的任务。
  Output: 子任务分派清单 + 并行执行结果汇总。
triggers:
  - "并行执行"
  - "子任务分派"
  - "独立任务"
  - "同时处理"
  - "并行处理"
source: "superpowers@obra (adapted for Clowder)"
---

# Subagent Dispatch（子代理分派）

**借鉴自 Superpowers**，适配 Clowder 的多猫协作机制。

## 核心理念

当有多个**独立**子任务时，使用子代理并行执行，而非串行等待，提升效率。

---

## 何时用 vs 何时不用

| 场景 | 用 subagent-dispatch | 用 @mention |
|------|---------------------|-------------|
| 3个独立API实现 | ✅ | ❌ |
| 并行写测试+文档 | ✅ | ❌ |
| 多个独立文件修改 | ✅ | ❌ |
| **需要跨猫Review** | ❌ | ✅ |
| **架构方向讨论** | ❌ | ✅ |
| **复杂协作决策** | ❌ | ✅ |
| **任务有依赖关系** | ❌ | ❌（串行执行） |

**判断标准**：
- ✅ 独立性：子任务间无数据依赖
- ✅ 明确性：每个子任务有清晰的 spec
- ✅ 可并行：子任务可以同时执行
- ❌ 需协商：涉及决策、审美、方向性判断 → 用 @mention

---

## 工作流

### 1. 识别独立性

确认子任务间**无数据依赖**：

```
✅ 可并行：
- 实现 API A 和 API B（两个独立端点）
- 写测试 + 写文档（不依赖彼此）
- 修改文件 X 和文件 Y（无引用关系）

❌ 不可并行：
- 先写 schema → 再写 migration（有依赖）
- 先实现 API → 再写测试（测试依赖实现）
- 改 interface → 改实现（interface 定义影响实现）
```

### 2. 分派任务

为每个子任务写清晰的 spec：

```markdown
## 子任务清单

### 子任务1：实现 GET /api/users
- 输入：无
- 输出：用户列表JSON
- 文件：src/routes/users.ts
- 测试：test/users.test.ts

### 子任务2：实现 GET /api/posts
- 输入：无
- 输出：帖子列表JSON
- 文件：src/routes/posts.ts
- 测试：test/posts.test.ts

### 子任务3：更新文档
- 文件：docs/API.md
- 内容：添加两个新端点的文档
```

### 3. 并行执行

**在 Clowder 中的实现方式**：

由于 Clowder 是多猫协作平台，"子代理并行"可以通过以下方式实现：

**方式A：分派给不同猫**（推荐）
```
@codex
子任务1：实现 GET /api/users
[spec...]

@opencode
子任务2：实现 GET /api/posts
[spec...]

@Pi
子任务3：更新文档
[spec...]
```

**方式B：单猫串行执行**（fallback）
如果没有其他猫可用，单猫也可以快速串行执行独立子任务。

### 4. 汇总结果

收集各子任务产出：
- 各文件改动
- 测试结果
- 文档更新

### 5. 验证整合

确保子任务结果可正确组合：
- 运行全量测试
- 检查接口一致性
- 验证文档完整性

---

## 反模式（Common Mistakes）

| Mistake | Why Bad | Fix |
|---------|---------|-----|
| 子任务有顺序依赖还用并行 | 后续任务缺少前置输入 | 识别依赖链，改为串行 |
| 复杂协作用 subagent | 缺少讨论和共识 | 用 @mention + collaborative-thinking |
| 单个任务也用 subagent | 多余开销 | 直接执行 |
| 没有清晰 spec 就分派 | 执行方不知道做什么 | 先写 spec 再分派 |
| 分派后不汇总验证 | 子任务各自正确，组合失败 | 最后必须整合验证 |

---

## 与 @mention 的区别

| 维度 | subagent-dispatch | @mention |
|------|-------------------|----------|
| **适用场景** | 独立并行子任务 | 需要协作、讨论、决策 |
| **交互模式** | 一次性分派 → 执行 → 汇总 | 多轮对话、讨论、Review |
| **决策复杂度** | 低（spec 明确） | 高（需要协商共识） |
| **典型案例** | 并行实现3个独立API | 架构设计、代码Review、方向讨论 |

---

## Quick Reference

| 你要做的事 | 用什么 |
|-----------|--------|
| 3个独立API并行实现 | subagent-dispatch |
| 需要跨猫Review代码 | @mention |
| 讨论架构方向 | @mention + collaborative-thinking |
| 并行写测试+文档 | subagent-dispatch |
| 复杂功能设计 | collaborative-thinking Mode A |

---

## 下一步

- 子任务全部完成 → `quality-gate` 自检
- 需要 Review → `request-review`
- 准备合并 → `merge-gate`

---

**来源**：借鉴 Superpowers (obra) 的子代理并行理念，适配 Clowder 的 @mention 多猫协作机制。
