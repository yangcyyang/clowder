---
feature_ids: [F001]
related_features: []
topics: [A2A, mention, 路由]
doc_kind: spec
created: 2026-07-12
---

# F001: @ 目标忙碌时 mention 应在其空闲后自动重投

> Status: idea | Owner: TBD

## Why

2026-07-12 实测发现：A 猫 @ B 猫时，若 B 猫正忙（例如在处理别的调用），系统只给 B 留一条"未自动触发"的提醒，B 空闲后**不会**自动重新投递这条 pending mention——B 永远不知道有人 @ 过它，只能靠人类手动重新推一次。这次是宪宪 @ 芝芝时踩到的，靠 cy 手动干预才补上。

## What

@ 目标忙碌时，mention 应该进入一个待投递队列；目标下一次转入空闲/可接收状态时，自动补投这条 pending mention（视为它此刻收到），而不是静默丢弃等人类发现。

### 发送前交棒 lint（同一平台改进项）

发送前识别“交给 XX”“等 XX 来取”“请 XX 接手”“交付给 XX 验收”等交棒语句。若消息没有按路由解析器规则写出独立行首的 `@接球猫`，拦截发送并提示补全；句中 @、URL 内 @ 不算。普通的叙述性提及不触发，避免把正常交流误判为交棒。

## Acceptance Criteria

- [ ] AC-1：A @ B 时 B 正忙，mention 记录为 pending，不丢失
- [ ] AC-2：B 转为空闲后，pending mention 自动触发投递，B 能看到并可响应
- [ ] AC-3：多条 pending mention 按时间顺序补投，不重复、不遗漏
- [ ] AC-4：含明确交棒语句、但没有独立行首 @ 接球猫的消息，发送前被拦截并提示补全
- [ ] AC-5：句中 @ 或 URL 内 @ 不通过交棒 lint；普通叙述性提及不被误拦

## Dependencies
## Risk
## Open Questions

- 忙碌判定的粒度（会话级 / 单条调用级）待定
