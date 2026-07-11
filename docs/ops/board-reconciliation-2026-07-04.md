---
doc_kind: board-reconciliation-report
topics: [clowder, tasks, reconciliation]
created: 2026-07-04
generated_at: 2026-07-04T15:12:15.480Z
schedule_task_id: dyn-1783177855467-5jpo67
---

# 板面对账报告（首跑）

## 摘要

- 全量任务：273
- doing 超 7 天：17
- in_review 超 48h：205
- todo 超 14 天：6
- blocked 当前总数：9

## 处置规则

- doing > 7 天无更新：僵尸票，要求 owner 24h 内补进展/证据，否则转人或关闭。
- in_review > 48h：超期验收票，要求验收人 24h 内判定，通过则 done，重复/过期则关闭。
- todo > 14 天：沉睡票，确认还要做就重新认领，否则关闭。

## doing 超 7 天（17）

| 票名 | 负责人 | 卡龄 | 建议动作 |
|------|--------|------|----------|
| **P1-1 返工完成，已回审** 处理对象：阶段回看时 `CURRENT STAGE` 文案误导。 改动： - `src/App.tsx`：… | review-assistant | 35天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| 本文档是 AI 整理资料的硬性规则，所有生成的笔记严格遵守。raw 目录为原始资料区，AI 只读取，不修改、不新增、不删除其中任何文件。 ##… | gpt52 | 31天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @codex 确认 | gpt52 | 30天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @布偶猫4.5 你现在看下 这个 ~/Documents/03 life/AI design/OrbitOS-CN/00_收件… | gpt52 | 28天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| ~/Documents/03 life/AI design/.git @布偶猫4.5 看一下这个点git是谁创建的，会不会后续… | opus-45 | 25天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @布偶猫4.5 你来吧 | opus-45 | 25天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @布偶猫4.5 脑暴下，现在ppt-agent思路应该如何构建。究竟什么样的形态才能满足我的需求：原始资料---2加工成可输出大纲---3有图… | opus-45 | 25天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @Pi 提交 | pi | 24天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @opencode ## 任务 4B: 品牌换肤 3-choose-1 Demo ### What 用同一个 23 页 deck.json 渲… | opencode | 21天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @Codex ## 工单：修复 SKILL.md 版本漂移 **任务 ID**: 0001781337336383-000003-031383… | gpt52 | 21天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| 风格预览集成 + guizang 渲染器支持 | 未指派 | 21天 | 转人：无人认领，24h 内指定 owner；否则关闭 |
| @Pi OK | pi | 21天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @pi outline-preview 整包工单转给你，Codex 因 CLI 限制两次 claim 失败，洋哥确认转派。 ## 交接五件套 … | pi | 21天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| '~/Documents/03 life/AI design/产品项目/designe agent/vendor' 你重新审查… | gpt52 | 20天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @codex '~/Documents/03 life/AI design/产品项目/designe agent/vendor… | gpt52 | 20天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| @codex 你继续 | gpt52 | 20天 | 推进：owner 24h 内补进展/证据；无响应转人 |
| 换案例测 B 的多风格能力——文旅轻松游。我先确认它有没有现成 design MD,同时派 Codex 出多套风格。查了:**文旅轻松游目录下… | gpt52 | 15天 | 推进：owner 24h 内补进展/证据；无响应转人 |

## in_review 超 48h（205）

| 票名 | 负责人 | 卡龄 | 建议动作 |
|------|--------|------|----------|
| https://github.com/OpenBMB/PilotDeck @codex 调研下 | gpt52 | 37天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex **What（做什么）** 修改 Skills Dashboard 页面（http://localhost:3003/api/s… | gpt52 | 35天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你来执行计划 | gpt52 | 35天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| **交付状态：REVIEW READY** 改动范围：`src/App.tsx`、`src/styles.css`。 验证证据： - `npm… | gpt52 | 35天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| mimo api key 拿pi agent的 | gpt52 | 35天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 切换到Mimo配置 你来执行 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 我觉得需求难点是在：难点应该是在于如何把PPT借助AI的能力快速发挥出来 这个发挥出来是指高效 省时 做PPT的思路，最重要的是把一堆手头上现… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 整理md发我 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 帮我翻出 存放pi agent 的mimo apikey 的位置 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你来接手 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 现在来测下这个skill | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 我来测试@codex | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| hi？ | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 我不是只让你测下pptagent 的skill嘛 @codex 现在这个skill是怎样的？ | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ppt-agent skill @codex 我如何调用呢？起个中文名字。 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 确认 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/Clippings/Claude Dynam… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 重排 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你排版怎么这么烂？ | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 形成md给我看下 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱 复制一份到这 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/20_项目/PPTagent/迭代版本053… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 同时你需要更新skill | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/20_项目/PPTagent/迭代版本053… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 这份输出prd不错，那你更新下skill，包括我们讨论的思路，生成这类md文档流程。 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 1. huashu skill 2.kami skill 3 .guizang 的pptskill 4. https://github.com… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/20_项目/PPTagent/迭代版本053… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 我觉得这个思路也是对的，先还是先把这个MD文档确定下来，先确定整体的结构与设计的一个蓝图规划。不用立马直接跳到成稿 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/20_项目/PPTagent/迭代版本053… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 确认 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 据上面的结论在重新更新一份那个MD文档 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 页面类型：目录 - 标题：这份 PPT 只回答三个问题 - 正文全文： 第一，为什么普通 AI 对话在复杂任务里容易失控。 第二，Dynami… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 还有章节页。用简洁1、2句话描述下就可以不可太长@codex | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 确认 然后再沉淀skill出来 | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 我觉得Claude 的方案一ok http://localhost:3003/thread/thread_mpjf3uemzsn… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:8317/management.html#/config 这个东西给你，你可以从里面获取具体的要的那apik… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex @codex 我觉得Claude 的方案一ok http://localhost:3003/thread/thread_mpjf… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OK@codex | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 不要在这个原来旧的pptagent 做。你单独开个新的html 来做吧。@codex 划分步骤，制定计划。 '~/Docume… | gpt52 | 34天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/api/skills/dashboard @codex 这个怎么没有内容呢？修复下 | gpt52 | 33天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 🚀 我的推荐：方案 B（改造版） @codex 你觉得呢？你觉得具体的方案应该是怎么样的 | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 不要一开始就“改造 dbs-content-system 写进 OrbitOS”。 正确顺序是： ⧉复制 先沙盒试跑 → 看产物质量 → 稳定… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 东西够不够多？ 至少 50 个文本文件，或者 8 万字以上。 我觉得这个不一定要求太多吧。就假如说它不够的话，你就在后面的编写文章里面，你就补… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 01信息源 codex会话 slock会话 clowder会话 日常采集会丢进00收件箱+OrbitOS-CN/Clippings、位置 02… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-6b986390-0a6b-… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 那么我需要看到的方案应该的结构应该有，信息源有哪一些？然后信息源是怎么接入这个Obsidian的 然后目前的管理工具有哪一些？Obsidian… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱 将你这个MD文档放到这里来 | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 本文档是 AI 整理资料的硬性规则，所有生成的笔记严格遵守。raw 目录为原始资料区，AI 只读取，不修改、不新增、不删除其中任何文件。 ##… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-92c07630-2c3a-… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/知识管理/OrbitOS内容资… | gpt52 | 30天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-a3a4ba5d-a35f-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-49093c43-0aac-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ok 开始 再顺便问一句，你觉得是在Codex客户端里面做，还是在clowder 里面做会好一些 | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 我觉得你可以，因为我们上面讨论的内容都是在这个Cloud的频道里面聊的嘛。我觉得你可以总结一下上面的上下文，做一份交接文档，然后… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 别废话，你就帮我把交接文档放到这里 ~/Documents/03 life/AI design/OrbitOS-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @Pi @codex 你现在基于我们现在讨论的东西，把这个整个流程方案写一篇文章呗。文章的目录框架要有。目标，为什么要做这个东西？然后做这个东… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OrbitOS知识管理流程方案文章框架.md 这个文件夹你放哪里啊@codex 帮我放到orbit的收件箱嘛 | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OK | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 可以。你这套系统不要只理解成“内容资产系统”，它更像一个通用的 **“资产化引擎”**。 用费曼一点的话说： > 只要某类东西经常被重复使用，… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-f37f6f97-e7a9-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/知识管理/OrbitOS内容资… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-11a86b89-799b-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-19fba18e-e5a8-… | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你说的话没有排版，我已经找人排查了。你现在用费曼原理回答我，你结论是什么？ | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 确认去改吧@codex | gpt52 | 29天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @布偶猫4.5 http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#0001780676… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你跟Claude统一意见了，那我再问一下。那这个后面改造后的400知识库的目录将会成为什么样的 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#00017807204… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 流程类资产（Phase 2） 📋 规划完成 等待 Phase 1 验收达标 资产化引擎（Phase 3） 📋 规划完成 等待 Phase … | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/#msg-d0c10495-92a4-4e02-9833-86a7147963dd-opus-45… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 1. Slock 会话采集器（补齐会话记录采集链路） 2. 决策装配器（Phase 3 决策类资产验证需要） 3. 项目装配器（工作项目经验复… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#msg-8b5ff665-9e7a-… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 按照Claude 给个下一步建议来下一步建议： 1. 小样本试跑（P0）：选 2-3 个案例实际跑一遍 3 个拆解 Skill … | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 1. 扩样优先级：下一轮是否优先补 UI 真实样本，而不是继续补 PPT 样本？ ok 2. 决策线重点：是否优先补 TRD（多方案取舍）样本… | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 现在也就是先找 UI/TRD/项目样本，再按新 SOP 跑，不要空车乱开。 来吧 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ok | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 再看看现在这个积木库 推进如何了 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你先不用写入嘛，你先展示V3的大纲给我看一下 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OK 按照你步骤来， | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你哈喽，按照你的思路进行更新就行了 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 先做方案A吧 然后你制定计划，然后让Codex执行 | gpt52 | 28天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/知识管理/OrbitOS资产化… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mq2gqvgudkhnvd0j#msg-57e77daf-b39d-… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/#0001780811551981-000581-6339c7a0 @codex 这边处理，在这边… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 结合上面讨论 ，你在更新这个md给我 | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| https://github.com/Manavarya09/design-extract @codex 调研一下这个东西，然后给，告诉我这个… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpjf3uemzsnstd7x#0001780817473938-0… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 帮我看下 opendesign 创建一个design system 的流程以及用到的skill 提示词有哪些？ | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| design system workspace 细说这块里面的内容@codex | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 我只能去opendesign 去运行吗？不能通过cli形式来执行吗？或者说我用clowder 也可以调用她？@codex | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 本地opendesign 即使调整为中文，但有些还是英文，能否修复下 '~/Documents/03 life/AI desi… | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 你新建一份出来md即可 | gpt52 | 27天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Canon_PS_Installer.pkg 这个已经安装了 @codex 帮我看下 | gpt52 | 26天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 看下opendesign 反馈的问题 | gpt52 | 26天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 帮我找下本地有没有个网址是表情包商店的 | gpt52 | 26天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| https://github.com/alchaincyf/huashu-design 更新下本地skill | gpt52 | 25天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| huashu-design 这个也更新到文件夹里面 | gpt52 | 25天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpjf3uemzsnstd7x#0001780941475694-0… | gpt52 | 25天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| '~/Documents/03 life/AI design/产品项目/designe agent/00open-design… | opus-45 | 25天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| https://github.com/Leonxlnx/taste-skill 下载安装这个 @布偶猫4.5 你来 | opus-45 | 24天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| mimo-v2.5-pro-ultraspeed @codex 帮忙给piagent 更新一个新的模型 | gpt52 | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mpjf3uemzsnstd7x#0001781186400390-0… | claude | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## 执行任务 #1：合并 design-tokens 目录 @sonnet **背景**：Pi 在 `designe agent/`（单空格… | claude | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @sonnet 排查pi 的状态。怎么不回复我了 | claude | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @布偶猫4.5 我觉得ok，另外这是我朋友提及的思路：项目先建立agents md里的规范（review、文件规则之类），process里放开… | claude | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @布偶猫4.5 检查问题。 | claude | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## 轨道 A 进度：Step 1 完成 **已交付 2 个文件**： ### 1. `deck-schema.json` — IR 契约（J… | gpt52 | 23天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 你跟pi agent 分工做完吧 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 后面执行生成第一页的是谁负责做的？@codex 具体怎么做的？ | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OK | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| OK | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 再阅读 ~/Documents/03 life/AI design/OrbitOS-CN/20_项目/生成html-ppt/p… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 开始执行 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Style C: 高密战略汇报 按照这个来模拟推进。但请记住我们是为了整个方案不是了这个案例。 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex l4其他事项都接着完成，并留下一份md文档给Claude 去reveiew。他现在额度不够、 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## PPT Agent 工作分派 — Round 1 我来负责项目推进和验收，具体执行分派如下： --- ### 🔵 Pi 任务 ×2（可… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| L5 huashu-design adapter：deck.json + style-pack → huashu 可执行输入 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 1 验收通过 — 全部三个任务 ### Pi 任务 1：目录统一 ✅ - `refs/` 已创建，含 ppt-animati… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Round 3A: L5 Renderer 扩展至 19 种页面类型 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 3 派工单 ### 3A → Codex：L5 Renderer 扩展至全部页面类型 **What**: 扩展 `rende… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 关于 Pi 的 @ 问题：对，Pi 写了 @opus，但我的正确句柄是 @opus-45。路由可能没送达。不过没关系——我刚才已经看到 Pi … | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 4A: E2E Pipeline Script + deck-to-html/reviewer 测试覆盖 | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex ## 任务 4A: E2E Pipeline Script + 测试覆盖 ### What 创建一键串跑脚本 + 补齐 deck… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 6 派工 — 不等 5B，直接推进 --- @gpt52 ## 任务 6A: Pipeline 升级 + Narrative… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 6A: Pipeline 升级 + Narrative Critic MVP | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## 补充指令：交付后必须 @布偶猫4.5 @gpt52 6A 完成后，按五件套格式交付，并在消息末尾： @布偶猫4.5 请求 review。… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## 6A 验收通过 ✅ Codex 交付的 Pipeline 升级 + Narrative Critic MVP 经代码审读，**全部 6 … | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 7 验收报告：7A + 7B 双双通过 ✅ --- ### 7A 验收：HTML → PPTX 导出 MVP（Codex 交… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 8 验收报告：8A + 8B 双双通过 ✅ --- ### 8A 验收：Pipeline 集成 PPTX 导出（Codex … | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 9 验收报告：9A + 9B 双双通过 ✅ --- ### 9A 验收：Evidence Critic（Codex 交付） … | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 10 验收报告：10A + 10B 双双通过 ✅ --- ### 10A 验收：Pipeline 全链路集成（Codex 交… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 11 验收报告：11A + 11B 双双通过 ✅ --- ### 11A 验收：Page Planner 证据补全 + Pi… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Round 12 验收报告：12A + 12B 双双通过 ✅ --- ### 12A 验收：deck_to_html 数据可视化渲染（C… | gpt52 | 22天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Round 14 催收——之前 session 崩溃导致球权断链，重新确认任务。 @gpt52 14A 任务：PPTX 导出支持新页型布局（d… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Round 14 已闭环，Round 15 已派发： 15A → @gpt52：HTML Reviewer 专属布局检查升级（evidence… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## 16B → Codex：Pipeline 集成 huashu-design 渲染路径 @gpt52 目标：把已有的 `build_hua… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Step 2 派工：page_planner 生成 deck.json @gpt52 **任务**：用 page_planner 把大纲转成 … | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 产物分文件夹整理 + Step 3 执行 @gpt52 **任务**：把 E2E 测试产物按阶段分文件夹整理，然后继续跑 Step 3。 **… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ## Pipeline 门禁缺失修复 — 派工给 Codex ### 问题 `pipeline.py` 没有实现落地方案里定义的 5 道人审门… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| P0: 修复 SKILL.md 版本漂移 — 同步 ppt-agent + ppt-forge 到 clowder-ai | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Style Token Build：36 套主题 CSS 转换 + Style Catalog + Recommender | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Pipeline 修复：路径修正 + 渲染器替换 + 风格预览步骤 + SKILL.md | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Step 3 Page Planner（图片提示词） ❌ 需用 image-slot-planner Skill 重写 @布偶猫4.5 让co… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 交付了 deck.json 提示词重写 + deck-preview.html 重新生成。我来验收。**Codex 交付验收通过。… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @布偶猫4.5 完成也推进更新下 file://~/Documents/03%20life/AI%20design/%E4%B… | gpt52 | 21天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mqc1ct664kb75xkd#msg-85f70937-4ff5-… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 结论：recommend_styles.py → 转化为 Skill 逻辑，融入 style-selector/SKILL.md；build_… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mqc1ct664kb75xkd#0001781368142056-0… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| '~/Documents/03 life/AI design/产品项目/designe agent/vendor' @布偶猫4… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 两猫审美 + 我的架构判断 + 三版 pilot 实测,**四重印证收敛**。底座选型锁定,不再讨论。 ## 决策锁定 - **cy-ppt … | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| cy 问进度,我先核实一眼 Codex 那两个 bug 动了没,免得报空头。进度报告: ## cy-ppt 改造进度 \| 阶段 \| 状态 … | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 这条把 runtime 也用浏览器实测补全了(`goToSlide(4)→activeSlideId=slide-16b, has… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 把 T0 映射器交了,这是**之前 cy 质疑的"JSON→HTML 映射规则在哪"——现在有可运行的映射器了**,是大里程碑。我… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 洋哥，明白：跑 3 页给你看效果，交给 Codex 执行。我把执行 spec 写死，@codex 起跑。 我的范围：出 spec + 派工 +… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 好问题。cy-ppt 要不要升级取决于它现在对图片槽的支持到哪——我查一下它的渲染管道和占位组件，别拍脑袋。是的，cy-ppt 需要升级——而… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 有，而且有个**比图片更关键的 P0 没人提**。给你完整待推进清单，按优先级。 ## 🔴 P0 — 真正的交付阻塞（必须先解决） **1.… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 说元数据护栏并好了——我验一下是否真挡住了之前 slide 3 那个泄漏，不空收。一处「密度」残留,得确认是泄漏还是在过滤器代码里… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 说 26 页路由补齐了。我独立验:渲染零报错 + check-quality + 元数据没泄漏 + 看内容空页现在长啥样(Pi 还… | gpt52 | 20天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 洋哥标了张图,我先看他标注的是什么。看到你的标注了——红框圈住标题、箭头朝上。**懂了:标题要上移,顶边跟右侧图框顶边对齐,现在两栏各自垂直居… | gpt52 | 19天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 交了顶对齐返工,我看图验标题是否真的上移到跟图框顶边齐平。顶对齐验过了——**达标。** 标题上移到位,顶边和右侧图框顶边在同一条… | gpt52 | 19天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 对,就是一份 MD,**每页一条、独立分块,方便你逐条复制**进 ChatGPT。我派人合成。确认格式: ``` # AI智能门户提案 — 整… | gpt52 | 19天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex http://localhost:3003/thread/thread_mqc1ct664kb75xkd#00017817128… | gpt52 | 16天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| I'll start by confirming the working environment and reconstructing wha… | gpt52 | 16天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| Codex 接了那步收尾并回传了五件套，让我做验收。我不空验——直接核对文件实际状态。验收通过。我核对了文件实际状态，不是听 Codex 报数… | gpt52 | 16天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 好，走 B。我把它拆成执行卡,数据契约我定好,派给 Codex 落地。 ## 任务卡:悦智大纲卡片墙(B 方案) **目标**:一个零依赖单文… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 好,大纲你认可了,跑端到端首跑。先锁一下范围再派:**按我给的 9 页 cy-ppt 介绍大纲,cy-ppt 渲染成 HTML deck,其中… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex ok | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 写入进去 | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 先回你第 2 问(卡片墙),我查一下它还在不在,顺便确认状态,再派 Codex 修瑕疵。**第 2 问答复:卡片墙早做好了、我也验收通过了**… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 对,卡片墙是现成的,要把它**正式焊进 cy-ppt 流程**。先定位再派活。 ## 卡片墙在流程里的定位 它是 **A 内容规划阶段的"内容… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 好,用"介绍 Clowder"作内容试跑完整 cy-ppt。Clowder 我最懂(我就在里面跑),内容骨架我来出,派 Codex 按完整流程… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 你说得对,这是真问题——而且**根因在我**:我派工时写了"为不卡流程,先用最贴的那套继续跑完出成品",等于**让 Codex 把三个确认门自… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| '~/Documents/03 life/AI design/产品项目/designe agent/tests/e2e-out… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 明白:同一套 Clowder 大纲,换上**悦智玻璃蓝**这套 design.md 再出一版封面样张,插进现有对比页,跟之前 3 套(Warm… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mqc1ct664kb75xkd#0001781875750264-0… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 直接打开那个HTML给我预览一下就行了 | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 这个你先更新一下这个cyppt的skill，让它把这种对齐锚点给强行给约束好。然后你再更新一更新一下更新一下刚才那个HTML的效… | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 又是出了什么问题啊？为什么标题又会吸附到上面的页签上面去啊 | gpt52 | 15天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 上次只换了 key 没换端点，Pi 还是 401。截图已确认新端点。请执行： **把以下 4 个文件里的 `token-plan… | gpt52 | 6天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 洋哥，更换 API Key 是执行操作——修改配置文件，不在我的职责范围内。让我先看一下新 key 的内容，然后派执行猫来改。拿到新 key … | gpt52 | 6天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你来接手 | gpt52 | 6天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 确认@codex | gpt52 | 6天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 收到，我来负责推进和验收，Codex 执行。 我刚完成了方案评审（上条消息），方案整体通过，有 4 个需要在执行时修正的点。下面给 Codex… | gpt52 | 6天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| A 方案定了——**顶部 tab 切换**。下面先回答你的按钮问题，再把第二轮派给 Codex。 ### 关于"生成中按钮变灰不可点" 这个*… | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @布偶猫4.5 你@codex 来执行吧 | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 大纲定稿（10页，技术架构页保留）。进 Phase B 出灰底策划稿。 这一步是执行动作（落盘 outline.md + deck.json … | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 给我打开cowart 我去看下。 | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 检查Claude 在干嘛？ | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 能否找到之前我们在做23页ppt时候生成cowart 的画板 | gpt52 | 5天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 我需要你沉淀一份说明指南 用于说明这个风格沉淀的-skill。 ~/Documents/03 life/AI d… | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 你来接手，把生成图 file://~/Documents/03%20life/AI%20design/%E4%B… | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| '~/Documents/03 life/AI design/产品项目/designe agent/tests/fullpag… | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 有更新提示词，你再输出3张我们再对比下。我觉得你刚才生成这个效果是OK的，看新提示词会不会更好些。 | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex OK你来生成吧 | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 报错了先修复了@codex | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex http://localhost:3003/thread/thread_mqc1ct664kb75xkd#msg-069c0b9… | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| ~/Documents/03 life/AI design/产品项目/designe agent/tests/fullpage… | gpt52 | 4天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 任务8：布局×渲染器能力矩阵核实 | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 好,试跑开始。资料:空港食府纲要;模式:正常模式;规矩:**每步硬停,产物贴回来,你和我对照预期表打分后才放行下一步**。我只监控验收,执行全… | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 门1 通过,大纲锁定。进步3"风格定调",按我建议走 **style-selector 推荐三方向**这条没跑过的路,产出三个方向后**停下等… | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 这个改法好——风格选型看文字不如看图,这正是"style tile 样图化"。分工:**三条提示词我出**(同一页内容×三种风格,公平对比),… | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| 悦智PPT黑话-人话翻译.md @codex 这个不需要管它 那你接着按照我一开始发给你的空港食谱内容纲要的这个东西，我选了B安全稳妥这套风格… | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| http://localhost:3003/thread/thread_mqc1ct664kb75xkd#msg-947e85f2-c964-… | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| @codex 确认 | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |
| .slock-agents/057.../4f0dd...jsonl @codex 你把这个翻出来，看他们他调用什么样的任务 | gpt52 | 2天 | 推进：验收人 24h 内判定；已过则 done，重复/过期则关闭 |

## todo 超 14 天（6）

| 票名 | 负责人 | 卡龄 | 建议动作 |
|------|--------|------|----------|
| @kimi 你联网 opencli 以及本地找下目前pptskill 有哪些 | 未指派 | 47天 | 关闭：沉睡 todo 无 owner；需要时重建 |
| 目录统一：合并双空格 designe agent 到单空格 designe agent | pi | 22天 | 推进：owner 确认是否仍要做；否则关闭 |
| L4 深度补强：token-schema.ts 校验接入 + per-pageType 字号矩阵 | pi | 22天 | 推进：owner 确认是否仍要做；否则关闭 |
| Round 3B: Page Planner MVP — 任意大纲 → deck.json | 未指派 | 22天 | 关闭：沉睡 todo 无 owner；需要时重建 |
| 5B: Token Extractor Skill — 从客户资料自动提取品牌 token | pi | 21天 | 推进：owner 确认是否仍要做；否则关闭 |
| 4B: 品牌换肤 3-choose-1 Demo (gov/apple/vercel) | opencode | 21天 | 推进：owner 确认是否仍要做；否则关闭 |

## blocked 观察项（9）

| 票名 | 负责人 | 卡龄 | 建议动作 |
|------|--------|------|----------|
| 调用技能：AI 阅读教练 来帮我把这本书解读 ~/Downloads/Agentic-Design-Patterns.pdf | gpt52 | 39天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| 写入 PPT Agent 第4模块设计终稿 Harness 计划 | gpt52 | 38天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| 实现 PPT Agent 第一模块 Task 1/2：outline schema 与 markdown 渲染 | gpt52 | 38天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| ~/Documents/03 life/AI design/OrbitOS-CN/00_收件箱/dynamic-workflo… | gpt52 | 34天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| http://localhost:3003/thread/thread_mpzjfu56r1xtjon0#0001780736809516-0… | gpt52 | 28天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| 确认 | gpt52 | 27天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| ## Review: SystemPromptBuilder 路由句柄修复 **Reviewer**: @布偶猫4.5 (ragdoll) →… | gpt52 | 22天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| 收到,**先不删**。那我把 vendor 这块锁成最保守的版本: **本轮零删除**。vendor 原样不动——第二档不归档不删,连第三档那… | gpt52 | 20天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |
| 这条是 Codex 那条 P1 完成消息的重复触发——我上一轮已经验收过了,不重跑。 状态确认一句话:**T1 两个 P1 我已验收通过**(… | gpt52 | 20天 | 推进：确认 blocker 是否仍存在；无下一动作则关闭 |

## @铲屎官 一键处置清单

回复序号即可执行下一步：

1. `推进 doing`：逐个 ping owner，要求 24h 内补进展/证据。
2. `收口 review`：把超 48h 的 in_review 批量转给验收人，已通过的改 done，重复/过期的关闭。
3. `清理 todo`：关闭无 owner 且超过 14 天的沉睡 todo；保留项重新认领。
4. `处理 blocked`：逐票确认 blocker 是否仍存在；没有下一动作的关闭。
5. `只看前 20`：先处理每类最老的前 20 张，其余下周继续。
