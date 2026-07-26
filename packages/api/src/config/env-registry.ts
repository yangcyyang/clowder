/**
 * Environment variable registry — single source of truth for all user-configurable env vars.
 * Used by GET /api/config/env-summary to report current values to the frontend.
 *
 * ⚠️  ALL CATS: 新增 process.env.XXX → 必须在下方 ENV_VARS 数组注册！
 *    不注册 = 前端「环境 & 文件」页面看不到 = 铲屎官不知道 = 不存在。
 *    SOP.md「环境变量注册」章节有说明。
 *
 * To add a new env var:
 * 1. Add an EnvDefinition to ENV_VARS below
 * 2. Use process.env[name] in your code as usual
 * The "环境 & 文件" tab picks it up automatically.
 */

import { DEFAULT_CLI_TIMEOUT_LABEL } from '../utils/cli-timeout.js';

export type EnvCategory =
  | 'server'
  | 'storage'
  | 'budget'
  | 'a2a'
  | 'governance'
  | 'cli'
  | 'proxy'
  | 'connector'
  | 'codex'
  | 'dare'
  | 'gemini'
  | 'kimi'
  | 'grok'
  | 'tts'
  | 'frontend'
  | 'push'
  | 'signal'
  | 'github_review'
  | 'evidence'
  | 'quota'
  | 'telemetry'
  | 'antigravity';

export interface EnvDefinition {
  /** The env var name, e.g. 'REDIS_URL' */
  name: string;
  /** Default value description (for display, not logic) */
  defaultValue: string;
  /** Human-readable description (Chinese) */
  description: string;
  /** Grouping category */
  category: EnvCategory;
  /** If true, current value is masked as '***' in API response */
  sensitive: boolean;
  /** If 'url', credentials in URL are masked but host/port/db preserved */
  maskMode?: 'url';
  /** If false, keep internal-only and do not surface in Hub env editor */
  hubVisible?: boolean;
  /** If false, value is bootstrap-only and cannot be edited at runtime from Hub */
  runtimeEditable?: boolean;
  /** If true, changes take effect only after service restart */
  restartRequired?: boolean;
  /** UI grouping key — vars with the same group render together (e.g. 'connector-feishu') */
  group?: string;
  /** Related var names that should be configured together (e.g. APP_ID ↔ APP_SECRET) */
  dependencies?: string[];
  /** If true, this var should appear in .env.example (enforced by check:env-example) */
  exampleRecommended?: boolean;
  /** If set, this var is deprecated — value explains the replacement */
  deprecated?: string;
}

export const ENV_CATEGORIES: Record<EnvCategory, string> = {
  server: '服务器',
  storage: '存储',
  budget: '猫猫预算',
  a2a: 'A2A 猫猫互调',
  governance: '治理 & 降级',
  cli: 'CLI',
  proxy: 'Anthropic 代理网关',
  connector: '平台接入 (Telegram/飞书)',
  codex: '缅因猫 (Codex)',
  dare: '狸花猫 (Dare)',
  gemini: '暹罗猫 (Gemini)',
  kimi: 'Kimi',
  grok: 'Grok',
  tts: '语音合成 (TTS)',
  frontend: '前端',
  push: '推送通知',
  signal: 'Signal 信号源',
  github_review: 'GitHub Review 监控',
  evidence: 'F102 记忆系统',
  quota: '额度监控',
  telemetry: '可观测性 (OTel)',
  antigravity: '孟加拉猫 (Antigravity)',
};

export const ENV_VARS: EnvDefinition[] = [
  // --- server ---
  {
    name: 'API_SERVER_PORT',
    defaultValue: '3004',
    description: 'API 服务端口',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'PREVIEW_GATEWAY_PORT',
    defaultValue: '4100',
    description: 'Preview Gateway 端口（F120 独立 origin 反向代理）',
    category: 'server',
    sensitive: false,
    runtimeEditable: true,
    restartRequired: true,
  },
  {
    name: 'API_SERVER_HOST',
    defaultValue: '127.0.0.1',
    description: 'API 监听地址（改为 0.0.0.0 可让手机/平板通过局域网或 Tailscale 访问）',
    category: 'server',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CORS_ALLOW_PRIVATE_NETWORK',
    defaultValue: 'false',
    description:
      '允许局域网/Tailscale 设备访问（手机、平板等）。开启后，来自 192.168.x.x / 10.x.x.x / Tailscale 100.x.x.x 的浏览器可以正常连接。注意：会信任整个私网内的所有设备。修改后需重启服务生效',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'UPLOAD_DIR',
    defaultValue: '~/.cat-cafe/uploads',
    description: '文件上传目录。默认放在代码树之外，避免切换 worktree 后头像/附件丢失',
    category: 'server',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'PROJECT_ALLOWED_ROOTS',
    defaultValue: '(未设置 — 使用 denylist 模式，仅拦截系统目录)',
    description:
      'Legacy allowlist 模式：设置后切换为 allowlist，仅允许列出的根目录（按系统路径分隔符分隔；配合 PROJECT_ALLOWED_ROOTS_APPEND=true 可追加默认 roots）。未设置时使用 denylist 模式（见 PROJECT_DENIED_ROOTS）。',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'PROJECT_ALLOWED_ROOTS_APPEND',
    defaultValue: 'false',
    description: '设为 true 则将 PROJECT_ALLOWED_ROOTS 追加到默认根目录（home, /tmp, /workspace 等）而非覆盖',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'PROJECT_DENIED_ROOTS',
    defaultValue: '(平台默认系统目录)',
    description:
      'Denylist 模式下额外拦截的目录（按系统路径分隔符分隔，会合并到平台默认拦截列表）。仅在未设置 PROJECT_ALLOWED_ROOTS 时生效。',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'FRONTEND_URL',
    defaultValue: '(自动检测)',
    description:
      '前端固定地址（有反向代理或固定域名时设置，如 https://cafe.example.com）。本机和局域网直连通常不需要改',
    category: 'server',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'FRONTEND_PORT',
    defaultValue: '3003',
    description: '前端端口',
    category: 'server',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'DEFAULT_OWNER_USER_ID',
    defaultValue: '(未设置)',
    description: '默认所有者用户 ID（信任锚点，不可从 Hub 修改）',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_USER_ID',
    defaultValue: 'default-user',
    description: '当前用户 ID',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_INVOCATION_REGISTRY',
    defaultValue: '(自动：有 Redis 用 redis，否则 memory)',
    description: 'F174-B InvocationRegistry 后端选择：redis（重启不丢 callback 鉴权）/ memory（fallback / 测试）',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_AGENT_KEY_SECRET',
    defaultValue: '(空)',
    description: 'F178 Persistent MCP Agent-Key Auth — 共享密钥（直接环境变量提供）',
    category: 'server',
    sensitive: true,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_AGENT_KEY_FILE',
    defaultValue: '(空)',
    description: 'F178 Persistent MCP Agent-Key Auth — 密钥文件路径（CAT_CAFE_AGENT_KEY_SECRET 的备选）',
    category: 'server',
    sensitive: true,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_AGENT_KEY_FILES',
    defaultValue: '(空)',
    description: 'F178 Persistent MCP Agent-Key Auth — catId 到密钥文件路径的 JSON 映射（Antigravity variants）',
    category: 'server',
    sensitive: true,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_HOOK_TOKEN',
    defaultValue: '(空)',
    description: 'Hook 回调鉴权 token',
    category: 'server',
    sensitive: true,
  },
  {
    name: 'CAT_CAFE_TEST_SANDBOX',
    defaultValue: '(未设置)',
    description: '测试沙盒写保护开关（仅测试/门禁使用）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    defaultValue: '(未设置)',
    description: '测试沙盒临时允许写入非隔离根目录（仅测试调试使用）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_TEST_REAL_HOME',
    defaultValue: '(未设置)',
    description: '测试真实 HOME 路径快照（用于阻止测试写回宿主 HOME）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'RUNTIME_REPO_PATH',
    defaultValue: '(未设置)',
    description: 'Runtime 仓库路径（自动更新用）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'WORKSPACE_LINKED_ROOTS',
    defaultValue: '(未设置)',
    description: '工作区关联的项目根（冒号分隔）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'HYPERFOCUS_THRESHOLD_MS',
    defaultValue: '5400000 (90分钟)',
    description: 'Hyperfocus 健康提醒阈值',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'Anthropic API Key（#340 P6: 由统一账户系统管理，不再从 .env 读取）',
    category: 'server',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'LOG_LEVEL',
    defaultValue: 'info',
    description: '日志级别（debug / info / warn / error）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'LOG_DIR',
    defaultValue: './data/logs/api',
    description: 'API 日志目录（Pino 滚动日志写入路径）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'DEBUG',
    defaultValue: 'false',
    description: '调试模式开关（详细日志，非生产环境用）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MCP_SERVER_PORT',
    defaultValue: '3011',
    description: 'MCP Server 监听端口',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'PREVIEW_GATEWAY_ENABLED',
    defaultValue: '1（启用）',
    description: '设为 0 禁用 Preview Gateway（F120）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'GAME_NARRATOR_ENABLED',
    defaultValue: '(未设置 → 不启用)',
    description: '设为 true 启用游戏叙述者模式',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'WEB_PUBLIC_DIR',
    defaultValue: '../web/public',
    description: 'Web 前端静态文件目录（connector gateway 静态资源服务）',
    category: 'server',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CONFIG_ROOT',
    defaultValue: '(未设置 → 使用 cwd)',
    description: '平台配置根目录（与 cwd 解耦，平台启动脚本设置）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    defaultValue: '(未设置 → homedir())',
    description: '全局配置根目录（accounts / credentials 查找路径的父目录，实际路径为 ${ROOT}/.cat-cafe/）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
    defaultValue: '0',
    description: '跳过 homedir credentials / legacy provider profiles 迁移（新安装或 opensource profile 可显式关闭）',
    category: 'server',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'ALLOWED_WORKSPACE_DIRS',
    defaultValue: '(未设置)',
    description: 'MCP Server 允许访问的工作目录列表（逗号分隔）',
    category: 'server',
    sensitive: false,
    exampleRecommended: true,
  },
  {
    name: 'CAT_CAFE_RUNTIME_ROOT',
    defaultValue: '(未设置 → process.cwd())',
    description:
      'F061: Clowder AI runtime 二进制根目录（runtime startup 自动 export 为 $RUNTIME_DIR），优先级高于 capability orchestrator 的 auto-detection，用于 Antigravity MCP config args 路径',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_WORKSPACE_ROOT',
    defaultValue: '(未设置 → process.cwd())',
    description:
      'F061: Bengal MCP 工具的 workspace 根目录（runtime startup 自动 export 为 $PROJECT_DIR），用于 Antigravity MCP config 的 ALLOWED_WORKSPACE_DIRS env 注入',
    category: 'server',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- storage ---
  {
    name: 'REDIS_URL',
    defaultValue: '(未设置 → 内存模式)',
    description: 'Redis 连接地址',
    category: 'storage',
    sensitive: false,
    maskMode: 'url',
    runtimeEditable: false,
    exampleRecommended: true,
  },
  {
    name: 'REDIS_KEY_PREFIX',
    defaultValue: 'cat-cafe:',
    description: 'Redis key 命名空间前缀，用于多实例隔离',
    category: 'storage',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'MEMORY_STORE',
    defaultValue: '(未设置)',
    description: '设为 1 显式允许内存模式',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'MESSAGE_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description:
      '消息过期时间（秒）。默认 604800（7天）。设为 0 或负数 → 消息永不过期。注意：过期的 Redis 消息不影响已索引的 evidence_passages（Phase I 保证永久性）。',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'THREAD_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '对话过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'TASK_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '任务过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'SUMMARY_TTL_SECONDS',
    defaultValue: '604800 (7天)',
    description: '摘要过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'BACKLOG_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: 'Backlog 过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'DRAFT_TTL_SECONDS',
    defaultValue: '(无过期)',
    description: '草稿过期时间',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_ORPHAN_DRAFT_CLEANUP_GRACE_MS',
    defaultValue: '30000',
    description: '孤立 streaming draft 的启动宽限时间（毫秒）',
    category: 'storage',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TRANSCRIPT_DATA_DIR',
    defaultValue: './data/transcripts',
    description: 'Session transcript 存储目录',
    category: 'storage',
    sensitive: false,
  },
  {
    name: 'DOCS_ROOT',
    defaultValue: '{repoRoot}/docs',
    description: 'Docs 根目录路径（F102 记忆系统用）',
    category: 'storage',
    sensitive: false,
  },

  // --- budget ---
  {
    name: 'MAX_PROMPT_CHARS',
    defaultValue: '(per-cat 默认)',
    description: '全局 prompt 字符上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_OPUS_MAX_PROMPT_CHARS',
    defaultValue: '150000',
    description: '布偶猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CODEX_MAX_PROMPT_CHARS',
    defaultValue: '80000',
    description: '缅因猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_GEMINI_MAX_PROMPT_CHARS',
    defaultValue: '150000',
    description: '暹罗猫 prompt 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MAX_CONTEXT_MSG_CHARS',
    defaultValue: '1500',
    description: '单条消息上下文截断',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'MAX_A2A_DEPTH',
    defaultValue: '15',
    description: 'A2A 猫猫互调最大深度',
    category: 'a2a',
    sensitive: false,
  },
  {
    name: 'A2A_ENABLED',
    defaultValue: 'true',
    description: 'A2A 猫猫互调总开关',
    category: 'a2a',
    sensitive: false,
  },
  {
    name: 'GOVERNANCE_DEGRADATION_ENABLED',
    defaultValue: 'true',
    description: '降级策略总开关',
    category: 'governance',
    sensitive: false,
  },
  {
    name: 'GOVERNANCE_DONE_TIMEOUT_MS',
    defaultValue: '300000',
    description: 'Done 超时（毫秒）',
    category: 'governance',
    sensitive: false,
  },
  {
    name: 'GOVERNANCE_HEARTBEAT_INTERVAL_MS',
    defaultValue: '30000',
    description: 'Heartbeat 间隔（毫秒）',
    category: 'governance',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_COMPLETE_MESSAGE_DELIVERY',
    defaultValue: '0',
    description: '完整消息投递模式开关；开启后流式文本聚合到 done 时再统一投递。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_AGENT_OUTPUT_GATE',
    defaultValue: '1',
    description: 'Agent 输出闸门；默认过滤 CLI 过程噪音，仅保留适合用户阅读的最终输出。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_CODEX_OUTPUT_GATE',
    defaultValue: '1',
    description: 'Codex 输出闸门；默认开启，用于减少 Codex 运行过程 chatter 外溢。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_PARALLEL_DISPATCH',
    defaultValue: '0',
    description: '队列并行调度开关；开启后同一 thread 内不同空闲猫槽可并行启动。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CONTEXT_CACHE_LAYOUT',
    defaultValue: 'v1',
    description:
      'ADR-024 KV-cache 友好上下文布局开关：v1（默认，与现状字节级一致，零风险）/ v2（四槽布局 [STATIC SYSTEM]→[HISTORY]→[META]→[CURRENT MSG]，把 session 内会写的记忆/lessons/项目/每轮 meta 下放队尾 meta 块以保住历史前缀缓存）。金丝雀灰度用；异常一键回 v1。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
    exampleRecommended: true,
  },
  {
    name: 'CLOWDER_THREAD_FIRST_DEFAULT',
    defaultValue: '(未设置)',
    description:
      '批次2 thread-first 路由的全局默认开关：置 1 时全部频道语义 thread（非 DM、非分支，含新建频道）默认启用 thread-first（@猫的回复进消息锚定分支，主频道只留源消息）。thread 显式 routingPolicy 优先。体感不对置 0 即全局回退。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CONTEXT_CACHE_LAYOUT_CATS',
    defaultValue: '(未设置)',
    description:
      'ADR-024 金丝雀名单（验证计划 2）：逗号分隔的 catId。全局 CONTEXT_CACHE_LAYOUT 为 v1 时，名单内的猫单独走 v2 布局（如 "kimi" 灰度 24-48h）；全局 v2 时忽略本名单。空值 = 无金丝雀。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_MESSAGE_BATCHING_THREADS',
    defaultValue: '(未设置)',
    description: '消息批量投递灰度线程白名单，逗号分隔；空值表示关闭。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
    exampleRecommended: true,
  },
  {
    name: 'CAT_CAFE_MESSAGE_BATCH_WINDOW_MS',
    defaultValue: '10000',
    description: '消息批量投递固定窗口（毫秒），运行时限制为 5000-10000。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
    exampleRecommended: true,
  },
  {
    name: 'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
    defaultValue: '0',
    description: '本地个人 Skill 库开关；开启后通过注册制 index 暴露只读个人技能集合。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_PERSONAL_SKILL_ROOTS',
    defaultValue: '~/.claude/skills',
    description: '本地个人 Skill 根目录，逗号分隔；默认只扫描顶层 skill 和 gstack/<skill>。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
    defaultValue:
      'create-prd,product-strategy,business-model,competitor-analysis,competitive-battlecard,customer-journey-map,market-sizing,pricing-strategy,user-personas,value-proposition,design-review,high-end-visual-design,image-to-code,opencli-usage,opencli-browser,gstack,investigate,qa,review,make-pdf',
    description: '默认显示在技能面板的个人 Skill 名称，逗号分隔；自动路由仍只注入命中的少量技能。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_PERSONAL_SKILL_VISIBLE_ALL',
    defaultValue: '0',
    description: '个人 Skill 全可见开关；开启后 index 中所有扫到的个人 Skill 都进入面板/检索。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
    defaultValue: '.cat-cafe/personal-skills-index.json',
    description: '个人 Skill 注册索引文件路径；相对路径按项目根目录解析。',
    category: 'governance',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_MODEL_DISCOVERY_ANTHROPIC_URL',
    defaultValue: '(未设置 → 不启用远程发现，回退静态清单)',
    description:
      '本地 CLI 模型扫描第 4 来源（远程模型清单）：Anthropic 兼容网关的 /v1/models 地址，用于把网关当前实际提供的模型（如刚发布的新模型）合并进 claude 候选，不必等代码里的静态清单手动更新。仅在显式设置时才请求，3 秒超时，未配置或请求失败一律静默回退静态清单，扫描不会因此报错；扫描本身依旧绝不读取任何凭证文件。示例（本机 CLIProxyAPI 网关）：CLOWDER_MODEL_DISCOVERY_ANTHROPIC_URL=http://127.0.0.1:8317/v1/models',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_MODEL_DISCOVERY_ANTHROPIC_KEY',
    defaultValue: '(未设置 → 请求不带鉴权头)',
    description:
      '配合 CLOWDER_MODEL_DISCOVERY_ANTHROPIC_URL 使用的可选 Bearer key；仅在这里显式提供时才会被使用，绝不从凭证文件（如 ~/.claude、CLIProxyAPI 配置文件）读取。网关部署在本机且鉴权已在网关侧完成时通常无需设置。',
    category: 'governance',
    sensitive: true,
    runtimeEditable: true,
  },
  {
    name: 'MAX_PROMPT_TOKENS',
    defaultValue: '(未设置)',
    description: '全局 prompt token 上限',
    category: 'budget',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'WEB_PUSH_TIMEOUT_MS',
    defaultValue: '(未设置)',
    description: 'Web Push 超时时间',
    category: 'budget',
    sensitive: false,
  },

  // --- cli ---
  {
    name: 'CLI_TIMEOUT_MS',
    defaultValue: DEFAULT_CLI_TIMEOUT_LABEL,
    description: 'CLI 调用超时',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_TEMPLATE_PATH',
    defaultValue: '(repo 根 cat-template.json)',
    description: '猫猫模板文件路径',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'DEFAULT_CAT_ID',
    defaultValue: '(cat-config 第一个 breed)',
    description: '默认猫猫 ID（覆盖 cat-config 里的顺序）',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_MCP_SERVER_PATH',
    defaultValue: '(自动检测)',
    description: 'MCP Server 路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'AUDIT_LOG_DIR',
    defaultValue: './data/audit-logs',
    description: '审计日志目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CLI_RAW_ARCHIVE_DIR',
    defaultValue: './data/cli-raw-archive',
    description: 'CLI 原始日志归档目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS',
    defaultValue: 'false',
    description: '审计日志包含 prompt 片段',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS',
    defaultValue: '1000,2000,4000',
    description: 'Branch 回滚重试间隔',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'MODE_SWITCH_REQUIRES_APPROVAL',
    defaultValue: 'true',
    description: '模式切换需要确认',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_TMUX_AGENT',
    defaultValue: '(未设置)',
    description: '设为 1 启用 tmux agent 模式',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_TMUX_PATH',
    defaultValue: '(未设置)',
    description: 'Tmux 可执行文件路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_DATA_DIR',
    defaultValue: '(未设置)',
    description: '数据目录根路径',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_SESSION_MUTEX_WAIT_TIMEOUT_MS',
    defaultValue: '90000',
    description: 'Session 并发锁等待超时（毫秒），超时后拒绝并发调用',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_A2A_ROUTING_MODE',
    defaultValue: 'legacy',
    description: 'A2A 路由模式：legacy（旧版串行）或 slock（新版并发）',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_SKILL_MANIFEST_PATH',
    defaultValue: '(~/.cat-cafe/skills-manifest.json)',
    description: 'Skills manifest 文件路径覆盖',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_TOKEN',
    defaultValue: '(未设置)',
    description: 'Callback 鉴权 token',
    category: 'cli',
    sensitive: true,
  },
  {
    name: 'CAT_CAFE_FRESHNESS_HOLD_ENABLED',
    defaultValue: 'false',
    description: 'F193 Freshness Hold 总开关；仅 true 启用，可立即回滚',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_FRESHNESS_HOLD_CATS',
    defaultValue: '(全部)',
    description: 'F193 猫灰度白名单，逗号分隔；空值表示全部',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_FRESHNESS_HOLD_THREADS',
    defaultValue: '(全部)',
    description: 'F193 线程灰度白名单，逗号分隔；空值表示全部',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_ENABLED',
    defaultValue: 'true',
    description: 'Callback outbox 是否启用',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_DIR',
    defaultValue: '(自动)',
    description: 'Callback outbox 目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS',
    defaultValue: '(默认)',
    description: 'Outbox 最大重试次数',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH',
    defaultValue: '(默认)',
    description: 'Outbox 单次 flush 批量',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CALLBACK_RETRY_DELAYS_MS',
    defaultValue: '(默认)',
    description: 'Callback 重试间隔（逗号分隔）',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CDP_DEBUG',
    defaultValue: '(未设置)',
    description: 'CDP Bridge 调试模式',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CODEX_HOME',
    defaultValue: '~/.codex',
    description: 'Codex CLI home 目录',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'ANTIGRAVITY_BRAIN_HOME',
    defaultValue: '~/.gemini/antigravity/brain',
    description: 'Antigravity built-in generate_image brain dir (F172 Phase G scanner)',
    category: 'cli',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_API_URL',
    defaultValue: 'http://localhost:3004',
    description: 'API 服务地址（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CLOWDER_API_BEARER_TOKEN',
    defaultValue: '(未设置 → 保持单用户兼容模式)',
    description: 'API 全局 Bearer 兜底鉴权；API/Web/Agent 进程必须共享同一服务端密钥',
    category: 'server',
    sensitive: true,
    restartRequired: true,
    runtimeEditable: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_INVOCATION_ID',
    defaultValue: '(运行时注入)',
    description: '当前 invocation ID（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_CAT_ID',
    defaultValue: '(运行时注入)',
    description: '当前猫 ID（由 API 进程注入 MCP Server 子进程 env）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_DIAGNOSTICS',
    defaultValue: '(未设置)',
    description: '设为 1 启用 /api/diagnostics/* 端点（调试用，默认关闭）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT',
    defaultValue: '(未设置)',
    description: '设为 1 跳过 shared state preflight 检查（CI / 调试用）',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CAT_CAFE_PREFLIGHT_TIMEOUT_MS',
    defaultValue: '30000',
    description: 'Pre-flight 操作（Redis/store 读取）的超时毫秒数，超时后降级到无 session 模式',
    category: 'cli',
    sensitive: false,
    hubVisible: false,
  },

  // --- proxy ---
  {
    name: 'ANTHROPIC_PROXY_ENABLED',
    defaultValue: '1',
    description: 'Anthropic 代理网关开关（0 关闭）',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_PORT',
    defaultValue: '9877',
    description: '代理网关监听端口',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_DEBUG',
    defaultValue: '(未设置)',
    description: '设为 1 启用代理调试日志',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'ANTHROPIC_PROXY_UPSTREAMS_PATH',
    defaultValue: '.cat-cafe/proxy-upstreams.json',
    description: 'upstream 配置文件路径（解决 runtime 与源码分离问题）',
    category: 'proxy',
    sensitive: false,
  },
  {
    name: 'HTTPS_PROXY',
    defaultValue: '(未设置)',
    description: 'HTTPS 代理地址（Web Push / 外部 HTTP 请求用）',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'HTTP_PROXY',
    defaultValue: '(未设置)',
    description: 'HTTP 代理地址',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'ALL_PROXY',
    defaultValue: '(未设置)',
    description: '通用代理地址（HTTP/HTTPS/SOCKS 通用 fallback）',
    category: 'proxy',
    sensitive: false,
    hubVisible: false,
  },

  // --- connector ---
  {
    name: 'TELEGRAM_BOT_TOKEN',
    defaultValue: '(未设置 → 不启用)',
    description: 'Telegram Bot Token',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
    group: 'connector-telegram',
  },
  {
    name: 'FEISHU_APP_ID',
    defaultValue: '(未设置 → 不启用)',
    description: '飞书应用 App ID',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
    group: 'connector-feishu',
    dependencies: ['FEISHU_APP_SECRET'],
  },
  {
    name: 'FEISHU_APP_SECRET',
    defaultValue: '(未设置)',
    description: '飞书应用 App Secret',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
    group: 'connector-feishu',
    dependencies: ['FEISHU_APP_ID'],
  },
  {
    name: 'FEISHU_VERIFICATION_TOKEN',
    defaultValue: '(未设置)',
    description: '飞书 webhook 验证 token（仅 webhook 模式需要）',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
    group: 'connector-feishu',
  },
  {
    name: 'FEISHU_CONNECTION_MODE',
    defaultValue: 'webhook',
    description: '飞书连接模式：webhook（需公网 URL）或 websocket（长连接，无需公网）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
    group: 'connector-feishu',
  },
  {
    name: 'DINGTALK_APP_KEY',
    defaultValue: '(未设置 → 不启用)',
    description: '钉钉应用 AppKey',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
    group: 'connector-dingtalk',
    dependencies: ['DINGTALK_APP_SECRET'],
  },
  {
    name: 'DINGTALK_APP_SECRET',
    defaultValue: '(未设置)',
    description: '钉钉应用 AppSecret',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
    group: 'connector-dingtalk',
    dependencies: ['DINGTALK_APP_KEY'],
  },
  {
    name: 'XIAOYI_AK',
    defaultValue: '(未设置 → 不启用)',
    description: '华为小艺 OpenClaw Access Key',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'XIAOYI_SK',
    defaultValue: '(未设置)',
    description: '华为小艺 OpenClaw Secret Key',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
  },
  {
    name: 'XIAOYI_AGENT_ID',
    defaultValue: '(未设置)',
    description: '华为小艺 Agent ID',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'FEISHU_BOT_OPEN_ID',
    defaultValue: '(未设置)',
    description: '飞书机器人 Open ID（接收消息的 bot 身份标识）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'FEISHU_ADMIN_OPEN_IDS',
    defaultValue: '(未设置)',
    description: '飞书管理员 Open ID 列表（逗号分隔）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'WEIXIN_VOICE_ITEM_MODE',
    defaultValue: 'minimal',
    description:
      '微信语音消息 voice_item 模式（minimal/playtime/playtime-sec，危险实验模式见 WEIXIN_ENABLE_UNSAFE_VOICE_MODES）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
    defaultValue: '0',
    description:
      '是否允许危险语音实验模式（1=允许 playtime-encode/metadata，0=自动回退 playtime，避免“语音完全收不到”）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
    defaultValue: '0',
    description: '是否抓取入站微信语音媒体（1=把 voice media 当文件附件落盘，便于 SILK 二进制对比；0=保持当前行为）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'WEIXIN_BOT_TOKEN',
    defaultValue: '(未设置 → 不启用)',
    description: '微信机器人 Token（F137 微信个人网关）',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
    group: 'connector-wechat',
  },
  {
    name: 'WECOM_BOT_ID',
    defaultValue: '(未设置 → 不启用智能机器人模式)',
    description: '企业微信智能机器人 Bot ID（WebSocket 长连接模式）',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
    dependencies: ['WECOM_BOT_SECRET'],
  },
  {
    name: 'WECOM_BOT_SECRET',
    defaultValue: '(未设置)',
    description: '企业微信智能机器人 Bot Secret',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
    dependencies: ['WECOM_BOT_ID'],
  },
  {
    name: 'WECOM_CORP_ID',
    defaultValue: '(未设置 → 不启用自建应用模式)',
    description: '企业微信企业 ID（自建应用 HTTP 回调模式）',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
  },
  {
    name: 'WECOM_AGENT_ID',
    defaultValue: '(未设置)',
    description: '企业微信自建应用 AgentId',
    category: 'connector',
    sensitive: false,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
  },
  {
    name: 'WECOM_AGENT_SECRET',
    defaultValue: '(未设置)',
    description: '企业微信自建应用 Secret',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
  },
  {
    name: 'WECOM_TOKEN',
    defaultValue: '(未设置)',
    description: '企业微信回调 Token（HTTP 模式验签）',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
  },
  {
    name: 'WECOM_ENCODING_AES_KEY',
    defaultValue: '(未设置)',
    description: '企业微信回调 EncodingAESKey（43字符，HTTP 模式解密用）',
    category: 'connector',
    sensitive: true,
    exampleRecommended: true,
    restartRequired: true,
    group: 'connector-wecom',
  },

  // --- GitHub Repo Inbox (F141) ---
  {
    name: 'GITHUB_WEBHOOK_SECRET',
    defaultValue: '(未设置 → 不启用)',
    description: 'GitHub webhook HMAC-SHA256 shared secret（F141 Repo Inbox）',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
  },
  {
    name: 'GITHUB_REPO_ALLOWLIST',
    defaultValue: '(未设置)',
    description: '允许的仓库列表，逗号分隔（如 zts212653/clowder-ai）',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'GITHUB_REPO_INBOX_CAT_ID',
    defaultValue: '(未设置)',
    description: '接收 Repo Inbox 事件的猫 ID',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'GITHUB_AUTHORITATIVE_REVIEW_LOGINS',
    defaultValue: 'chatgpt-codex-connector[bot]',
    description:
      '[DEPRECATED] F140 Phase E.2 cutover (2026-04-24): Rule B authoritative-source skip removed; this var now only serves as backward-compat fallback for GITHUB_SETUP_NOISE_BOT_LOGINS. Will be removed in a follow-up release.',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
    defaultValue: 'chatgpt-codex-connector[bot]',
    description:
      'Comma-separated GitHub bot logins whose conversation comments may contain Codex setup-only guidance. F140 polling-side setup-noise filter skips those (bot + conversation + setup-only body, no codex review content). Falls back to GITHUB_AUTHORITATIVE_REVIEW_LOGINS for backward compat.',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },
  {
    name: 'GITHUB_TOKEN',
    defaultValue: '(未设置)',
    description: 'GitHub Personal Access Token（Scheduler 仓库活跃度模板 HTTP 请求鉴权）',
    category: 'connector',
    sensitive: true,
    restartRequired: true,
  },

  // --- codex ---
  {
    name: 'CAT_CODEX_SANDBOX_MODE',
    defaultValue: 'danger-full-access',
    description: '缅因猫沙箱模式',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'CAT_CODEX_APPROVAL_POLICY',
    defaultValue: 'on-request',
    description: '缅因猫审批策略',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'CODEX_AUTH_MODE',
    defaultValue: 'oauth',
    description: '缅因猫认证方式 (oauth/api_key)',
    category: 'codex',
    sensitive: false,
  },
  {
    name: 'OPENAI_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'OpenAI API Key（#340 P6: 由统一账户系统管理，子进程通过 callbackEnv 注入）',
    category: 'codex',
    sensitive: true,
  },

  // --- dare ---
  { name: 'DARE_ADAPTER', defaultValue: 'openrouter', description: '狸花猫适配器', category: 'dare', sensitive: false },
  { name: 'DARE_PATH', defaultValue: '(未设置)', description: 'Dare CLI 路径', category: 'dare', sensitive: false },

  // --- gemini ---
  {
    name: 'GOOGLE_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'Google API Key（#340 P6: 由统一账户系统管理，子进程通过 callbackEnv 注入）',
    category: 'gemini',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'GEMINI_ADAPTER',
    defaultValue: 'gemini-cli',
    description: '暹罗猫适配器 (gemini-cli/antigravity)',
    category: 'gemini',
    sensitive: false,
  },

  // --- kimi ---
  {
    name: 'MOONSHOT_API_KEY',
    defaultValue: '(未设置)',
    description: 'Kimi / Moonshot API Key（官方 kimi-cli API Key 模式用）',
    category: 'kimi',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'KIMI_SHARE_DIR',
    defaultValue: '~/.kimi',
    description: '官方 kimi-cli 共享目录（session / mcp / logs）',
    category: 'kimi',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'KIMI_CONFIG_FILE',
    defaultValue: '~/.kimi/config.toml',
    description: '官方 kimi-cli 配置文件路径（覆盖默认 ~/.kimi/config.toml）',
    category: 'kimi',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'KIMI_AUTH_TOKEN',
    defaultValue: '(未设置)',
    description: 'Kimi 官方额度抓取用的 kimi-auth token（来自 kimi.com）',
    category: 'quota',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'KIMI_QUOTA_API_FALLBACK_ENABLED',
    defaultValue: '0（默认关闭）',
    description: '设为 1 允许 Kimi 额度在 CLI /usage 失败时降级到 API（仍需 KIMI_AUTH_TOKEN）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },

  // --- grok ---
  {
    name: 'XAI_API_KEY',
    defaultValue: '(未设置 → 由 accounts/credentials 系统注入)',
    description: 'xAI API Key（Grok CLI API Key 模式用）',
    category: 'grok',
    sensitive: true,
    hubVisible: false,
  },
  {
    name: 'GROK_HOME',
    defaultValue: '~/.grok',
    description: 'Grok CLI 共享目录（sessions 与订阅态凭证来源）',
    category: 'grok',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'GROK_AUTH_PATH',
    defaultValue: '~/.grok/auth.json',
    description: 'Grok subscription 模式 auth.json 路径',
    category: 'grok',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },

  // --- tts ---
  {
    name: 'TTS_URL',
    defaultValue: 'http://localhost:9879',
    description: 'TTS 服务地址（由 Service Manifest 管理）',
    category: 'tts',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'TTS_CACHE_DIR',
    defaultValue: './data/tts-cache',
    description: 'TTS 音频缓存目录',
    category: 'tts',
    sensitive: false,
  },
  {
    name: 'GENSHIN_VOICE_DIR',
    defaultValue: '~/projects/.../genshin',
    description: 'GPT-SoVITS 角色模型目录',
    category: 'tts',
    sensitive: false,
    deprecated: '使用 CHARACTER_VOICE_DIR 替代（优先级更高，支持多角色目录）',
  },
  {
    name: 'CHARACTER_VOICE_DIR',
    defaultValue: '(未设置 → dirname(GENSHIN_VOICE_DIR))',
    description: '角色语音模型根目录（优先级高于 GENSHIN_VOICE_DIR）',
    category: 'tts',
    sensitive: false,
  },

  // --- stt (managed by Service Manifest) ---
  {
    name: 'WHISPER_URL',
    defaultValue: 'http://localhost:9876',
    description: 'Whisper STT 服务地址（由 Service Manifest 管理）',
    category: 'tts',
    sensitive: false,
    hubVisible: false,
  },

  // --- service management ---
  {
    name: 'CAT_CAFE_SERVICES_CONFIG',
    defaultValue: '.cat-cafe/services.json',
    description: '本地服务状态配置文件路径',
    category: 'server',
    sensitive: false,
    hubVisible: false,
  },

  // --- connector media ---
  {
    name: 'CONNECTOR_MEDIA_DIR',
    defaultValue: './data/connector-media',
    description: '连接器媒体下载目录',
    category: 'connector',
    sensitive: false,
    restartRequired: true,
  },

  // --- frontend ---
  {
    name: 'NEXT_PUBLIC_API_URL',
    defaultValue: 'http://localhost:3004',
    description: '前端连接的 API 地址',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_PROJECT_ROOT',
    defaultValue: '(空)',
    description: '前端项目根路径',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI',
    defaultValue: '(未设置)',
    description: '设为 1 跳过文件变更 UI',
    category: 'frontend',
    sensitive: false,
    runtimeEditable: false,
  },

  // --- push ---
  {
    name: 'VAPID_PUBLIC_KEY',
    defaultValue: '(未设置 → 推送不可用)',
    description: 'VAPID 公钥 (Web Push)',
    category: 'push',
    sensitive: false,
  },
  {
    name: 'VAPID_PRIVATE_KEY',
    defaultValue: '(未设置)',
    description: 'VAPID 私钥 (Web Push)',
    category: 'push',
    sensitive: true,
  },
  {
    name: 'VAPID_SUBJECT',
    defaultValue: 'mailto:cat-cafe@localhost',
    description: 'VAPID 联系方式 (mailto: 或 URL)',
    category: 'push',
    sensitive: false,
  },

  // --- signal ---
  {
    name: 'SIGNALS_ROOT_DIR',
    defaultValue: '(未设置)',
    description: 'Signal 信号源数据目录',
    category: 'signal',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_SIGNAL_USER',
    defaultValue: 'codex',
    description: 'Signal 默认执行猫',
    category: 'signal',
    sensitive: false,
  },

  // --- github_review ---
  {
    name: 'GITHUB_REVIEW_IMAP_USER',
    defaultValue: '(未设置 → 监控不启用)',
    description: 'QQ 邮箱地址 (xxx@qq.com)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PASS',
    defaultValue: '(未设置)',
    description: 'QQ 邮箱授权码 (非登录密码)',
    category: 'github_review',
    sensitive: true,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_HOST',
    defaultValue: 'imap.qq.com',
    description: 'IMAP 服务器地址',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PORT',
    defaultValue: '993',
    description: 'IMAP 端口 (SSL)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_REVIEW_POLL_INTERVAL_MS',
    defaultValue: '120000',
    description: '邮件轮询间隔 (毫秒)',
    category: 'github_review',
    sensitive: false,
  },
  {
    name: 'GITHUB_MCP_PAT',
    defaultValue: '(未设置)',
    description: 'GitHub Personal Access Token (MCP 用)',
    category: 'github_review',
    sensitive: true,
    runtimeEditable: true,
  },
  {
    name: 'GITHUB_REVIEW_IMAP_PROXY',
    defaultValue: '(未设置)',
    description: 'IMAP 连接代理地址（如 socks5://127.0.0.1:1080）',
    category: 'github_review',
    sensitive: false,
  },

  // --- evidence (F102 记忆系统) ---
  {
    name: 'EMBED_MODE',
    defaultValue: 'off',
    description: '向量检索模式 (off/shadow/on)，on = 开启 Qwen3 embedding rerank',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_ABSTRACTIVE',
    defaultValue: 'off',
    description: 'Phase G 摘要调度器 (off/on)，on = 定时调用摘要模型做 thread 摘要',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'CAT_CAFE_CONTENT_FREE_INBOX_THREADS',
    defaultValue: '(未设置)',
    description: 'F004 二期 content-free inbox canary thread allowlist，逗号分隔；* 表示全量',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_DELIVERY_ONLY_THREADS',
    defaultValue: '(未设置)',
    description: 'F004 二期 deliveryOnly canary thread allowlist，逗号分隔；* 表示全量',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS',
    defaultValue: '(未设置)',
    description: '历史治理 canary thread allowlist，逗号分隔；摘要线程未单设时也作为 fallback',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_PROJECT_CONTEXT_IDS',
    defaultValue: '(未设置)',
    description: '注入 prompt 的 durable project progress ID 列表，逗号分隔',
    category: 'evidence',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE',
    defaultValue: '0',
    description: '设为 1 禁止 invocation 完成后自动更新 Agent MEMORY',
    category: 'evidence',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_COLLECTION_SECRET_QUARANTINE',
    defaultValue: '0',
    description: '设为 1 时将命中 secret 的 collection 文件隔离，而非阻断全部安全文件索引',
    category: 'evidence',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'CAT_CAFE_SUMMARY_COMPACTION_THREADS',
    defaultValue: '(未设置)',
    description:
      'Phase G 摘要线程 allowlist，逗号分隔；未设置时复用 CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS，避免误开全量摘要',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_PROVIDER',
    defaultValue: 'anthropic-api',
    description: 'Phase G 摘要生成 provider：anthropic-api、codex-cli 或 pi-cli',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_CODEX_CAT_ID',
    defaultValue: 'gpt52',
    description: 'CAT_CAFE_SUMMARY_PROVIDER=codex-cli 时使用的本地 Codex 成员 ID',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_CODEX_MODEL',
    defaultValue: 'gpt-5.5',
    description: 'CAT_CAFE_SUMMARY_PROVIDER=codex-cli 时的 Codex CLI 摘要模型',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_CODEX_TIMEOUT_MS',
    defaultValue: '90000',
    description: 'CAT_CAFE_SUMMARY_PROVIDER=codex-cli 时单次摘要生成超时，默认 90 秒',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_PI_CAT_ID',
    defaultValue: 'pi',
    description: 'CAT_CAFE_SUMMARY_PROVIDER=pi-cli 时使用的本地 Pi 成员 ID',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_PI_MODEL',
    defaultValue: 'mimo/mimo-v2.5-pro-ultraspeed',
    description:
      'CAT_CAFE_SUMMARY_PROVIDER=pi-cli 时的 Pi CLI 摘要模型；显式默认避免摘要调度器早于 CatRegistry 初始化时报错',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CAT_CAFE_SUMMARY_PI_TIMEOUT_MS',
    defaultValue: '90000',
    description: 'CAT_CAFE_SUMMARY_PROVIDER=pi-cli 时单次摘要生成超时，默认 90 秒',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F102_DURABLE_CANDIDATES',
    defaultValue: 'off',
    description: 'Phase G candidate 提取 (off/on)，on = 摘要时提取 durable knowledge 候选到 MarkerQueue',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_TOPIC_SEGMENTS',
    defaultValue: 'off',
    description: 'Phase G topic 分段 (off/on)，on = 摘要按话题切分多个 segment',
    category: 'evidence',
    sensitive: false,
  },
  // --- F163 记忆熵减实验框架 ---
  {
    name: 'F163_AUTHORITY_BOOST',
    defaultValue: 'off',
    description: 'F163 authority 加权 rerank (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_ALWAYS_ON_INJECTION',
    defaultValue: 'off',
    description: 'F163 constitutional 物理注入 (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_RETRIEVAL_RERANK',
    defaultValue: 'off',
    description: 'F163 多轴元数据 rerank (off/shadow/on)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_COMPRESSION',
    defaultValue: 'off',
    description: 'F163 非替代式压缩 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_PROMOTION_GATE',
    defaultValue: 'off',
    description: 'F163 晋升门禁 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_CONTRADICTION_DETECTION',
    defaultValue: 'off',
    description: 'F163 矛盾检测 (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'F163_REVIEW_QUEUE',
    defaultValue: 'off',
    description: 'F163 审计 review queue (off/suggest/apply)',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'EMBED_URL',
    defaultValue: 'http://127.0.0.1:9880',
    description: 'Embedding 服务地址（由 Service Manifest 管理）',
    category: 'evidence',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'EMBED_PORT',
    defaultValue: '9880',
    description: 'Embedding 服务端口（由 Service Manifest 管理）',
    category: 'evidence',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'EVIDENCE_DB',
    defaultValue: '{repoRoot}/evidence.sqlite',
    description: 'F102 SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'GLOBAL_KNOWLEDGE_DB',
    defaultValue: '~/.cat-cafe/global_knowledge.sqlite',
    description: 'F-4: 全局知识 SQLite 路径（Skills + MEMORY.md 编译产物）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'OBSIDIAN_READONLY_ROOTS',
    defaultValue: '(未设置)',
    description:
      'Obsidian 只读知识库根目录，逗号或换行分隔；可写成 domain:orbitos-knowledge=/path/to/400知识库。仅写 Clowder 索引缓存，不写 vault 原文。',
    category: 'evidence',
    sensitive: false,
    restartRequired: true,
    exampleRecommended: true,
  },
  {
    name: 'WORLD_DB',
    defaultValue: '{repoRoot}/world.sqlite',
    description: 'F093 World Engine SQLite 数据库路径',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_BASE',
    defaultValue: '(未设置 → 摘要调度器不启用)',
    description: 'Phase G 摘要调度用的反代 API 地址（不是猫猫自己的 provider profile）',
    category: 'evidence',
    sensitive: false,
  },
  {
    name: 'F102_API_KEY',
    defaultValue: '(未设置)',
    description: 'Phase G 摘要调度用的反代 API Key',
    category: 'evidence',
    sensitive: true,
    runtimeEditable: true,
  },

  // --- quota ---
  {
    name: 'QUOTA_OFFICIAL_REFRESH_ENABLED',
    defaultValue: '0（默认关闭）',
    description: '设为 1 允许官方额度抓取（Claude/Codex OAuth + Kimi auth token）',
    category: 'quota',
    sensitive: false,
  },
  {
    name: 'CLAUDE_CREDENTIALS_PATH',
    defaultValue: '~/.claude/.credentials.json',
    description: 'Claude OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
  },
  {
    name: 'CODEX_CREDENTIALS_PATH',
    defaultValue: '(未设置 → ~/.codex/credentials)',
    description: 'Codex OAuth credentials 文件路径（官方额度刷新用）',
    category: 'quota',
    sensitive: false,
    hubVisible: false,
  },

  // --- telemetry (F153) ---
  {
    name: 'TELEMETRY_DEBUG',
    defaultValue: '(未设置 → 关闭)',
    description:
      '设为 true 启用 ConsoleSpanExporter（UNREDACTED）。仅 NODE_ENV=development/test 生效，其他环境需额外设 TELEMETRY_DEBUG_FORCE=true',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_DEBUG_FORCE',
    defaultValue: '(未设置 → 关闭)',
    description: '生产环境强制启用 TELEMETRY_DEBUG 的安全覆写开关。仅限紧急排障',
    category: 'telemetry',
    sensitive: false,
    hubVisible: false,
    runtimeEditable: false,
  },
  {
    name: 'TELEMETRY_HMAC_SALT',
    defaultValue: '(dev/test 自动 fallback)',
    description: 'HMAC salt — 遥测系统 ID 伪名化用。生产环境必设，缺失则禁用 OTel',
    category: 'telemetry',
    sensitive: true,
  },
  {
    name: 'TELEMETRY_EXPORT_RAW_SYSTEM_IDS',
    defaultValue: '(未设置 → HMAC 伪名化)',
    description: '设为 1 跳过 HMAC，导出原始系统 ID（仅限自托管受控环境）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'PROMETHEUS_PORT',
    defaultValue: '9464',
    description: 'Prometheus /metrics 抓取端口',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    defaultValue: '(未设置 → 仅 Prometheus)',
    description: 'OTLP 导出端点（设置后同时推送 traces/metrics/logs 到该端点）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'OTEL_SDK_DISABLED',
    defaultValue: '(未设置 → 启用)',
    description: '设为 true 完全禁用 OTel SDK',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'TELEMETRY_ALERT_ERROR_RATE',
    defaultValue: '0.3',
    description: 'Burn-rate 告警：错误率阈值（0-1）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'TELEMETRY_ALERT_P95_LATENCY_S',
    defaultValue: '120',
    description: 'Burn-rate 告警：P95 延迟阈值（秒）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'TELEMETRY_ALERT_ACTIVE_INVOCATIONS',
    defaultValue: '50',
    description: 'Burn-rate 告警：活跃 invocation 数阈值',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'PROMPT_CAPTURE',
    defaultValue: 'off',
    description: 'Prompt X-Ray 开关（on=启用 canonical prompt 捕获）',
    category: 'telemetry',
    sensitive: false,
  },
  {
    name: 'PROMPT_CAPTURE_CATS',
    defaultValue: '(未设置 → 全部猫)',
    description: 'Prompt X-Ray 白名单：逗号分隔 catId（空=全部）',
    category: 'telemetry',
    sensitive: false,
  },
  // --- antigravity (F061 Bridge) ---
  {
    name: 'ANTIGRAVITY_PORT',
    defaultValue: '(未设置 → 自动发现)',
    description: 'Antigravity Language Server ConnectRPC 端口（覆盖自动发现）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'ANTIGRAVITY_CSRF_TOKEN',
    defaultValue: '(未设置 → 自动发现)',
    description: 'Antigravity Language Server CSRF Token（覆盖自动发现）',
    category: 'antigravity',
    sensitive: true,
  },
  {
    name: 'ANTIGRAVITY_TLS',
    defaultValue: 'true',
    description: 'Antigravity ConnectRPC 是否使用 TLS（默认 true）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'ANTIGRAVITY_AUTO_APPROVE',
    defaultValue: 'true',
    description: 'YOLO 模式：自动批准 Antigravity 待审批交互（设 false 关闭）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'ANTIGRAVITY_TRACE_RAW',
    defaultValue: '(未设置 → 关闭)',
    description: '设为 1 启用 Antigravity 原始轨迹 dump（rpc raw response + step shape snapshot）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'ANTIGRAVITY_NATIVE_EXECUTOR',
    defaultValue: '(未设置 → 开启)',
    description: '设为 0 关闭 Antigravity 原生 executeAndPush（回落到通用 submit 路径）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'CLOWDER_CAPABILITY_RECEIPT_MODE',
    defaultValue: 'off',
    description: 'A1 capability receipt rollout：off / observe / enforce；默认关闭',
    category: 'antigravity',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_CAPABILITY_RECEIPT_EXECUTOR_ALLOWLIST',
    defaultValue: '(空 → 不命中)',
    description: 'A1 精确 executor allowlist（逗号分隔；首个 canary 仅 antigravity.native.run_command）',
    category: 'antigravity',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_CAPABILITY_RECEIPT_CAT_ALLOWLIST',
    defaultValue: '(空 → 不命中)',
    description: 'A1 精确 catId allowlist（逗号分隔）',
    category: 'antigravity',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_CAPABILITY_RECEIPT_THREAD_ALLOWLIST',
    defaultValue: '(空 → 不命中)',
    description: 'A1 精确 threadId allowlist（逗号分隔）',
    category: 'antigravity',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_CAPABILITY_RECEIPT_EMERGENCY_BLOCK',
    defaultValue: '0',
    description: '设为 1 时，命中 A1 cohort 的 native run_command 紧急 fail-closed',
    category: 'antigravity',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CAT_CAFE_READONLY',
    defaultValue: '(未设置 → 全量注册)',
    description: 'MCP Server 只读模式：跳过 post_message 等写操作工具注册（Antigravity 持久 MCP 用）',
    category: 'antigravity',
    sensitive: false,
  },
  {
    name: 'CLOWDER_THREAD_FIRST_MIN_CHARS',
    defaultValue: '24',
    description:
      'thread-first 默认开时的轻量豁免阈值：消息去掉 @提及后正文 ≤ 该字符数且无附件、非 As Task 时，回复走主频道内联而不进分支 thread（寒暄/短指令不该逼人点进 thread 看一句"收到"）。0=关闭豁免（一切照旧进 thread）。仅影响 CLOWDER_THREAD_FIRST_DEFAULT 路径，thread 显式 routingPolicy 不受影响。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CLOWDER_AUTO_CLAIM_THREADS',
    defaultValue: '(未设置 → 关闭)',
    description:
      '批次3-A 无主任务自动认领唤醒：逗号分隔的 thread id 白名单；置 "*" 为全部频道开启。任务创建且无主时，唤醒该频道最多 3 只候选猫（participatingCats 优先）用 cat_cafe_task_claim 抢单，幂等键防重复投递。默认关闭。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CLOWDER_AUTO_CLAIM_CLIENTS',
    defaultValue: '(未设置 → 全部猫可被唤醒)',
    description:
      '批次3-A 自动认领候选的 client 家族白名单：逗号分隔的 CatConfig.clientId（如 anthropic,openai,kimi）。设置后只有这些家族的猫会被唤醒抢单，其余家族一律跳过；不设置则不过滤。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CLOWDER_AUTO_RETRY',
    defaultValue: '(未设置 → 关闭)',
    description:
      '批次3-B 白名单自动重试：置 true/1 时，终态 failed 且错误分类 ∈ {transient_network, cli_crash} 的 invocation 由 AutoRetryScheduler 按指数退避（30s/120s）自动重试，每 run 上限 2 次；quota/aborted/agent_error/context_overflow 永不自动重试。默认关闭，不影响既有手动重试端点。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_QUOTA_COOLDOWN_QUEUE',
    defaultValue: '(未设置 → 关闭，撞配额立即失败)',
    description:
      '理智线 T6 配额冷却排队闸（2026-07-26 铲屎官拍板默认关闭）：开启（1/true）时，目标猫处于配额冷却期的消息会压在队列里并发"已排队，到点自动续跑"通知，配额恢复后自动派发；关闭（默认）时消息照常派发、由 provider 当场报配额错误，用户立即可见并可换猫。冷却记录本身仍由 cooldown-sweep 维护，不受此开关影响。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
  },
  {
    name: 'CLOWDER_CLAIMED_IDLE_WAKEUP',
    defaultValue: '(未设置 → 开启)',
    description:
      '认领闲置唤醒器（ClaimedIdleScheduler）：修复"猫认领任务后只发一句计划就挂机，队列空、无执行、平台永不叫醒"的漏洞——批次3-A 的自动认领唤醒只覆盖无主任务，不覆盖已认领但闲置的任务。每 60s 扫描 status=doing 且 owner 无 queued/processing 队列条目、无 active invocation 的任务，闲置超过 CLOWDER_CLAIMED_IDLE_MINUTES（默认 15 分钟，按 task.updatedAt 计算）后投递唤醒消息叫 owner 继续/blocked/unclaim。每个认领周期最多 2 次唤醒、间隔 ≥30 分钟；2 次无进展则不再唤醒，改为在主频道发一条零 token 的系统通知建议人工处理。默认开启（与批次3-A 的白名单式灰度不同：这是纯粹的兜底安全网，不会主动分派新工作，只在猫已认领却失联时叫醒同一只猫，风险面小）。置 "0"/"false" 关闭。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_CLAIMED_IDLE_MINUTES',
    defaultValue: '15',
    description:
      '配合 CLOWDER_CLAIMED_IDLE_WAKEUP 使用：任务判定"认领闲置"的分钟阈值——now 减 task.updatedAt 超过此值且无进行中执行才会触发唤醒。非正数或非法值一律回退默认 15。改值无需重启——每次扫描 tick 都会重新读取。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_BUDGET_ENFORCE',
    defaultValue: '(未设置 → 关闭)',
    description:
      '批次3-E 预算熔断：置 true/1 时，QueueProcessor 在 spawn 前检查目标猫今日 costUsd 是否超过 catalog 配置的 costBudget.perCatDailyUsd；超限则该 run 直接以 failureClass=budget_exhausted 终止（不 spawn 任何进程），关联 task（如有）随之 → failed。costUsd 计价目前仅 Claude(anthropic) 猫可靠，非 Claude 猫或无 costBudget 配置的猫一律跳过熔断（保守放行）并记日志。默认关闭，不影响既有行为。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_MODEL_CATALOG',
    defaultValue: '1（默认开）',
    description:
      '本地 CLI 模型扫描第 5 来源（云端模型目录）：并行拉取 models.dev（https://models.dev/api.json）与 LiteLLM（model_prices_and_context_window.json）的公开模型清单，合并去重后按家族过滤（claude-*/gpt-*·o[0-9]*·codex-*/gemini-*）补充进 claude/codex/gemini 三个候选槽，替代静态清单手动更新的时效性短板；kimi/grok/opencode 等使用自有别名体系，不接入此源。置 "0"/"false" 关闭整个来源。单次拉取 5 秒超时，两源任一失败或解析失败一律静默跳过，扫描不会因此报错；进程内缓存 CLOWDER_MODEL_CATALOG_TTL_HOURS 小时。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_MODEL_CATALOG_TTL_HOURS',
    defaultValue: '24',
    description: '配合 CLOWDER_MODEL_CATALOG 使用：云端模型目录的进程内缓存时长（小时）。非正数或非法值一律回退默认 24。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_AUTO_TASK_THREAD_ROUTING',
    defaultValue: 'false（2026-07-25 起）',
    description:
      'legacy 回退开关：默认 false（2026-07-25 PRD docs/prd/task-creation-raft-alignment.md 拍板——平台分类器退出任务自动创建，建任务只剩两条路：人类显式声明 As Task/右键 Convert to Task，或猫自主判断后 cat_cafe_task_claim 认领）。置 true 恢复旧的 classifyWorkAdmission 自动建任务行为，全局生效——同时门控 messages.ts 里两个调用点：非 thread-first 消息的 autoTaskDecision 判定，以及 thread-first 消息里"decorative task-card"判定（批次2 引入；thread-first 于 2026-07-24 default 全频道开启后，这条一度是实际的主入口，2026-07-25 补齐同一门控，详见 PRD"实施修正"节）。改值需重启 api 才生效。频道级回退见 CLOWDER_AUTO_TASK_THREAD_THREADS。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_AUTO_TASK_THREAD_THREADS',
    defaultValue: '(未设置 → 关闭)',
    description:
      'legacy 回退开关（按频道白名单）：逗号分隔的 thread id，命中的频道单独恢复旧的分类器自动建任务行为，无需翻全局 CLOWDER_AUTO_TASK_THREAD_ROUTING。2026-07-25 PRD task-creation-raft-alignment 拍板后默认清空——此前遗留的两个 F194 早期金丝雀 thread id 已随本次改动移除（非铲屎官刻意配置，属灰度残留）。改值需重启 api 才生效。',
    category: 'governance',
    sensitive: false,
    runtimeEditable: false,
    restartRequired: true,
  },
  {
    name: 'CLOWDER_LIBRARY_REBUILD_HOURS',
    defaultValue: '24',
    description:
      'F-H 知识库运维闭环：LibraryRebuildScheduler 按此小时数周期性对所有只读库集合（readOnly:true，目前即 Obsidian 挂载，如 domain:orbitos-knowledge）自动执行与手动 POST /api/library/:collectionId/rebuild 相同的增量重建（不阻塞请求，进程内 .unref() 定时器）。置 "0" 关闭自动重建，仅保留手动触发。非正数或非法值一律回退默认 24。改值无需重启——每次内部 15 分钟 tick 都会重新读取该值。',
    category: 'evidence',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_CLI_SESSION_MAX_MB',
    defaultValue: '0（未设置/0 → 只观测不轮转，零行为变化）',
    description:
      'F-G（docs/prd/PRD-memory-upgrade.md 批次 3）CLI 原生 session 撑爆治理：各 provider CLI 自己维护的续接历史（grok/kimi/claude/codex/gemini 的 --resume/--continue/--session 机制）体积上限（单位 MB）。invoke-single-cat.ts 即将 --resume 一个旧 session 之前会检查其原生磁盘体积——超过此值且该猫在 CLOWDER_CLI_SESSION_ROTATE_CATS 白名单内时，本次调用不带 sessionId（等效强制轮转），旧文件只改名归档为 "<path>.rotated-<yyyy-mm-dd>" 后缀，绝不删除。轮转前会补一次 autoUpdateAgentMemory 蒸馏写入两层记忆。本轮只对 grok（clientId）实现了原生 session 路径解析，其余 provider 会安全短路为不轮转（见 cli-native-session-rotation.ts 顶部调研表）。默认 0 = 关闭，不做任何 fs 访问。灰度建议：先设 8（MB）+ CLOWDER_CLI_SESSION_ROTATE_CATS=grok。改值无需重启——每次 invocation 都会重新读取。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: true,
  },
  {
    name: 'CLOWDER_CLI_SESSION_ROTATE_CATS',
    defaultValue: '(未设置 → 全部关闭，不轮转任何猫)',
    description:
      '配合 CLOWDER_CLI_SESSION_MAX_MB 使用：逗号分隔的 catId 白名单（如 "grok" 或 "grok,kimi"），只有名单内的猫会被 CLI 原生 session 体积轮转门控中；未设置或为空则即使 CLOWDER_CLI_SESSION_MAX_MB>0 也不轮转任何猫。灰度纪律：先只开 grok（事故猫，也是本轮唯一实现了原生 session 路径解析的 provider）。改值无需重启——每次 invocation 都会重新读取。',
    category: 'cli',
    sensitive: false,
    runtimeEditable: true,
  },
];

/** Mask credentials in a URL while preserving host/port/db for debugging. */
export function maskUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = '';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    // Not a valid URL — mask entirely to be safe
    return '***';
  }
}

function maskValue(def: EnvDefinition, raw: string): string {
  if (def.sensitive) return '***';
  if (def.maskMode === 'url') return maskUrlCredentials(raw);
  return raw;
}

function isHubVisibleEnvVar(def: EnvDefinition): boolean {
  return def.hubVisible !== false;
}

/**
 * Build env summary by reading current process.env values.
 * Sensitive values are masked. URL values have credentials masked.
 */
export function buildEnvSummary(): Array<EnvDefinition & { currentValue: string | null }> {
  return ENV_VARS.filter(isHubVisibleEnvVar).map((def) => {
    const raw = process.env[def.name];
    const currentValue = raw != null && raw !== '' ? maskValue(def, raw) : null;
    return { ...def, currentValue };
  });
}

export function isEditableEnvVar(def: EnvDefinition): boolean {
  // Explicit opt-in: runtimeEditable: true allows editing even if sensitive (fail-closed whitelist)
  if (def.runtimeEditable === true) return true;
  // Explicit opt-out: runtimeEditable: false blocks editing unconditionally
  if (def.runtimeEditable === false) return false;
  // Default: non-sensitive vars are editable
  return !def.sensitive;
}

/** True if this env var is both sensitive AND explicitly opted into runtime editing. */
export function isSensitiveEditableEnvVar(def: EnvDefinition): boolean {
  return def.sensitive && def.runtimeEditable === true;
}

export function isEditableEnvVarName(name: string): boolean {
  return ENV_VARS.some((def) => def.name === name && isHubVisibleEnvVar(def) && isEditableEnvVar(def));
}

/** Check if any of the given env var names are sensitive-editable (requires owner gate). */
export function hasSensitiveEditableVars(names: Iterable<string>): boolean {
  const nameSet = new Set(names);
  return ENV_VARS.some((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def));
}

/** Return only the sensitive-editable keys from the given names (for audit filtering). */
export function filterSensitiveEditableKeys(names: Iterable<string>): string[] {
  const nameSet = new Set(names);
  return ENV_VARS.filter((def) => nameSet.has(def.name) && isSensitiveEditableEnvVar(def)).map((def) => def.name);
}
