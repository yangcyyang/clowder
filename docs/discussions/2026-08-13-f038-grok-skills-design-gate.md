---
feature_ids: [F038]
topics: [grok, skills, design-gate, security]
doc_kind: discussion
created: 2026-08-13
---

# F038 Grok Skills 隔离接入 Design Gate

## 背景

铲屎官确认 TC-2：将 Grok CLI 1.0.3 与 Grok 用户/内置 Skills 接入 Clowder。现有 `GrokAgentService` 为 Cat Cafe MCP 创建临时 `GROK_HOME`，只复用 sessions、auth 路径和模型缓存，因此会丢失 Grok 自己的用户与 bundled Skills。

## 取证

- 本机 Grok CLI：1.0.3，默认模型 `grok-4.6`。
- `~/.grok/skills`：31 个顶层符号链接 Skill。
- `~/.grok/bundled/skills`：20 个可独立识别的 bundled Skill，另有共享资源目录。
- 空临时 `GROK_HOME` 无法发现上述两类 Skill；映射 `skills` 与 `bundled/skills` 后可恢复原生发现和来源优先级。

## 方案比较

1. **源目录 symlink**：性能好，但不是只读；否决。
2. **受控临时快照**：解引用用户顶层链接，只复制有效 Skill 目录；放行。
3. **完整 `~/.grok` 透传**：同时暴露凭据、日志、插件、Hooks 与历史；否决。

## 决策与数据流

```text
~/.grok/skills ──校验 + 解引用复制──> 临时 GROK_HOME/skills
~/.grok/bundled/skills ──校验 + 复制──> 临时 GROK_HOME/bundled/skills
                                           ↓
                                  Grok 原生按需发现/加载
                                           ↓
                                  invocation finally 清理
```

- 用户同名 Skill 沿用 Grok 原生优先级覆盖 bundled。
- 单个 Skill 失败只产生一条聚合告警，不阻断普通回复。
- 凭据、日志、插件、Hooks、完整配置和无关历史不进入快照。

## Design Gate

- 类型：纯后端 provider 生命周期变更。
- 结论：**放行方案 2**。
- 元审美：以 invocation 快照替换共享可写 Home，是改变共享状态结构的坐标变换，不是权限补丁堆叠。

## 收敛检查

1. 否决理由 → ADR？有，已补到 `docs/decisions/025-grok-trusted-headless-permissions.md`。
2. 踩坑教训 → public-lessons？有，追加 LL-059。
3. 操作规则 → 指引文件？没有；属于 Grok provider 局部不变量，由 ADR 与测试固定。
