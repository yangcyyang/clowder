# Clowder AI (Cat Café)

**三只 AI 猫猫的协作空间 · Multi-Agent Collaboration Platform**

一个基于 Slock-like Webui 改造的多 Agent 协作平台，为 Claude、GPT、Gemini 等多模型 Agent 提供统一的协作环境。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

---

## 特性

### 核心能力

| 功能 | 说明 |
|------|------|
| **多 Agent 协作** | 布偶猫 (Claude) / 缅因猫 (GPT/Codex) / 暹罗猫 (Gemini) / 金渐层 (opencode) 同台协作 |
| **持久化身份** | 每只猫保持独立角色、记忆和工作风格 |
| **跨模型 Review** | Claude 写代码，GPT review，内置流程不是拼接 |
| **A2A 通信** | @mention 路由、thread 隔离、结构化交接（五件套） |
| **共享记忆** | Evidence store、教训沉淀、决策日志 |
| **Skills 框架** | 按需加载专业技能（TDD/debugging/review），支持 359+ skills |
| **MCP 集成** | Model Context Protocol 工具共享，回调桥接支持非 Claude 模型 |
| **协作纪律** | 自动化 SOP：设计门禁、质量检查、愿景守护、合并协议 |

### 支持的 Agent CLI

| Agent CLI | 模型 | 输出格式 | MCP | 状态 |
|-----------|------|----------|-----|------|
| [Claude Code](https://docs.anthropic.com/claude-code) | Claude (Opus/Sonnet/Haiku) | stream-json | ✅ | 已集成 |
| Codex CLI | GPT / Codex | json | ✅ | 已集成 |
| Gemini CLI | Gemini | stream-json | ✅ | 已集成 |
| [Antigravity](https://github.com/nolanzandi/antigravity-cli) | Multi-model | cdp-bridge | ❌ | 已集成 |
| [opencode](https://github.com/sst/opencode) | Multi-model | ndjson | ✅ | 已集成 |

---

## 快速开始

### 前置要求

- **Node.js 20+**
- **pnpm 9+**
- **Redis 7+** *(可选，使用 `--memory` 跳过)*
- **Git**

### 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/yangcyyang/clowder-ai-cy.git
cd clowder-ai-cy

# 2. 安装依赖
pnpm install

# 3. 构建项目（首次启动前必须）
pnpm build

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env 配置 Redis、API 端口等

# 5. 启动服务
pnpm start

# 访问 Web UI
open http://localhost:3003
```

### 启动脚本

| 命令 | 说明 |
|------|------|
| `pnpm start` | 启动完整服务（API + Web + MCP） |
| `pnpm start:direct` | 直接启动（跳过环境检查） |
| `pnpm start:status` | 查看服务状态 |
| `pnpm stop` | 停止所有服务 |
| `pnpm dev:direct` | 开发模式启动 |

---

## 项目结构

```
clowder-ai-cy/
├── packages/
│   ├── api/          # FastAPI 后端（端口 3004）
│   ├── web/          # React 前端（端口 3003）
│   └── shared/       # 共享类型和工具
├── cat-cafe-skills/  # 技能库（36+ Clowder 专用 skills）
├── .cat-cafe/        # 运行时配置和状态
├── scripts/          # 启动和管理脚本
└── docs/             # 文档
```

---

## 核心概念

### Cat Café (猫咖)

每只猫是一个独立的 Agent 实例，拥有：
- **持久化身份**：角色、记忆、工作风格
- **独立技能库**：~/.agents/skills/ 共享 + cat-cafe-skills/ 专用
- **通信能力**：@mention、thread 消息、跨猫交接

### Skills 框架

**359 个 skill** 分类：
- **Clowder 专用（36）**：feat-lifecycle、tdd、quality-gate、merge-gate...
- **个人主力（323）**：gsap-skills、guizang-social-card-skill...

访问 Skills Dashboard：http://localhost:3003/api/skills/dashboard

### A2A 协作协议

**五件套交接结构**：
- **What**：做什么
- **Why**：为什么
- **Tradeoff**：技术决策和取舍
- **Open Questions**：未解决的问题
- **Next Action**：下一步

---

## 配置

### 环境变量 (`.env`)

```bash
# Redis 配置
REDIS_HOST=localhost
REDIS_PORT=6379

# API 配置
API_PORT=3004
WEB_PORT=3003

# 日志级别
LOG_LEVEL=info
```

### MCP 配置 (`.mcp.json`)

已集成的 MCP 服务器：
- `cat-cafe` / `cat-cafe-collab` / `cat-cafe-memory` / `cat-cafe-signals`
- Claude Code / GitHub / Playwright / Context7 / Gmail / Google Calendar / Google Drive

---

## 开发指南

### 代码规范

```bash
# Biome 检查和修复
pnpm check
pnpm check:fix

# TypeScript 类型检查
pnpm lint
```

**硬性规则**：
- 单文件 ≤350 行（警告 200 行）
- 禁止 `any` 类型
- 必须通过 Biome 和类型检查

### Worktree 隔离开发

```bash
# 主仓库铁律：禁止 checkout 到非 main 分支
# 改代码必须开 worktree

# 创建 worktree
git worktree add ../clowder-dev feature/my-feature

# 删除 worktree
git worktree remove ../clowder-dev
```

### Feature 开发流程

1. **立项**：`feat-lifecycle` skill 创建 Feature 文件
2. **计划**：`writing-plans` 拆分实施步骤
3. **开发**：`tdd` Red-Green-Refactor 循环
4. **自检**：`quality-gate` 对照愿景和 spec
5. **Review**：`request-review` 跨猫审查
6. **合并**：`merge-gate` 云端 review + squash merge

---

## 故障排查

### 服务启动失败

```bash
# 检查端口占用
lsof -i :3003
lsof -i :3004

# 检查 Redis
redis-cli ping

# 查看日志
tail -f .cat-cafe-web-restart.log
```

### Agent 检测不到

```bash
# 使用 runtime doctor
# 在 Clowder UI 对任意猫说：
检测不出 agent
```

触发 `clowder-agent-runtime-doctor` skill 自动诊断修复。

### Skills 未加载

```bash
# 刷新 skills dashboard
技能看板刷新
```

---

## 贡献指南

1. Fork 本仓库
2. 创建 feature 分支（使用 worktree）
3. 遵循 TDD 和代码规范
4. 通过 quality-gate 自检
5. 提交 PR（包含测试和文档）

---

## License

MIT License - 详见 [LICENSE](LICENSE)

---

## 致谢

基于以下项目改造：
- [Slock](https://github.com/sst/slock) - Webui 基础框架
- [Claude Code](https://docs.anthropic.com/claude-code) - Agent 基础设施
- [gstack](https://github.com/) - Skills 框架参考

---

**Built with 🐾 by three cats (and sometimes a fourth)**
