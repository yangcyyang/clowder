---
feature_ids: [F038]
related_features: [F041, F100, F191]
topics: [skills, discovery, grok, provider-runtime]
doc_kind: spec
created: 2026-02-26
---

# F038: Skills 梳理 + 按需发现机制

> **Status**: in-progress | **Owner**: Maine Coon / Codex | **Priority**: P1
> **Created**: 2026-02-26

## Why

方向 A 已完成分类标记。2026-08-13，铲屎官确认任务卡 TC-2：将 Grok CLI 1.0.3 更新到 Clowder，并让 Clowder 中的 Grok 使用 `~/.grok/skills` 用户 Skills 与 `~/.grok/bundled/skills` 内置 Skills。当前真机发现 31 个用户 Skill 与 20 个可独立调用的 bundled Skill，已超过本 Feature 原定的 “skills 50+” 触发门槛。

## What

### Phase A: 分类标记（已完成）

- 项目级 `.claude/skills/` 链接问题已修复。
- 保留“simple is better, build when you need”的决策。

### Phase B: Grok Skills 隔离快照

- 在 Clowder 为 Cat Cafe MCP 创建的临时 `GROK_HOME` 中，按 invocation 建立用户与 bundled Skills 的受控快照。
- 用户 Skill 顶层符号链接必须解引用到临时副本；原目录不得成为运行时写入目标。
- 保持 Grok 原生来源与优先级语义：用户 Skill 高于同名 bundled Skill。
- 单个缺失、损坏或不可复制的 Skill 降级跳过，不阻断普通回复；凭据、日志、插件、Hooks、完整配置和历史不进入快照。
- 同步 Grok CLI 1.0.3、默认模型 `grok-4.6` 与模型探测回归。

## Acceptance Criteria

### Phase A（分类标记）
- [x] AC-A1: 项目级 Skill 链接可用，并保留来源分类。

### Phase B（Grok Skills 隔离快照）
- [ ] AC-B1: 临时 `GROK_HOME` 能发现用户与 bundled Skills，并保留来源区分。
- [ ] AC-B2: 用户 Skill 顶层链接被解引用为临时副本，原 Skill 内容和修改时间不变。
- [ ] AC-B3: 同名用户 Skill 按 Grok 原生规则覆盖 bundled；缺失、损坏或复制失败只聚合告警，不阻断普通回复。
- [ ] AC-B4: `auth.json`、日志、插件、Hooks、完整 `config.toml` 与无关历史不进入 Skill 快照；正常、异常和中止均清理临时目录。
- [ ] AC-B5: Grok 1.0.3 的版本/模型探测以 `grok-4.6` 为默认，同时保留 `grok-4.5` 可选。
- [ ] AC-B6: 真实 Clowder 任务完成普通回复、用户 Skill、bundled Skill、同线程续接与持久化回读；记录 threadId、invocationId、cliSessionId、来源和最终消息。

## 需求点 Checklist

| ID | 需求点（铲屎官原话/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “将 grok 更新到 Clowder 进去” | AC-B5, AC-B6 | CLI probe tests + runtime smoke | [ ] |
| R2 | “同时接入 Grok Skills” | AC-B1, AC-B6 | provider tests + real Skill smoke | [ ] |
| R3 | 用户与内置 Skill 都可用且来源可区分 | AC-B1, AC-B3 | isolated-home fixture | [ ] |
| R4 | 不修改原 Skill，不复制凭据、日志或历史 | AC-B2, AC-B4 | filesystem assertions | [ ] |
| R5 | 更新后无需重复手工复制 | AC-B1, AC-B5 | per-invocation refresh test | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 本轮无前端 UI 变更

## Dependencies

- **Evolved from**: F038 Phase A（分类标记）
- **Blocked by**: 无
- **Related**: F041（能力看板来源分类）、F191（本地 CLI 模型雷达）、F100（Skill 生命周期治理）

## Risk

| 风险 | 缓解 |
|------|------|
| 符号链接把原 Skill 暴露为可写目标 | 解引用到 invocation 级临时副本，禁止直接挂载源目录 |
| bundled Skills 复制带来启动开销 | 仅复制含有效 `SKILL.md` 的 Skill 目录，并记录定向性能证据 |
| 损坏 Skill 令 Grok 整体不可用 | 单 Skill 跳过 + 聚合告警；临时 Home 构建失败才终止 |
| 完整 Home 透传泄露凭据与插件 | 只允许 skills 与 bundled/skills 两个白名单来源进入快照 |
| 运行态 worktree 与开发代码错配 | 验收时核对 PID、cwd、HEAD、dist 与原线程最终消息 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | simple is better, build when you need | Phase A 不提前建设复杂检索基础设施 | 2026-02-26 |
| KD-2 | Grok Skills 使用受控临时快照，不用 symlink 或完整 Home 透传 | symlink 不只读；完整 Home 会破坏 ADR-025 隔离边界 | 2026-08-13 |
| KD-3 | 不新增 Hub UI | 本轮目标是 Grok provider 运行时可用与真实回读，避免扩大范围 | 2026-08-13 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-02-26 | Phase A 分类标记落地，方向 B parked |
| 2026-08-13 | TC-2 确认；Skills 数量超过触发门槛，Phase B 恢复为 in-progress |

## Design Gate

- 结论：放行受控临时快照方案。
- 纪要：`docs/discussions/2026-08-13-f038-grok-skills-design-gate.md`
- 保持 ADR-025 trusted headless 权限边界，不扩展 OS 权限或 MCP 能力。
