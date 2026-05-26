/**
 * System Prompt Builder
 * 为每次 CLI 调用构建身份注入 prompt（~150-200 tokens）
 *
 * 读取 catRegistry 生成身份上下文；如绑定本地资产卡，会只读注入资产卡文本。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { CatConfig, CatId, CompiledPackBlocks, ToolPolicy, WorldContextEnvelope } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import {
  catHasRole,
  getCoCreatorConfig,
  getReviewPolicy,
  getRoster,
  isCatAvailable,
  isCatLead,
} from '../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { resolveWithLocalOverlay } from '../../../../utils/local-override.js';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';
// F167 Phase F P1 (cloud Codex): roster model cell must resolve via getCatModel
// (env CAT_{CATID}_MODEL → registry → defaults), not from static config.defaultModel,
// otherwise env overrides cause exactly the handle/model drift Phase F is killing.
import { buildGuidePromptLines } from '../../../guides/GuidePromptSection.js';
import type {
  BootcampStateV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
} from '../stores/ports/ThreadStore.js';
import { RICH_BLOCK_SHORT } from './rich-block-rules.js';

const ASSET_CARD_MAX_CHARS = 30_000;

function buildAssetCardBlock(config: CatConfig): string | null {
  const assetCard = config.assetCard;
  const assetPath = assetCard?.path?.trim();
  if (!assetPath) return null;

  const header = [
    '## 绑定资产卡（强关联）',
    '你每次执行任务前，必须先阅读并遵循这张本地资产卡。资产卡是你的职责、边界、输出格式和注意事项的来源。',
    `资产卡路径：${assetPath}`,
  ];

  try {
    if (extname(assetPath).toLowerCase() !== '.md') {
      return [...header, '资产卡读取失败：只允许读取 .md 文本资产卡。'].join('\n');
    }
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      return [...header, '资产卡读取失败：文件不存在或不是普通文件。'].join('\n');
    }
    const raw = readFileSync(assetPath, 'utf-8');
    const content =
      raw.length > ASSET_CARD_MAX_CHARS ? `${raw.slice(0, ASSET_CARD_MAX_CHARS)}\n\n[资产卡内容过长，已截断]` : raw;
    return [...header, '', '```markdown', content.trim(), '```'].join('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [...header, `资产卡读取失败：${message}`].join('\n');
  }
}

/**
 * Context for a single cat invocation
 */
export interface InvocationContext {
  /** Which cat is being invoked */
  catId: CatId;
  /** independent = sole responder, serial = part of a chain, parallel = concurrent ideation */
  mode: 'independent' | 'serial' | 'parallel';
  /** 1-based position in chain (only for serial mode) */
  chainIndex?: number;
  /** Total cats in chain (only for serial mode) */
  chainTotal?: number;
  /** Other cats in this invocation (for teammate awareness) */
  teammates: readonly CatId[];
  /** Whether MCP tools are available for this cat */
  mcpAvailable: boolean;
  /** Slock-like toolbox tier; controls governance/context loading weight. */
  toolPolicy?: ToolPolicy;
  /** Full shared-rules reference, injected only when magic words explicitly trigger it. */
  governanceSourceContext?: string | null;
  /** Prompt-level tags like 'critique' (from IntentParser) */
  promptTags?: readonly string[];
  /** Whether A2A collaboration prompt should be injected (only in serial/execute mode) */
  a2aEnabled?: boolean;
  /**
   * F042: Direct-message sender (A2A).
   * When present, the invoked cat MUST reply to this cat (not the user).
   */
  directMessageFrom?: CatId;
  /**
   * F167 L1: ping-pong streak warning.
   * When present (streak >= 2), inject a warning prompt reminding the cat
   * that they've been bouncing the same pair back and forth — consider
   * third-party input / wrap up / escalate to 铲屎官 instead of another volley.
   */
  pingPongWarning?: {
    /** The other cat in the ping-pong pair (not this cat). */
    pairedWith: CatId;
    /** Current streak count (≥2, <4). */
    count: number;
  };
  /**
   * F046 D3: One-shot feedback injected when previous @mention was not routed.
   * Consumed from threadStore before invocation and cleared after injection.
   */
  mentionRoutingFeedback?: ThreadMentionRoutingFeedback;
  /** F042 Wave 3: Thread-level participant activity for @ disambiguation.
   *  Sorted by lastMessageAt desc. Injected per-invocation to survive compression. */
  activeParticipants?: readonly ThreadParticipantActivity[];
  /** F042: Thread-scoped routing policy summary (intent/scope). Injected per-invocation. */
  routingPolicy?: ThreadRoutingPolicyV1;
  /**
   * F073 P4: SOP stage hint from Mission Hub workflow-sop.
   * Injected per-invocation so all cats (Claude/Codex/Gemini) see current stage.
   * 告示牌哲学：猫看了自己决定行动，不被系统推着走。
   */
  sopStageHint?: {
    readonly stage: string;
    readonly suggestedSkill: string | null;
    readonly featureId: string;
  };
  /**
   * F091: Active Signal articles in discussion context.
   * Injected when 铲屎官 links a Signal article in the thread.
   */
  activeSignals?: readonly {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly tier: number;
    readonly contentSnippet: string;
    readonly note?: string | undefined;
    readonly relatedDiscussions?:
      | readonly {
          readonly sessionId: string;
          readonly snippet: string;
          readonly score: number;
        }[]
      | undefined;
  }[];
  /**
   * F092: Voice companion mode.
   * When true, cats should prioritize audio rich blocks for spoken output.
   */
  voiceMode?: boolean;
  /**
   * Thread ID — injected for tools that need it (e.g. bootcamp state updates).
   */
  threadId?: string;
  /**
   * F087: Bootcamp state for CVO onboarding threads.
   * When present, cats inject bootcamp-guide behavior per phase.
   */
  bootcampState?: BootcampStateV1;
  /**
   * F155: Matched guide candidate from routing-layer keyword match.
   * When present, cats load guide-interaction skill and offer the guide.
   */
  guideCandidate?: {
    id: string;
    name: string;
    estimatedTime: string;
    status: 'offered' | 'awaiting_choice' | 'active' | 'completed';
    /** True only on the first routing-layer match before any guideState has been persisted. */
    isNewOffer?: boolean;
    /** When user clicked an interactive selection, carries the chosen label. */
    userSelection?: string;
  };
  /**
   * F087: Number of cats currently registered in this account.
   * Injected alongside bootcampState so the model knows team size without querying /api/cats.
   */
  bootcampMemberCount?: number;
  /**
   * F129: Compiled pack blocks from active packs.
   * Injected into static identity via buildStaticIdentity → packBlocks.
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * F163 AC-A3: Pre-fetched always_on + constitutional docs for physical injection.
   * Populated from SqliteEvidenceStore.queryAlwaysOn() at bootstrap time.
   */
  alwaysOnDocs?: readonly { anchor: string; title: string; summary: string }[];
  /**
   * F093: World context envelope for world-building mode.
   * When present, injects world state (characters, scene, canon) into the prompt.
   */
  worldContext?: WorldContextEnvelope;
}

/** Get all cat configs from catRegistry (.cat-cafe/cat-catalog.json) */
function getAllConfigs(): Record<string, CatConfig> {
  return catRegistry.getAllConfigs();
}

/** Get a single cat config by ID */
function getConfig(catId: string): CatConfig | undefined {
  return catRegistry.tryGet(catId)?.config;
}

interface CallableCatEntry {
  readonly id: string;
  readonly config: CatConfig;
}

interface CallableMentionsResult {
  readonly mentions: string[];
  readonly hasDuplicateDisplayNames: boolean;
  readonly uniqueHandleExample: string | null;
}

function pickVariantMention(id: string, config: CatConfig): string {
  const expected = `@${id}`.toLowerCase();
  const byId = config.mentionPatterns.find((p) => p.toLowerCase() === expected);
  if (byId) return byId;
  if (config.mentionPatterns.length > 0) {
    return [...config.mentionPatterns].sort((a, b) => a.length - b.length)[0]!;
  }
  return `@${id}`;
}

function pickDisplayNameMention(config: CatConfig): string | null {
  const expected = `@${config.displayName}`.toLowerCase();
  return config.mentionPatterns.find((p) => p.toLowerCase() === expected) ?? null;
}

function pickDisplayNameOrVariantMention(id: string, config: CatConfig): string {
  // Do not synthesize @displayName unless the registry actually routes it.
  // Example: opus-47 shares displayName="布偶猫" but only registers @opus-47.
  return pickDisplayNameMention(config) ?? pickVariantMention(id, config);
}

function buildCallableMentions(currentCatId: CatId): CallableMentionsResult {
  const entries: CallableCatEntry[] = Object.entries(getAllConfigs())
    .filter(([id]) => id !== currentCatId && isCatAvailable(id))
    .map(([id, config]) => ({ id, config }));

  if (entries.length === 0) {
    return { mentions: [], hasDuplicateDisplayNames: false, uniqueHandleExample: null };
  }

  const byDisplayName = new Map<string, CallableCatEntry[]>();
  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName);
    if (group) {
      group.push(entry);
    } else {
      byDisplayName.set(entry.config.displayName, [entry]);
    }
  }

  const hasDuplicateDisplayNames = Array.from(byDisplayName.values()).some((group) => group.length > 1);
  const mentions: string[] = [];
  const seen = new Set<string>();
  let uniqueHandleExample: string | null = null;

  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName) ?? [];
    const mention =
      group.length <= 1 || entry.config.isDefaultVariant
        ? pickDisplayNameOrVariantMention(entry.id, entry.config)
        : pickVariantMention(entry.id, entry.config);
    if (group.length > 1 && !entry.config.isDefaultVariant && uniqueHandleExample == null) {
      uniqueHandleExample = mention;
    }
    if (!seen.has(mention)) {
      seen.add(mention);
      mentions.push(mention);
    }
  }

  return { mentions, hasDuplicateDisplayNames, uniqueHandleExample };
}

function formatHandleFreeLabel(catId: string, config: CatConfig | undefined): string {
  if (!config) return catId;
  // F167 identity anti-spoofing: carry variantLabel when present to disambiguate same-breed variants
  // (e.g. "布偶猫 Opus 4.7(opus-47)" vs "布偶猫(opus)"), preventing A2A handoff identity confusion.
  const variantPart = config.variantLabel ? ` ${config.variantLabel}` : '';
  return `${config.displayName}${variantPart}(${catId})`;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * Skills-as-source-of-truth: MCP tools section is minimal.
 * Full specs live in cat-cafe-skills/refs/ (rich-blocks.md, mcp-callbacks.md).
 */
const MCP_TOOLS_SECTION = `
MCP 工具（异步汇报；token 有效期有限）：

**记忆工具：**
- cat_cafe_search_evidence: 首选入口；depth=raw 可看消息级细节
- cat_cafe_reflect: 反思性合成

**drill-down：**
- cat_cafe_list_session_chain: 列出 session 链
- cat_cafe_read_session_digest: 读 session 摘要
- cat_cafe_read_session_events: 读 session 事件（raw/chat/handoff）
- cat_cafe_read_invocation_detail: 读单次 invocation 全事件

**协作工具：**
- cat_cafe_post_message: 异步消息
- cat_cafe_register_pr_tracking: PR tracking
- cat_cafe_get_pending_mentions: @提及
- cat_cafe_get_thread_context: thread 上下文
- cat_cafe_list_threads: thread 摘要
- cat_cafe_create_task: 🧶 毛线球（持久任务）
- cat_cafe_update_task: 更新任务状态
- cat_cafe_create_rich_block: rich block（inline）
- cat_cafe_generate_document: 文档生成→IM投递
- cat_cafe_get_rich_block_rules: rich block 规则
- cat_cafe_multi_mention: 并行拉猫讨论（先搜后问）

${RICH_BLOCK_SHORT}
需要富呈现时优先 rich block；首次使用前先 call get_rich_block_rules。
规范：cat-cafe-skills/refs/rich-blocks.md。`;

/**
 * L0 Governance Core — Slock-like always-on constitutional floor.
 * Keep this short: every agent sees it, including minimal/default DM responders.
 */
const GOVERNANCE_CORE_DIGEST = `## 核心家规（shared-rules.md 摘要）
规则是边界不是全部：先判断角色、验证信息源、避免笨重方案；认为规则不适用时，用证据+替代方案 Push Back。
硬原则：面向终态、不绕路；方向正确优先；单一真相源；可验证才算完成；用户是 CVO，重要决策由用户拍板。
协作底线：回复落在正确 surface；行动任务先认领/复用任务；完成必须给证据；危险/不可逆操作先停下确认。
Magic Words：脚手架/绕路了/喵约/星星罐子/第一性原理/数学之美/下次一定/我能猜出来/碎片够了 = 用户手动拉闸，必须立即自检。
完整规则按需查阅：cat-cafe-skills/refs/shared-rules.md。`;

export type GovernanceTier = 'core' | 'operational';

const GOVERNANCE_MAGIC_WORDS = [
  '脚手架',
  '绕路了',
  '喵约',
  '星星罐子',
  '第一性原理',
  '数学之美',
  '下次一定',
  '我能猜出来',
  '碎片够了',
] as const;

const GOVERNANCE_SOURCE_MAX_CHARS = 18_000;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * L1 Governance Detail — operational rules for standard/full toolboxes.
 * Compiled from cat-cafe-skills/refs/shared-rules.md (single source of truth).
 * F086 post-completion: cats couldn't see shared-rules content, only a link.
 * Design decision: inject detail only for standard/full, not minimal.
 */
const GOVERNANCE_OPERATIONAL_DIGEST = `## 家规（shared-rules.md）
身份与边界：用自己的身份签名，不冒充其他猫；规则是边界不是全部，不适用时用证据+替代方案 Push Back。
原则：P1终态基座 P2自主跑完SOP P3方向正确>速度 P4单一真相源 P5可验证才算完成。用户是CVO，重要决策由用户拍板。
实事求是：结论基于代码/commit/PR/文档等证据；不确定就说不确定；不要编造；查不完就说"还没查完"；完成必须附测试/截图/日志等证据。
输出格式：日常对话和轻量问答用自然语言短答；只有任务完成、review、handoff、BLOCKED 等状态迁移才需要结构化报告。
协作纪律：团队用"我们"；回复落在正确surface；@是球权路由，收到@后三选一：接/退/升；行动任务先认领或复用任务，交付进in_review。
Magic Words（用户当前指令触发）： 「脚手架」终态自检；「绕路了」回直线路径；「喵约」重读家规；「星星罐子」停止副作用等指示；「第一性原理」/「数学之美」砍复杂度；「下次一定」能做的现在做；「我能猜出来」先读源文件；「碎片够了」换角度再搜并读原文。
46 hotfix止血治理：fix/hotfix/quick fix/workaround 走 hotfix 标签、跨猫review、禁止作者自验。
缅因猫fallback层数检测：同文件≥3层fallback时做坐标系自检，优先消除错误坐标系。
暹罗猫创意-实现解耦：发现问题先记录+handoff；碰 packages/src 必须转执行猫。`;

const HARNESS_SKILLS_SECTION = `## Harness Skills（Slock SOP）
- intake：先判断用户请求是问答还是行动；能执行就直接执行，只有阻塞时才追问。
- task-router：行动前复用/认领任务；状态流保持 todo/open → in_progress → in_review → done。
- thread-reply：回复必须落在正确 target；多步骤进展、日志和证物沉到源 thread。
- quality-gate：交付前跑最小有效验证并报告证物（测试/tsc/build/截图/API smoke/dry-run）。`;

const EXECUTION_AUDIT_SECTION = `## Slock-like 执行闭环审计
行动任务必须走三道门：
1. Intake Gate：用户要求推进/修复/执行/构建/导出/备份/push/检查/排查/改造时，先 claim 或复用任务，再动手。
2. Evidence Gate：交付前必须有证据，例如 commit hash、改动文件、测试命令、build 结果、截图、API smoke、导出文件路径之一；没有证据就不能说完成。
3. Status Gate：有证据后把任务切到 in_review 等用户验收；做不了就明确 BLOCKED + 缺什么，不允许用“我会继续/正在处理/下一步”冒充交付。
审计口径：状态回复 ≠ 交付；计划 ≠ 执行；没有证据的 done/in_review 都是不合格。`;

// --- .local / .local-override support (#603) ---
let _governanceDigestResolved: string = GOVERNANCE_OPERATIONAL_DIGEST;

/**
 * Preload governance overlay at startup. Call once before first prompt build.
 * Checks for shared-rules.local-override.md (replaces digest) or
 * shared-rules.local.md (appends to digest).
 */
export async function initGovernanceOverlay(): Promise<void> {
  const root = findMonorepoRoot();
  const basePath = `${root}/cat-cafe-skills/refs/shared-rules.md`;
  const result = await resolveWithLocalOverlay(basePath, GOVERNANCE_OPERATIONAL_DIGEST);
  _governanceDigestResolved = result.content;
  if (result.source !== 'base') {
    console.log(`[governance] shared-rules ${result.source}: ${result.path}`);
  }
}

export function getGovernanceDigest(toolPolicy: ToolPolicy = 'standard'): string {
  if (toolPolicy === 'minimal') return GOVERNANCE_CORE_DIGEST;
  return _governanceDigestResolved;
}

export function getGovernanceTierForToolPolicy(toolPolicy: ToolPolicy): GovernanceTier {
  return toolPolicy === 'minimal' ? 'core' : 'operational';
}

export function getGovernanceDigestEstimatedTokens(toolPolicy: ToolPolicy): number {
  return roughTokenEstimate(getGovernanceDigest(toolPolicy));
}

export function detectGovernanceMagicWord(message: string): string | null {
  return GOVERNANCE_MAGIC_WORDS.find((word) => message.includes(word)) ?? null;
}

export function buildGovernanceSourceContext(message: string): string | null {
  const matchedWord = detectGovernanceMagicWord(message);
  if (!matchedWord) return null;

  const root = findMonorepoRoot();
  const sourcePath = `${root}/cat-cafe-skills/refs/shared-rules.md`;
  try {
    const raw = readFileSync(sourcePath, 'utf-8').trim();
    const content =
      raw.length > GOVERNANCE_SOURCE_MAX_CHARS
        ? `${raw.slice(0, GOVERNANCE_SOURCE_MAX_CHARS)}\n\n[shared-rules.md 原文过长，已截断]`
        : raw;
    return [
      '## 家规原文按需参考（shared-rules.md）',
      `触发词：「${matchedWord}」。这不是常驻上下文，只在用户显式拉闸时注入。`,
      `来源：${sourcePath}`,
      '',
      '```markdown',
      content,
      '```',
    ].join('\n');
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return ['## 家规原文按需参考（shared-rules.md）', `触发词：「${matchedWord}」。`, `读取失败：${messageText}`].join(
      '\n',
    );
  }
}

/** Per-breed workflow triggers: when to proactively @ other cats.
 *  Keyed by breedId so all variants of a breed share the same workflow. */
const WORKFLOW_TRIGGERS: Record<string, string> = {
  ragdoll: [
    '## 工作流（主动 @ 触发点）',
    '- 完成开发/修复 → @缅因猫 请 review',
    '- 修完 review 意见 → @缅因猫 确认修复',
    '- 遇到视觉/体验问题 → @暹罗猫 征询',
    '- Review 别人代码：每个发现给明确立场（放行/退回 + 理由）',
  ].join('\n'),
  'maine-coon': [
    '## 工作流（主动 @ 触发点）',
    '- 完成 review → @布偶猫 通知结果',
    '- 修完 bug/feature → @布偶猫 请 review',
    '- serial/handoff 场景且需要对方行动 → @ 对应猫（parallel 模式各自独立，不互 @）',
    '- 发现需要架构决策 → @布偶猫 征询',
    '- Review 代码：每个发现给明确立场（放行/退回 + 理由）',
    '- 收到 review 意见：独立判断，认为自己对就 push back（Rule 0），不全盘接受',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 接球后静默执行：收到"放行"后沉默做到下一状态迁移点（BLOCKED / REVIEW READY / DONE）',
    '- 声明 = 执行：说"我进 merge gate"必须同 turn 加载 skill 并执行',
    '- 只发状态迁移消息，中间产物留在代码里',
    '- 完成任务后必须 @ 下一棒',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
  ].join('\n'),
  siamese: [
    '## 工作流（主动 @ 触发点）',
    '- 完成设计/视觉资产 → 分别 @布偶猫 和 @缅因猫 请确认（每只猫各占一行）',
    '- 遇到技术实现问题 → @布偶猫 征询',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 涉及 UI/前端验证时：通过截图产出证据',
    '- 接球后静默执行到下一状态点（DONE / HANDOFF）',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
  ].join('\n'),
};

/**
 * F-Ground-3: Build teammate roster table.
 * Lists all other cats with @mention, strengths, and caution.
 * Excludes the current cat. Returns null if no teammates.
 */
function buildTeammateRoster(currentCatId: CatId): string | null {
  const allConfigs = getAllConfigs();
  const entries = Object.entries(allConfigs).filter(([id]) => id !== currentCatId && isCatAvailable(id));
  if (entries.length === 0) return null;

  const rows: string[] = [];
  for (const [id, config] of entries) {
    const label = config.variantLabel
      ? `${config.displayName} ${config.variantLabel}`
      : config.nickname
        ? `${config.displayName}/${config.nickname}`
        : config.displayName;
    const mention = pickVariantMention(id, config);
    // F167 Phase F (KD-21): surface resolved runtime model next to the @mention so
    // sender's 认知真相 aligns with runtime catalog. Handle is identity constant;
    // model is runtime-resolved metadata — the two must be visibly decoupled to
    // prevent cargo-cult projection (e.g. "云端 codex bot" → 本地 @codex 快照).
    // P1 fix (cloud Codex review): resolve via getCatModel so env overrides show through,
    // not the static template's defaultModel. Fall back to defaultModel only on error.
    let resolvedModel: string;
    try {
      resolvedModel = getCatModel(id);
    } catch {
      resolvedModel = config.defaultModel ?? '';
    }
    const mentionCell = resolvedModel ? `${mention} · ${resolvedModel}` : mention;
    const strengths = config.teamStrengths ?? config.roleDescription;
    // F167 Phase E (KD-20): surface hard restrictions alongside caution — data-driven
    // replacement for the retired L3 role-gate. Sender sees e.g. "禁止写代码" so they
    // self-regulate which cat to @ for which task; no harness-side regex.
    const restrictionsNote =
      config.restrictions && config.restrictions.length > 0 ? `**硬限制**：${config.restrictions.join('、')}` : null;
    const cautionCell = [config.caution ?? null, restrictionsNote].filter(Boolean).join('；') || '—';
    rows.push(`| ${label} | ${mentionCell} | ${strengths} | ${cautionCell} |`);
  }

  return [
    '## 队友名册',
    '| 猫猫 | @mention · 当前模型 | 擅长 | 注意 |',
    '|------|---------|------|------|',
    ...rows,
  ].join('\n');
}

/**
 * Options for building the static identity prompt.
 * MCP section is included here (not in invocationContext) because it's
 * session-level — injected once on new session, skipped on --resume.
 */
export interface StaticIdentityOptions {
  /**
   * Whether native MCP tools are available (Claude with --mcp-config).
   * When true, MCP_TOOLS_SECTION is included in static identity because
   * Claude's --append-system-prompt survives context compression.
   *
   * Non-Claude cats (Codex/Gemini) use HTTP callback instructions which
   * must stay in per-message prompt because their systemPrompt is in
   * session history and MAY be lost on compression.
   */
  mcpAvailable?: boolean;
  /**
   * F129: Compiled pack blocks to inject.
   * Dual-track priority (ADR-021):
   *   Identity (core) > Pack Masks > Governance L0 > Pack Guardrails > Pack Defaults > Workflows
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * Slock-like governance loading tier.
   * minimal: inject only core rules; standard/full: inject operational digest.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Slock-like cross-session memory for this specific cat.
   * Loaded from .cat-cafe/memory/{catId}.md and injected as durable preferences/context.
   */
  agentMemoryContext?: string | null;
}

/**
 * Build static identity prompt — persistent across invocations.
 * Includes: identity, personality, rules, A2A format, workflow triggers,
 * 铲屎官 reference, and MCP tool documentation (session-level).
 * Suitable for --system-prompt / --append-system-prompt injection.
 */
export function buildStaticIdentity(catId: CatId, options?: StaticIdentityOptions): string {
  const config = getConfig(catId as string);
  if (!config) return '';

  const providerLabel = PROVIDER_LABELS[config.clientId] ?? config.clientId;
  const toolPolicy = options?.toolPolicy ?? 'standard';
  const lines: string[] = [];

  // Identity
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  lines.push(
    `你是 ${nameLabel}，由 ${providerLabel} 提供的 AI 猫猫。`,
    ...(config.nickname ? [`昵称 "${config.nickname}" 的由来见 docs/stories/cat-names/。`] : []),
    `角色：${config.roleDescription}`,
    `性格：${config.personality}`,
    '',
  );

  const assetCardBlock = buildAssetCardBlock(config);
  if (assetCardBlock) {
    lines.push(assetCardBlock, '');
  }

  // F167 Phase E (KD-20): self-awareness — if this cat has hard restrictions,
  // declare them inline so the cat can recognize illegitimate @-mentions and
  // push back / retreat (instead of accepting and failing). Data-driven from
  // cat-config.restrictions — no harness gate, the cat self-regulates.
  if (config.restrictions && config.restrictions.length > 0) {
    lines.push(`你的硬限制：${config.restrictions.join('、')}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫。`, '');
  }

  // F129: Pack masks — role overlay (never changes core identity, see KD-3)
  if (options?.packBlocks?.masksBlock) {
    lines.push(options.packBlocks.masksBlock, '');
  }

  // A2A collaboration format (always included — cats should know how to @ even in single-cat mode)
  const { mentions: callableMentions, hasDuplicateDisplayNames, uniqueHandleExample } = buildCallableMentions(catId);
  if (callableMentions.length > 0) {
    const exampleTarget = callableMentions[0]!;
    lines.push('## 协作');
    lines.push(`你可以 @队友: ${callableMentions.join(' / ')}`);
    if (hasDuplicateDisplayNames) {
      const example = uniqueHandleExample ?? '@opus';
      lines.push(`同族多分身时：默认 \`@显示名\`，其它用**唯一句柄**（例如 \`${example}\`）。`);
      lines.push(`同名队友并存时，请优先使用唯一句柄（例如 \`${example}\`）避免歧义。`);
    }
    lines.push('格式：另起一行行首写 @猫名（行中无效，多猫各占一行），上文或下文写请求均可。');
    lines.push(`[正确] ${exampleTarget}\\n请帮忙  [正确] 内容...\\n${exampleTarget}`);
    // F167 Phase F KD-22: model 在 narrative context 会把 @句柄写句中以为会路由。
    // 注意：parseA2AMentions 会 **剥离** markdown 前缀 (`> ` / `- ` / `* ` / `+ ` / `1. `)
    // 再匹配，所以 `- @cat` / `> @cat` 是**合法路由**（不是陷阱）。真正的陷阱是
    // @ 不在剥离后的行首位置——句中 / URL 内 / 任意非首字符。
    lines.push(
      `[错误] 句中 ${exampleTarget}（@ 不是行首也不是剥离 markdown 前缀后的首字符）· URL 内 ${exampleTarget} · 任何非行首位置的 @ 都不路由，球权掉地上。`,
    );
    lines.push(
      `发前自检：我消息里想路由的 @句柄 都在"独立一行的行首"或"markdown 列表/引用前缀后的首字符"吗？URL 内 / 句中任意位置的 @ 不是路由指令。`,
    );
    lines.push('');
  }

  // F-Ground-3: Teammate roster — who to @ and what they're good at
  const rosterLines = buildTeammateRoster(catId);
  if (rosterLines) {
    lines.push(rosterLines, '');
  }

  lines.push(
    '## Clowder CLI 工作纪律',
    '如果你的运行环境可以执行 shell，可使用 Clowder CLI 操作当前 Clowder；命令前先设 `CLI="${CLOWDER_CLI_PATH:-clowder}"`，没有 `clowder` 时再用仓库根目录 `./bin/clowder`。',
    '- 收到需要实际处理的任务：先 `$CLI task claim --message-id <messageId>` 或 `$CLI task claim --task <taskId>`。',
    '- 用户说“推进/修复/执行/帮我做/你来/排查/改造/构建/备份/push/导出”等，就是行动任务；除非权限或信息不足，否则必须 claim 后直接做，不要只回复计划或状态。',
    '- 行动任务的最终回复必须包含实际交付物或验证结果；禁止把“正在加载上下文/还没开始改代码/下一步我会做”当作任务完成。',
    '- 如果本轮不能动手（缺权限、缺文件、缺凭证、工具不可用），明确写 BLOCKED 和缺什么；不要伪装成已在执行。',
    '- 完成后等待人工验收：`$CLI task update --task <taskId> --status in_review`（会映射为 Clowder 的等待验收态）。',
    '- 需要回写当前 thread：`$CLI message send --target "$CAT_CAFE_THREAD_ID"`，正文走 stdin。',
    '纯讨论/解释不需要 claim；不要为了 @ 队友而使用 message send，A2A 仍按上面的行首 @ 规则。',
    '',
  );

  // Per-breed workflow triggers (fallback to catId for legacy configs without breedId)
  const triggers = WORKFLOW_TRIGGERS[config.breedId ?? ''] ?? WORKFLOW_TRIGGERS[catId as string];
  if (triggers) {
    lines.push(triggers, '');
  }

  lines.push(HARNESS_SKILLS_SECTION, '');
  lines.push(EXECUTION_AUDIT_SECTION, '');

  // F129: Pack workflow blocks (after breed workflow triggers)
  const packBlocks = options?.packBlocks;
  if (packBlocks?.workflowsBlock) {
    lines.push(packBlocks.workflowsBlock, '');
  }

  // 铲屎官 reference (session-level, not per-message)
  // F067: Use co-creator config for name + mention handles
  // Note: "不冒充/不编造/身份契约" folded into GOVERNANCE_L0_DIGEST
  const coCreator = getCoCreatorConfig();
  const ccName = coCreator.name;
  const ccHandles = coCreator.mentionPatterns.map((p) => `\`${p}\``).join(' / ');
  lines.push(`${ccName}（铲屎官/CVO）。重要决策由${ccName}拍板。需要关注时行首写 ${ccHandles}。`, '');

  // L0 Governance Digest — always-on principles from shared-rules.md (F086 post-completion fix)
  // Source of truth: cat-cafe-skills/refs/shared-rules.md (supports .local-override, #603)
  lines.push('', getGovernanceDigest(toolPolicy));

  const agentMemory = options?.agentMemoryContext?.trim();
  if (agentMemory) {
    lines.push(
      '',
      '## Agent Memory（跨会话记忆）',
      '以下是你的持久记忆，用于记住用户偏好、长期项目上下文、已验证的工作方式和注意事项。',
      '记忆不是最高优先级：如果它和当前用户指令、系统规则或事实冲突，以当前明确指令和事实为准。',
      '',
      '```markdown',
      agentMemory,
      '```',
    );
  }

  // F129: Pack guardrails — hard constraint track (only adds strictness, never relaxes Core Rails)
  if (packBlocks?.guardrailBlock) {
    lines.push('', packBlocks.guardrailBlock);
  }

  // F129: Pack defaults — user-overridable behavior track
  if (packBlocks?.defaultsBlock) {
    lines.push('', packBlocks.defaultsBlock);
  }

  // F129: World driver summary (read-only, informational)
  if (packBlocks?.worldDriverSummary) {
    lines.push('', packBlocks.worldDriverSummary);
  }

  // MCP tools documentation — ONLY for Claude (--append-system-prompt survives compression).
  // Non-Claude cats (Codex/Gemini) inject HTTP callback instructions per-message
  // because their systemPrompt lives in session history and may be lost on compression.
  if (options?.mcpAvailable) {
    lines.push('', MCP_TOOLS_SECTION.trim());
  }

  return lines.join('\n');
}

/**
 * Build dynamic invocation context — changes per call.
 * Includes: teammates, mode, chain position, prompt tags.
 * (MCP tools and 铲屎官 reference moved to buildStaticIdentity for session-level injection.)
 */
export function buildInvocationContext(context: InvocationContext): string {
  const config = getConfig(context.catId as string);
  if (!config) return '';

  const lines: string[] = [];
  const runtimeModel = (() => {
    try {
      return getCatModel(context.catId as string);
    } catch {
      return config.defaultModel;
    }
  })();

  // F042: Identity constant — pinned per invocation to survive compression.
  lines.push(
    `Identity: ${config.displayName}${config.nickname ? `/${config.nickname}` : ''} (@${context.catId}, model=${runtimeModel})`,
  );

  // F042 + F167: A2A direct-message reply target + identity anti-spoofing.
  // When handoff comes from a same-breed variant (same displayName, different catId),
  // inject explicit model markers + "not-you" reminder to prevent identity collapse
  // (e.g. opus-47 receiving from opus-default conflating itself with the 4.6 variant).
  if (context.directMessageFrom && context.directMessageFrom !== context.catId) {
    const fromConfig = getConfig(context.directMessageFrom as string);
    const fromLabel = formatHandleFreeLabel(context.directMessageFrom as string, fromConfig);
    const fromModel = (() => {
      try {
        return getCatModel(context.directMessageFrom as string);
      } catch {
        return fromConfig?.defaultModel ?? 'unknown';
      }
    })();
    lines.push(`Direct message from ${fromLabel} [model=${fromModel}]; reply to ${fromLabel}`);
    // Anti-spoofing fires only for same-breed variant handoffs (displayName collision + catId differs)
    if (fromConfig && fromConfig.displayName === config.displayName) {
      const selfVariant = config.variantLabel ?? runtimeModel;
      const fromVariant = fromConfig.variantLabel ?? fromModel;
      lines.push(
        `⚠️ 同族分身提醒：对方是 ${fromVariant}（model=${fromModel}），你是 ${selfVariant}（model=${runtimeModel}）——两个独立分身，不是你的旧版或新版。`,
      );
    }
  }

  // F167 L1: ping-pong streak warning — inject when this cat just received the ball
  // in a same-pair streak >= 2 (but < 4, else it would have been blocked upstream).
  if (context.pingPongWarning) {
    const otherConfig = getConfig(context.pingPongWarning.pairedWith as string);
    const otherLabel = formatHandleFreeLabel(context.pingPongWarning.pairedWith as string, otherConfig);
    lines.push(
      `🏓 乒乓球警告：你和 ${otherLabel} 已连续互相 @ ${context.pingPongWarning.count} 轮。思考是否真的需要再回一棒——第三方介入？收尾给铲屎官？还是这轮可以不 @？再 @ 2 轮将自动熔断。`,
    );
  }

  // Teammates — only list cats actually in this invocation
  if (context.teammates.length > 0) {
    lines.push('你的队友：');
    for (const id of context.teammates) {
      const c = getConfig(id as string);
      if (c) {
        const tmName = c.nickname ? `${c.displayName}/${c.nickname}` : c.displayName;
        lines.push(`- ${tmName}（${c.name}）：${c.roleDescription}`);
      }
    }
  }
  // Mode context
  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    lines.push(`当前模式：你是第 ${context.chainIndex}/${context.chainTotal} 只被召唤的猫，请注意前面猫的回复。`, '');
  } else if (context.mode === 'parallel') {
    lines.push(
      '当前模式：并行模式——独立思考。你和队友各自独立回答同一问题，给出你自己的观点。',
      `重要：你是 ${config.displayName}（@${context.catId}），不要复制或模仿其他猫的自我介绍。`,
      'F167 L2: @句柄 在并行模式下无路由语义（各猫并发、无先后顺序），不要互相 @；需要提醒队友做后续动作请等串行轮再说。',
      '',
    );
  } else {
    lines.push('当前模式：独立回答。', '');
  }

  // A2A: Exit check reminder — prevents "chain termination blind spot" where cats finish output
  // without considering whether a teammate needs to act next.
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    lines.push(
      `A2A 球权检查：@ = 球权转移（行首 @句柄，句中无效）。收到 @ 但对方说"我在动" → 矛盾，push back + 立刻接/退/升（诊断≠解决，说完不@=球还在地上）。收了球却说"你等着/你别动" → 球权死锁，禁止——做不了就退回或升级。球权只有第一人称：只能声明自己持球，不能声明别人持球——没有 @ 或 hold_ball 动作，球权就没转移。`,
      '',
    );
  }

  // F064: One-shot feedback when previous @mention was not routed.
  if (context.mentionRoutingFeedback && context.mentionRoutingFeedback.items?.length > 0) {
    const items = context.mentionRoutingFeedback.items.slice(0, 2).map((it) => `@${it.targetCatId}`);
    lines.push(
      `[路由提醒] 上次你提到了 ${items.join('、')} 但没有用行首 @ 路由。如果需要对方行动，请在行首独立一行写 @句柄。`,
      '',
    );
  }

  // Prompt tags
  if (context.promptTags?.includes('critique')) {
    lines.push('思维方式：批判性分析。挑战假设，找出漏洞，提出反例。', '');
  }

  // F140 Phase C: connector-triggered skill suggestion (hint, not directive)
  const skillTag = context.promptTags?.find((t) => t.startsWith('skill:'));
  if (skillTag) {
    lines.push(`⚡ Signal-triggered action → load skill: ${skillTag.slice(6)}`, '');
  }

  // F042 Wave 3: Active participant hint — re-injected per-invocation, survives compression.
  if (context.activeParticipants && context.activeParticipants.length > 0) {
    const topActive = context.activeParticipants
      .filter((p) => p.catId !== context.catId)
      .find((p) => p.lastMessageAt > 0);
    if (topActive) {
      const topConfig = getConfig(topActive.catId as string);
      if (topConfig) {
        lines.push(`最近活跃：${formatHandleFreeLabel(topActive.catId as string, topConfig)}`);
      }
    }
  }

  // F042: Thread routing policy hint — short, per-invocation, survives compression.
  if (context.routingPolicy?.v === 1 && context.routingPolicy.scopes) {
    const toMention = (id: string): string => {
      const c = getConfig(id);
      return c ? pickVariantMention(id, c) : `@${id}`;
    };

    const parts: string[] = [];
    const scopes = context.routingPolicy.scopes;
    const order = ['review', 'architecture'] as const;
    for (const scope of order) {
      const rule = scopes[scope];
      if (!rule) continue;
      if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) continue;

      const segs: string[] = [];
      // Defensive guard: data might be malformed from external persistence.
      const avoidList = Array.isArray(rule.avoidCats) ? rule.avoidCats : [];
      const preferList = Array.isArray(rule.preferCats) ? rule.preferCats : [];
      const avoid = avoidList.slice(0, 3).map((id) => toMention(String(id)));
      const prefer = preferList.slice(0, 3).map((id) => toMention(String(id)));
      if (avoid.length > 0) segs.push(`avoid ${avoid.join(', ')}`);
      if (prefer.length > 0) segs.push(`prefer ${prefer.join(', ')}`);
      const sanitizedReason = typeof rule.reason === 'string' ? rule.reason.replace(/[\r\n]+/g, ' ').trim() : '';
      if (sanitizedReason) segs.push(`(${sanitizedReason})`);

      if (segs.length > 0) parts.push(`${scope} ${segs.join(' ')}`);
    }

    if (parts.length > 0) {
      lines.push(`Routing: ${parts.join('; ')}`);
    }
  }

  // F073 P4: SOP stage hint — 告示牌 (bulletin board, not controller)
  if (context.sopStageHint) {
    const { stage, suggestedSkill, featureId } = context.sopStageHint;
    const skillPart = suggestedSkill ? ` → load skill: ${suggestedSkill}` : '';
    lines.push(`SOP: ${featureId} stage=${stage}${skillPart}`);
  }

  // F092: Voice companion mode — instruct cats to prioritize audio output
  if (context.voiceMode) {
    lines.push(
      'Voice Mode ON: 铲屎官在语音陪伴模式。',
      '- 默认用 audio rich block；代码/表格/长内容用文字并附语音摘要',
      '',
    );
  } else {
    lines.push(
      'Voice Mode OFF: 不强制发语音。默认用文字回复。你仍然可以发 audio rich block，但仅在铲屎官明确要求语音时才发。',
      '',
    );
  }

  // F087: Bootcamp mode — inject phase context so cats know to guide the new CVO
  if (context.bootcampState) {
    const { phase, leadCat, selectedTaskId } = context.bootcampState;
    const threadPart = context.threadId ? ` thread=${context.threadId}` : '';
    const membersPart = context.bootcampMemberCount != null ? ` members=${context.bootcampMemberCount}` : '';
    lines.push(
      `🎓 Bootcamp Mode:${threadPart} phase=${phase}${leadCat ? ` leadCat=${leadCat}` : ''}${selectedTaskId ? ` task=${selectedTaskId}` : ''}${membersPart}`,
      '→ Load bootcamp-guide skill and act per current phase.',
      '',
    );
  }

  // F155: Guide candidate — inline protocol (cats don't have /Skill tool at runtime)
  if (context.guideCandidate) {
    lines.push(...buildGuidePromptLines(context.guideCandidate, context.threadId));
  }

  // F093: World context envelope — inject world state for world-building mode
  if (context.worldContext) {
    const wc = context.worldContext;
    lines.push('');
    lines.push(`## 🌍 World: ${wc.world.name} [${wc.world.status}]`);
    if (wc.world.constitution) lines.push(`Constitution: ${wc.world.constitution}`);
    lines.push(`Scene: ${wc.scene.name} [${wc.scene.status}]`);
    if (wc.characters.length > 0) {
      lines.push('Characters:');
      for (const ch of wc.characters) {
        const identity = ch.coreIdentity?.name ?? ch.characterId;
        const drive = ch.innerDrive?.motivation ? ` — ${ch.innerDrive.motivation}` : '';
        lines.push(`- ${identity}${drive}`);
      }
    }
    if (wc.canonSummary.length > 0) {
      lines.push('Established canon:');
      for (const cs of wc.canonSummary) lines.push(`- ${cs.summary}`);
    }
    if (wc.recentEvents.length > 0) {
      lines.push(`Recent events (${wc.recentEvents.length}):`);
      for (const ev of wc.recentEvents.slice(-5)) {
        lines.push(`- [${ev.type}] ${JSON.stringify(ev.payload)}`);
      }
    }
    if (wc.careLoopHint) {
      lines.push(`Care hint: ${wc.careLoopHint.trigger} → ${wc.careLoopHint.suggestion}`);
    }
    lines.push('');
  }

  if (context.governanceSourceContext) {
    lines.push(context.governanceSourceContext, '');
  }

  // F163 AC-A3: always_on constitutional knowledge injection (physical, not retrieval)
  if (context.alwaysOnDocs && context.alwaysOnDocs.length > 0) {
    lines.push('');
    lines.push('## Constitutional Knowledge (always_on)');
    lines.push('');
    for (const doc of context.alwaysOnDocs) {
      lines.push(`### ${doc.title}`);
      lines.push('');
      lines.push(doc.summary);
      lines.push('');
    }
  }

  // F091: Active Signal articles in discussion context
  if (context.activeSignals && context.activeSignals.length > 0) {
    lines.push('Signal articles linked to this thread:');
    for (const s of context.activeSignals) {
      lines.push(`### [${s.id}] ${s.title} (${s.source}/T${s.tier})`);
      if (s.note) lines.push(`Note: ${s.note}`);
      lines.push(s.contentSnippet);
      // AC-10: Related discussions from our memory architecture (session search)
      if (s.relatedDiscussions && s.relatedDiscussions.length > 0) {
        lines.push('Related past discussions:');
        for (const d of s.relatedDiscussions) {
          lines.push(`- [session:${d.sessionId}] ${d.snippet}`);
        }
      }
    }
  }

  // F167 Phase D: Trailing anchor — decision tree, not flat three-choice.
  // @co-creator is a hard-condition exit, not the safe default (KD-19).
  // Placed at the very end for maximum recency bias (critical for non-Claude models).
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    const cc = getCoCreatorConfig().mentionPatterns[0] ?? '@铲屎官';
    lines.push(
      '',
      `下一棒传球决策树（本轮必选其一，缺 = 消息不完整）：先问"下一步谁能做"——`,
      `1. 另一只猫能做 → @句柄（review 完→@author / 修完→@reviewer / merge 完→@愿景守护猫）`,
      `2. 等外部条件 → 实际调用 cat_cafe_hold_ball(...)。外部条件包括：**云端 codex / GitHub bot review / PR check / CI / 长 build / 外部 webhook**——这些不是本地猫，不在 roster，不可 @ 任何本地近似 proxy；CLI 要退出但还需继续也走这条（口头"我继续"不算）`,
      `3. 只有铲屎官本人才能做 → ${cc}（硬条件：不可逆操作 / 愿景级决策 / 跨猫僵局）`,
      `${cc} 不是默认出口——先问"哪只猫能接"。反问式 ping 非法（"要不要 X？"/"同意吗？"）：有立场就自决去做（错了能回滚），没立场根本不该 @。**外部 identity（云端 xxx / GitHub bot / CI）** 永远走选项 2（hold_ball），严禁投射成本地 @句柄。`,
    );
  }

  return lines.join('\n');
}

/**
 * F032 Phase D2: Build reviewer section for system prompt.
 * Shows available reviewers based on roster, filtered by family.
 *
 * Cloud Codex R5 P2 fix: When requireDifferentFamily is enabled but no cross-family
 * reviewers are available, show same-family reviewers as fallback options to match
 * the actual degradation behavior in resolveReviewer().
 *
 * Cloud Codex R6 P2 fix: Respect excludeUnavailable policy. When false, show
 * unavailable cats as available to match resolveReviewer() behavior.
 */
export function buildReviewerSection(catId: CatId): string | null {
  const roster = getRoster();
  const policy = getReviewPolicy();

  // If no roster configured, skip reviewer section
  if (Object.keys(roster).length === 0) return null;

  const currentEntry = roster[catId];
  if (!currentEntry) return null;

  // Collect reviewers in separate buckets
  const crossFamily: string[] = [];
  const sameFamily: string[] = [];
  const unavailable: string[] = [];

  for (const [id, entry] of Object.entries(roster)) {
    // Skip self
    if (id === catId) continue;
    // Must have peer-reviewer role
    if (!catHasRole(id, 'peer-reviewer')) continue;

    const config = getConfig(id);
    const displayName = config?.displayName ?? id;
    const isLead = isCatLead(id);
    const isDifferentFamily = entry.family !== currentEntry.family;

    // Build description
    const tags: string[] = [];
    if (isDifferentFamily) tags.push(entry.family);
    if (isLead) tags.push('lead');
    const desc = tags.length > 0 ? ` (${tags.join(', ')})` : '';
    const mention = `@${id}`;
    const line = `- ${mention}${desc}`;

    // Cloud Codex R6 P2 fix: Respect excludeUnavailable policy
    // When excludeUnavailable=false, treat all cats as "effectively available"
    const isEffectivelyAvailable = !policy.excludeUnavailable || isCatAvailable(id);

    if (isEffectivelyAvailable) {
      if (isDifferentFamily) {
        crossFamily.push(line);
      } else {
        sameFamily.push(line);
      }
    } else {
      unavailable.push(`- ${mention} (${displayName}, 没猫粮)`);
    }
  }

  // Determine which reviewers to show as "available"
  let available: string[];
  let fallbackNote: string | null = null;

  if (policy.requireDifferentFamily) {
    if (crossFamily.length > 0) {
      // Cross-family available, show them
      available = crossFamily;
    } else if (sameFamily.length > 0) {
      // Cloud Codex R5 P2 fix: No cross-family, but same-family available as fallback
      available = sameFamily;
      fallbackNote = '[注意] 没有跨家族 reviewer 可用，以下同家族猫可作为 fallback：';
    } else {
      available = [];
    }
  } else {
    // No family requirement, show all available
    available = [...crossFamily, ...sameFamily];
  }

  // Don't generate section if no reviewers at all
  if (available.length === 0 && unavailable.length === 0) return null;

  const lines: string[] = ['## 你当前的 Reviewers', ''];
  if (available.length > 0) {
    if (fallbackNote) {
      lines.push(fallbackNote);
    } else {
      lines.push('根据 roster 配置，你当前可以找以下猫 review：');
    }
    lines.push(...available);
    lines.push('');
  }
  if (unavailable.length > 0) {
    lines.push('[注意] 以下猫当前不可用：');
    lines.push(...unavailable);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build identity system prompt for a cat invocation.
 * Backward-compatible: returns staticIdentity + invocationContext combined.
 * Pure function — same inputs always produce same output.
 */
export function buildSystemPrompt(context: InvocationContext): string {
  const staticPart = buildStaticIdentity(context.catId, {
    mcpAvailable: context.mcpAvailable,
    packBlocks: context.packBlocks,
    toolPolicy: context.toolPolicy,
  });
  if (!staticPart) return '';

  const parts: string[] = [staticPart];

  // F032 Phase D2: Inject reviewer section if available
  const reviewerSection = buildReviewerSection(context.catId);
  if (reviewerSection) parts.push(reviewerSection);

  // Invocation-specific context
  const dynamicPart = buildInvocationContext(context);
  if (dynamicPart) parts.push(dynamicPart);

  return parts.join('\n\n');
}
