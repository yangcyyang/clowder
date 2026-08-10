# Cat Café Skills Bootstrap

<EXTREMELY_IMPORTANT>
你已加载 Cat Café Skills。路由规则定义在 `cat-cafe-skills/manifest.yaml`。

## Skills 列表（38 个）

**集成 Superpowers**: 详见 `refs/superpowers-integration.md`

### 开发流程链
```
feat-lifecycle → Design Gate(设计确认) → writing-plans → worktree → tdd
    → quality-gate → request-review → receive-review
    → merge-gate → feat-lifecycle(完成)
```

| Skill | 触发场景 | SOP Step |
|-------|----------|----------|
| `feat-lifecycle` | 新功能立项/讨论/完成 | — |
| `guide-authoring` | 编排场景引导 YAML / registry / 标签契约 | — |
| `guide-interaction` | 判断是否需要交互引导，并按 Guide Matched/Pending/Active 等状态驱动回复 | — |
| `collaborative-thinking` | brainstorm/多猫讨论/收敛 | — |
| `expert-panel` | 专家辩论团/竞品分析/技术趋势/showcase | — |
| `writing-plans` | 写实施计划 | — |
| `worktree` | 开始写代码（创建隔离环境） | ① |
| `tdd` | 写测试+实现（红绿重构） | ① |
| `console-dev` | 前端交付范式（4-gate 门禁） | — |
| `debugging` | 遇到 bug（系统化定位） | — |
| `quality-gate` | 开发完了自检（愿景+spec+验证） | ② |
| `request-review` | 发 review 请求给 reviewer | ③ |
| `receive-review` | 处理 review 反馈（Red→Green） | ③ |
| `merge-gate` | 门禁→PR→云端 review→merge→清理 | ④⑤⑥ |
| `cross-cat-handoff` | 跨猫交接/传话（五件套） | — |
| `deep-research` | 多源深度调研 | — |
| `knowledge-engineering` | 外部项目文档重构/冷启动知识注入 | — |
| `writing-skills` | 写新 skill | — |
| `pencil-design` | 设计 UI / .pen 文件 | — |
| `open-source-teardown` | 明星开源项目/竞品代码拆解 | — |
| `rich-messaging` | 发语音/发图/发卡片/富媒体 | — |
| `enterprise-workflow` | 企微/飞书文档、表格、待办、会议、日程一键创建 | — |
| `schedule-tasks` | 定时任务/周期提醒/延迟执行 | — |
| `hyperfocus-brake` | 铲屎官健康提醒/三猫撒娇打断 | — |
| `incident-response` | 闯祸了/不可挽回/人很难过 | — |
| `image-generation` | 生成图片/画头像/AI 画图 | — |
| `self-evolution` | scope 守护/流程改进/知识沉淀 | — |
| `bootcamp-guide` | CVO 新手训练营引导 | — |
| `cross-thread-sync` | 跨 thread 协同/通知/争用协调 | — |
| `browser-preview` | 写前端/跑 dev server/看页面效果 | — |
| `browser-automation` | 外部网站浏览/登录态流程/浏览器工具路由 | — |
| `workspace-navigator` | 铲屎官说"打开日志/看代码/打开设计图"等模糊指令 → 猫猫自己找路径 → API 导航 | — |
| `clowder-agent-runtime-doctor` | Agent 列表/运行态/API 不通时检查和修复 | — |
| `ppt-forge` | 做 PPT/演示文稿/视觉审查（三猫流水线） | — |
| `ppt-agent` | 模糊需求+资料 → Brief 补齐 → 资料理解 → 页面计划 | — |
| `video-forge` | 做视频/showcase/教程视频/视频审查 | — |
| `update-skills-dashboard` | 新增/删除/修改 skill 后刷新技能看板 HTML | — |
| `subagent-dispatch` | 子任务并行分派（借鉴 Superpowers） | — |

### FDE 交付（《前线部署工程师》范冰蒸馏，15 skills）

| Skill | 触发场景 | SOP Step |
|-------|----------|----------|
| `psf-screening` | 问题三关检验（痛点/经济性/可行性），值不值得做 | — |
| `shadow-work` | 影子工作法：现场观察发现文档里没有的痛点 | — |
| `mvd-validation` | 最小可行部署：真实数据/缩小切口/定死截止验证价值 | — |
| `poc-rejection` | 拒绝机制与免费验证治理：毕业标准防概念验证坟墓 | — |
| `site-due-diligence` | 进场尽调五份地图：数据/流程/组织/系统/政治 | — |
| `lighthouse-customer` | 灯塔客户策略与排期：双维打分/需求蝗虫识别/生态捆绑 | — |
| `proposal-pyramid` | 倒金字塔提案：业务结果→验证路径→交付方法→风险对策 | — |
| `deployment-activation` | 部署激活六件武器：热修复/评估/降门槛/集成/变革/自动化 | — |
| `delivery-automation` | 交付自动化与打法手册：四类资产/场景手册 | — |
| `retention-defense` | 续约守卫五道防线：流失诊断/可靠性/单点防御/健康度 | — |
| `revenue-expansion` | 收入扩大四引擎：成果计价/存量深耕/变惩为奖/价值度量 | — |
| `scale-copy` | 规模化复制与产品化：三级杠杆/复盘/产品化四问 | — |
| `trust-marketing` | 信任营销与口碑传播：战壕视角/借势/三圈层/裂变因子 | — |
| `fde-ethics` | 职业道德六底线：数据主权/诚实报告/不制造依赖/说不 | — |
| `fde-metrics` | 四层指标体系：交付/客户/商业/组织 + 健康度 | — |

### 参考文件（refs/，按需读取）

| 文件 | 内容 |
|------|------|
| `refs/shared-rules.md` | 三猫共用协作规则（单一真相源） |
| `refs/decision-matrix.md` | 决策权漏斗矩阵 |
| `refs/commit-signatures.md` | 猫猫签名表 + @ 句柄 |
| `refs/pr-template.md` | PR 模板 + 云端 review 触发模板 |
| `refs/review-request-template.md` | Review 请求信模板 |
| `refs/vision-evidence-workflow.md` | 前端截图/录屏证据流程（B1） |
| `refs/requirements-checklist-template.md` | 需求点 checklist 模板（B3） |
| `refs/mcp-callbacks.md` | HTTP callback API 参考 |
| `refs/rich-blocks.md` | Rich block 创建指南 |
| `refs/ppt-density-playbook.md` | PPT 密度填充手法（9 种手段 + 量化门禁） |
| `refs/ppt-visual-review.md` | PPT 视觉审查 Gate（D1 布局+D2 审美） |
| `refs/ppt-style-tile.md` | PPT 风格定调（核心页 CSS 变量） |
| `refs/f190-frontend-lessons.md` | F190 Console 重构案例集（console-dev 补充） |

## 关键规则

1. **Skill 适用就必须加载，没有选择**
2. **完整流程见 `docs/SOP.md`**
3. **三条铁律**：Redis production Redis (sacred) / 同一个体不能 self-review / 不能冒充其他猫
4. **共用规则在 `refs/shared-rules.md`**（不在各猫文件里重复）
5. **Reviewer 选择是动态匹配**（`docs/SOP.md` 配对规则），禁止写死“reviewer 是Ragdoll”

## 使用方式

- **Claude**: Skills 自动触发（`~/.claude/skills/`）
- **Codex**: 手动加载 `cat ~/.codex/skills/{skill-name}/SKILL.md`
- **Gemini**: Skills 自动触发（`~/.gemini/skills/`）

## 新增/修改 skill

1. 在 `cat-cafe-skills/{name}/` 创建 SKILL.md
2. 在 `manifest.yaml` 添加路由条目
3. 创建 symlink：`ln -s .../cat-cafe-skills/{name} ~/.{claude,codex,gemini,kimi}/skills/{name}`（OpenCode 读 `~/.claude/`，自动覆盖）
4. 运行 `pnpm check:skills` 验证

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.
</EXTREMELY_IMPORTANT>
