---
doc_kind: research-extract
topics: [quality-gate, evaluation, scorecard]
created: 2026-07-06
source: https://github.com/benchflow-ai/awesome-evals (clone 于 ~/.slock/external-clones/awesome-evals，只读引用，不入 Clowder 代码库)
---

# awesome-evals 评估方法选型摘要 · Epic B1 交付物

给 `quality-gate` 评分卡设计者（B2-B4，负责人 gpt52）参考。核心依据是 `PATTERNS.md` 全部 10 个 pattern，逐条判断是否适配 Clowder 三个高频场景：复刻类任务、写代码类任务、审查类任务。

## 一、10 个 pattern 适配判断

| Pattern | 适配度 | 一句话理由 |
|---|---|---|
| LLM-as-judge aligned to humans | 强适配（审查、复刻） | 唯一一套主观质量判断的标准化方法：二元判断 + 少样本 critique + TPR/TNR 验证 |
| pass@k / pass^k | 弱适配 | 回答"多次尝试的成功率"，不是"这次做完了没有"的门禁判断 |
| Code-based assertions | 强适配（写代码核心） | 能用代码断言的就不要上 LLM，quality-gate 应优先走这条 |
| Error analysis: open→axial→prioritize | 元方法，适配全部场景 | 评分卡的每一条规则该从真实失败案例里长出来，不是凭空列标准 |
| Trajectory & tool-use evaluation | 弱适配 | 关心"怎么做到的"而非"结果对不对"，非当前重点 |
| Outcome / environment-state grading | 强适配（写代码核心，复刻） | 断言世界状态而非文本声称，直接命中"文档说做完但代码没做"的痛点 |
| CI gating & regression datasets | 强适配（写代码，quality-gate 自身基础设施） | 每次修复的 bug 固化成回归用例，检查集只增不减 |
| Verifiable reward（SWE-bench FAIL_TO_PASS/PASS_TO_PASS） | 强适配（写代码核心） | "新测试通过 AND 旧测试全绿"是"真的做完、没引入回归"最直接的可执行定义 |
| Synthetic test-data generation | 弱适配（当前阶段） | 解决"没数据怎么造"，Clowder 不缺真实交付案例，是未来扩展工具 |
| Contamination-resistant eval design | 不适配 | 解决跨模型公开基准"背题"问题，和内部质量门禁无关 |

## 二、按场景选型

### 场景①复刻类任务
推荐：**Outcome/environment-state grading**（结构主）+ **LLM-as-judge**（补充主观项）
- 一次性对参考页面做快照（截图+DOM/computed style）当 golden state，复刻结果对快照做 diff，不凭感觉判断"像不像"。
- 能拆客观检查的先拆（关键区域存在性、颜色 token、间距容差、交互态齐全）走代码断言；剩余主观项才用 LLM judge，且必须拆成若干二元判断项，不用 1-10 分"相似度"。

### 场景②写代码任务
推荐：**Verifiable reward（SWE-bench 式）** + **Outcome grading** + **Code-based assertions**，配合 **CI gating** 落地
- 最有价值的具体规则：判定"resolved"需**同时满足** FAIL_TO_PASS 全部通过（证明修好）**和** PASS_TO_PASS 100% 保持绿色（证明没回归）——修好目标但弄坏已有测试 = 直接判 NO，不是 PARTIAL。
- 断言"世界状态"而非"文本声称"：检查测试是否真跑过并通过、文件是否真的改了，不能凭猫自己写的"已完成"说明放行。
- 能用 regex/JSON schema/DB 查询代替 LLM 判断的地方就不用 LLM。

### 场景③审查类任务
推荐：**LLM-as-judge**，配合 **Error analysis** 生成评分卡内容
- 二元 pass/fail 判断优于 1-5 分——3 分和 4 分之间是噪音，二元判断才能算分类指标。
- 少样本 critique 示例才是真正起作用的部分，不是塞进 prompt 的长 rubric——每条检查项配 1 条专家写的"为什么 FAIL"一句话理由。
- 验证判官必须分别看 TPR 和 TNR，不能看原始一致率——避免"一个全判 PASS 的检查器在 90% 案例都通过的场景里显得很准"的假象。
- 评分卡规则来自真实观察到的漏检案例（error analysis 的 open coding），不是凭空列一套通用标准。

## 三、给 quality-gate 设计者的落地清单（可直接写进 skill）

1. **所有检查项二元化（pass/fail），禁止 1-5 分或百分比打分制**——过/不过才有意义。
2. **断言"世界状态"而非"文本声称"**——判定"完成"要检查测试是否真跑过、文件是否真改了、构建产物是否真生成，不能仅凭猫自己写的"已完成"放行。
3. **"做完" = 目标测试通过 AND 既有测试全绿，两者缺一不可**——只修好目标但引入回归 = 不算做完，不是"部分完成"。
4. **能用代码断言解决的就不要上 LLM**——LLM judge 只留给真正主观、无法结构化的残余部分。
5. **评分卡规则必须来自真实观察到的失败案例**——每次人工发现的漏检，追加为新检查项。
6. **用少样本 critique 示例（pass/fail + 一句话理由）校准 LLM 判官，而非塞长 rubric**。
7. **任何检查器/判官都要在历史交付上分别验证 TPR 和 TNR，不能只看整体一致率**。
8. **每次人工发现的漏检案例固化为回归用例，接入常驻检查，检查集只增不减**。

补充：**pass@k vs pass^k** 的区分不直接是检查规则，但适合用来定义"quality-gate 到底在回答哪个问题"——如果未来要评估某类任务的稳定性而非单次交付判断，建议采用 pass^k（每次都要成功），更贴近交付场景"必须每次都对"的要求。

## 四、和 Epic A 的联动点

Epic A 的 gap 分析里发现 Claude Code 官方 `skill-verify-skill.md` 用 **PASS/FAIL/BLOCKED/SKIP 四态** + "存疑判 FAIL"的不对称原则（见 `claude-code-prompt-patterns-gap-analysis.md` Gap #13），和本文档"二元化 + 存疑判 FAIL"的建议完全一致，建议 B2 设计评分卡时直接采用四态而非二态，多出的 BLOCKED（缺信息无法判断）/SKIP（不适用）两态能减少"硬要塞进 pass/fail 导致误判"的情况。
