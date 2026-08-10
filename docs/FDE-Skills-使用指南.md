# FDE Skills 使用指南

> 《前线部署工程师》（范冰，开源版 v1.0.11）蒸馏产物。15 个可执行 skill，覆盖企业 AI 交付全生命周期：找对问题 → 赢得客户 → 激活部署 → 守住续约 → 扩大收入 → 规模化复制。

## 这套 skills 是什么

**来源**：范冰《前线部署工程师》全书（8 章 + 后记 + 附录，112 个真实案例），经 book2skill 流程蒸馏。

**核心命题**：MIT 2025 报告——企业 AI 项目 95% 无财务回报；FDE（前线部署工程师）把工程师送到客户现场，填补「造软件的地方」和「价值产生的地方」之间的鸿沟。

**结构**：15 个 skill 各含 RIA++ 六段（原文引用/方法论骨架/书中案例/触发场景/可执行步骤/边界），每个带 `test-prompts.json` 压力测试（含正例/诱饵/边界用例）。

**安装位置**：`cat-cafe-skills/<skill-name>/`，已注册于 `manifest.yaml` 与 `BOOTSTRAP.md`。

## 15 个 skill 一览

| # | Skill | 一句话 | 触发场景举例 |
|---|-------|--------|--------------|
| 1 | `psf-screening` | 问题三关检验，写第一行代码前判定值不值得做 | "这个问题值不值得做？" |
| 2 | `shadow-work` | 现场观察真实工作流，发现文档里没有的痛点 | "找不到真实痛点在哪" |
| 3 | `mvd-validation` | 最小可行部署：真实数据/缩小切口/定死截止 | "POC 怎么做才不烂尾？" |
| 4 | `poc-rejection` | 拒绝机制与免费验证治理，防概念验证坟墓 | "免费验证要不要接？" |
| 5 | `site-due-diligence` | 进场尽调五份地图（数据/流程/组织/系统/政治） | "新客户进场前准备什么？" |
| 6 | `lighthouse-customer` | 灯塔客户策略：双维打分/需求蝗虫/生态捆绑 | "两个客户先做哪个？" |
| 7 | `proposal-pyramid` | 倒金字塔提案：业务结果→验证路径→交付→风险 | "方案书怎么写才能赢？" |
| 8 | `deployment-activation` | 激活六件武器：热修复/评估/降门槛/集成/变革/自动化 | "系统上线了没人用" |
| 9 | `delivery-automation` | 交付自动化四类资产 + 场景打法手册 | "每次新客户都从零搭环境" |
| 10 | `retention-defense` | 续约守卫五道防线 + 健康度体系 | "客户使用率下滑了" |
| 11 | `revenue-expansion` | 收入扩大四引擎：成果计价/存量深耕/变惩为奖 | "部署成功了怎么多赚点？" |
| 12 | `scale-copy` | 规模化复制：三级杠杆/失败复盘/产品化四问 | "定制项目怎么变产品？" |
| 13 | `trust-marketing` | 信任营销：战壕视角内容/借势/三圈层/裂变 | "客户说没听说过我们" |
| 14 | `fde-ethics` | 职业道德六底线（数据主权/诚实报告/不制造依赖/说不） | "客户要求感觉不太对" |
| 15 | `fde-metrics` | 四层指标体系 + 第一天采基线 + 健康度 | "这个项目该盯哪些指标？" |

## 按场景路由（快速查找）

### 我只有一个模糊需求
1. 想了解客户真实痛点 → **shadow-work**（看比问更真）
2. 判断痛点值不值得做 → **psf-screening**（三关检验）
3. 设计验证期 → **mvd-validation** + **poc-rejection**

### 我在卖/签单阶段
- 排客户优先级 → **lighthouse-customer**
- 写方案书 → **proposal-pyramid**
- 进场前摸底 → **site-due-diligence**
- 让客户主动找上门 → **trust-marketing**

### 我在交付/运营阶段
- 上线没人用 → **deployment-activation**
- 交付重复劳动太多 → **delivery-automation**
- 客户要流失 → **retention-defense**
- 想扩大合同 → **revenue-expansion**
- 想复制团队能力 → **scale-copy**

### 我在做决策/自检
- 该不该做某件事（灰色地带） → **fde-ethics**
- 项目/公司健康度体检 → **fde-metrics**

## 完整交付旅程（推荐路线）

```
shadow-work → psf-screening → mvd-validation → deployment-activation
    → retention-defense → revenue-expansion → scale-copy
```

对应书中章节：第 2 章找对问题（1-4）→ 第 3 章赢得客户（5-7）→ 第 4 章激活部署（8-9）→ 第 5 章守住续约（10）→ 第 6 章扩大收入（11）→ 第 7 章规模化复制（12-13）→ 后记与附录（14-15）。

## 关键数据锚点（用于说服与判断）

- NRR 及格 100%、优秀 120%（Palantir 139%）
- 交付毛利率：纯人力 20-40%，平台化后向 60%+（Palantir 82%）
- 概念验证转化率：训练营 5-10% → 75%
- TTV：MVD 以周计（2-6 周），完整部署以月计（1-4 个月）
- 激活率分母 = 目标用户群（不是账号数）

## 如何测试

每个 skill 的 `test-prompts.json` 遵循 darwin-skill 格式：

```json
{
  "skill": "mvd-validation",
  "test_cases": [
    { "id": "should-trigger-01", "type": "should_trigger", "prompt": "...", "expected_behavior": "..." },
    { "id": "should-not-trigger-01", "type": "should_not_trigger", "prompt": "...", "expected_behavior": "..." },
    { "id": "edge-01", "type": "edge_case", "prompt": "...", "expected_behavior": "..." }
  ],
  "minimum_pass_rate": 0.8
}
```

- `should_trigger`（45 条）：该触发时确认触发正确
- `should_not_trigger`（30 条）：诱饵题，确认不误触发
- `edge_case`（15 条）：边界题，确认有灰度处理

## 维护说明

- **来源书**：本机 FDE books 根目录下的 `fde-skill/`（完整产物 + INDEX.md + 提取候选单元）
- **安装目录**：`cat-cafe-skills/<skill-name>/`（SKILL.md + test-prompts.json）
- **注册文件**：`cat-cafe-skills/manifest.yaml` + `cat-cafe-skills/BOOTSTRAP.md`
- **增改流程**：改 SKILL.md 后同步 manifest 条目；跑 `test-prompts.json` 验证；新增 skill 记得补 manifest + BOOTSTRAP

---
*生成时间：2026-08-06 | 由 book2skill 蒸馏 + clowder skill 安装流程完成*
