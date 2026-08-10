---
feature_ids:
  - task-73
topics:
  - grok
  - account-binding
  - hub-cat-editor
doc_kind: bug-report
created: 2026-07-26
---

# Grok CLI 登录态保存与编辑器回退

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Grok 成员使用本机 CLI 登录态、未绑定 `accountRef` 时，API 保存返回 `400 client "grok" requires a provider binding`；旧成员缺失 `clientId` 时，Hub 编辑器错误显示为 Claude。 |
| **2. 证据** | API 红测 `POST /api/cats allows Grok CLI login without an account binding` 得到 400；Web 红测 `does not disguise a legacy member with no clientId as Claude` 得到 `anthropic`。 |
| **3. 根因** | API 把免绑定客户端硬编码为 `antigravity/pi`，与 Grok 已支持的 CLI subscription 运行链不一致；前端 `initialState` 对缺失 `clientId` 无条件回退 `anthropic`。 |
| **4. 诊断策略** | 逆向追踪 POST/PATCH 保存校验、runtime catalog 持久化和 Grok subscription 调用链；对照编辑器初始状态与下拉渲染。 |
| **5. 超时策略** | 若统一能力声明导致跨包类型扩散超过预期，先收缩为 shared 只读能力函数，由 API/Web 分别消费，避免改运行协议。 |
| **6. 预警策略** | Grok 通过但 Dare/OpenCode 无绑定也通过，说明能力表定义错误；编辑器能保存空 Client，说明 UI 门禁不完整。 |
| **7. 用户可见交互修正** | Grok 可选择“使用 CLI 登录态”并无账号保存；缺失 Client 显示“未设置”和明确修复提示，不再伪装成 Claude。 |
| **8. 验收** | API POST 无绑定成功、PATCH `accountRef:null` 成功并真实落盘；Web 初始状态保留 Grok 模型且 Client 为空；相关定向测试、类型检查通过。 |
