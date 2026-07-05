# Codex Silent Completion Bug Report

## 报告人

铲屎官在 thread `default` 观察到 Codex 多次显示“已完成本轮调用，但没有返回可展示文本”。Claude Opus4.8 复核后确认不是 mention 路由问题，而是 Codex 已完成工具执行但最终可见回复为空。

## 复现步骤

1. Codex 先输出一段过程性 `agent_message`。
2. 随后发生工具调用或文件变更事件，过程性文本被正确降级为 `thinking`。
3. 回合结束时收到 `turn.completed`，但没有新的最终 `agent_message`。

期望行为：用户至少看到一条可见结论，说明本轮完成且带最后进度。

实际行为：`turn.completed` 只 flush pending text；pending 已被工具事件消费后返回 `null`，导致 silent completion。

## 根因分析

`codex-event-transform.ts` 中 `turn.completed` 只调用 `flushCodexPendingText()`。当 pending text 已经被 `withPendingThinking()` 降级成 `thinking`，且后续没有最终 `agent_message` 时，转换器没有任何可见 text 可发。

`CodexAgentService` 的流结束兜底也同样只调用 `flushCodexPendingText()`，所以无 `turn.completed` 的尾帧场景也可能沉默。

## 修复方案

新增 completion-aware fallback：

- 保留 `99b8478` 的行为：过程文本仍降级为 `thinking`，不重新变成正式回答。
- 记录最后一个实质工具/进度活动摘要。
- `turn.completed` 或流结束时，如果没有 pending final answer，但存在实质活动，则合成一条最小可见 text。
- fallback 文案明确说明“没有输出最终总结”，不假装是模型最终答案，并带“最后进度”。

## 验证方式

- `codex-event-transform.test.js` 新增 RED/GREEN：工具活动后无 final answer 时，`turn.completed` 输出 fallback text。
- `codex-agent-service.test.js` 新增 RED/GREEN：完整 service 流在多工具、无 final answer 时仍产出可见 text。
- 回归验证：正常 final answer 仍只输出最终答案，过程文本仍为 `thinking`。
