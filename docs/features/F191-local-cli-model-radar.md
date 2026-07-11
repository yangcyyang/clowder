---
feature_ids: [F191]
related_features: [F127, F180]
topics: [local-cli, model-discovery, configuration, observability]
doc_kind: spec
created: 2026-07-10
---

# F191: Local CLI Model Radar — 本地 CLI 真实模型扫描雷达

> **Status**: in-progress | **Owner**: Maine Coon / Codex | **Priority**: P1

## Why

铲屎官要求把现有“只探测 CLI 是否安装”的扫描升级为“探测安装 + 枚举真实模型 + 喂给前端候选”。核心痛点是手写模型清单会过期或写错，甚至让成员静默落到不存在的模型；成员模型发生漂移时必须现场提示，但不能自动替换。

## What

### Phase A: 三层模型探测链

为 claude、codex、gemini、opencode、kimi、cursor、opencli 建立 L1 command → L2 config → L3 static 的顺序探测。统一输出 `{ id, source, isDefault }`，复用 5 秒超时、16KB 输出上限和脱敏机制；配置读取只允许显式白名单文件。

### Phase B: 扫描快照与候选路由

手动扫描后按操作用户保存进程内最新快照；`/api/cat-model-options` 必须校验身份，只读取当前用户的快照。没有当前用户快照时使用 L3 static，并返回 `modelsSource`。不新增定时任务。

### Phase C: 前端来源与漂移可见性

Model 候选显示 `实测`、`配置`、`内置(可能过期)` 来源徽章；扫描按钮改为“扫描本机 CLI 与模型”。成员当前模型不在最近扫描清单时，在模型配置现场显示“当前模型未在最近扫描中发现”，不自动改值。

## Acceptance Criteria

### Phase A（三层模型探测链）
- [ ] AC-A1: 七个 CLI 都有经过真机核实的 L1/L2/L3 探测定义与注释，交互式 TUI 不作为 L1。
- [ ] AC-A2: L1 成功、L1→L2、L2→L3、全失败、凭证路径拒绝和输出脱敏均有红绿测试。
- [ ] AC-A3: 单文件不超过 350 行，探测实现按职责拆分。

### Phase B（扫描快照与候选路由）
- [ ] AC-B1: 手动扫描只更新当前用户的模型快照；没有扫描时不执行后台探测。
- [ ] AC-B2: 模型候选路由优先扫描快照、无快照回退 static，并返回正确 `modelsSource`。
- [ ] AC-B3: 模型候选接口未认证返回 401；不同用户之间不能读取彼此的扫描快照。

### Phase C（前端来源与漂移可见性）
- [ ] AC-C1: 扫描卡片和 Model 候选显示来源徽章，按钮文案准确。
- [ ] AC-C2: 当前成员 model 不在最近扫描清单时显示现场警告，且表单值保持不变。
- [ ] AC-C3: 运行时 curl/UI 证明 Codex、OpenCode 和至少一个 static fallback 的来源正确。

## 需求点 Checklist

| ID | 需求点（铲屎官原话/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “每个 CLI 一条三层探测链，按顺序取第一个成功的” | AC-A1, AC-A2 | CLI 能力矩阵 + unit tests | [ ] |
| R2 | “配置文件读取硬红线” | AC-A2 | credential-path rejection test | [ ] |
| R3 | “优先读最近一次扫描结果，没扫过用 L3 static” | AC-B1, AC-B2, AC-B3 | route tests | [ ] |
| R4 | “按 modelsSource 显示徽章” | AC-C1 | component test + screenshot | [ ] |
| R5 | “漂移只提示，不要自动改成员配置” | AC-C2 | component regression test | [ ] |
| R6 | “扫描仍然手动触发，不加后台定时” | AC-B1, AC-C1 | route/UI inspection | [ ] |
| R7 | “重启后真机验证 Codex/OpenCode/static fallback” | AC-C3 | curl + screenshot | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

## Dependencies

- **Evolved from**: F127（成员实例配置与 Model 编辑入口）
- **Blocked by**: 无
- **Related**: F180（Agent CLI Hook Health and Sync）

## Risk

| 风险 | 缓解 |
|------|------|
| CLI “models” 命令是交互式或会联网 | 只接受已实测的只读、非交互命令；否则进入 L2/L3 |
| 配置文件泄露凭证 | 显式文件白名单 + 敏感文件名拒绝 + 只返回抽取字段 |
| 扫描结果过期 | 每次结果带扫描时间与来源；static 明示可能过期 |
| 多用户读取同一份本机扫描快照 | 接口强制身份校验；进程缓存按 userId 隔离 |
| 动态候选触发静默换模型 | 删除自动回填逻辑；仅显示漂移警告并由 Owner 确认 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 按 userId 隔离的进程内快照优先，不先引入落盘缓存 | 满足“最近一次扫描”、避免跨用户串扰，并控制文件生命周期与权限复杂度 | 2026-07-10 |
| KD-2 | 标准化模型对象是后端与前端唯一契约 | 把来源与默认值归一，避免多处再次硬编码 | 2026-07-10 |
| KD-3 | 漂移警告放在 Model 配置现场 | 用户第一时间看到问题，且不制造全局通知噪音 | 2026-07-10 |

## Design Gate

- 用户已在任务中明确按钮文案、徽章文案、警告文案与“不自动修改”的交互约束，可视为本次 UI 行为确认。
- 在地设计：复用现有 Model 输入与本地 CLI 扫描卡片；来源作为紧邻候选/扫描结果的小徽章，窄屏随文本换行，不新增顶层入口。
- 备选方案：全局 Observability 面板会让用户离开配置现场查原因，因此不作为第一入口。

```yaml
in_context_observability:
  primary_surface: "HubCatEditor 的 Model 字段与本地 CLI 扫描卡片"
  why_not_dashboard_only: "模型漂移影响当前保存决策，必须在编辑现场可见"
  deep_dive_surface: "无；扫描卡片本身提供逐 CLI 详情"
  noise_dedup_policy: "持久内联警告；同一成员只显示一条，不发 thread 通知"
```

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | 铲屎官给出完整规格并立项 |
| 2026-07-11 | 收尾审计补齐身份校验、用户隔离、static fallback 语义和 HOME 隔离测试 |
