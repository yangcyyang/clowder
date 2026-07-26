import { formatCatName, getCachedCats } from '@/hooks/useCatData';

export type VisibleSystemInfoVariant = 'info' | 'a2a_followup';

export interface VisibleSystemInfoResult {
  content: string;
  variant: VisibleSystemInfoVariant;
}

const SILENT_SYSTEM_INFO_TYPES = new Set([
  'provider_capability',
  'handoff_draft_window',
  'session_handoff_write_failed',
  'session_seal_requested',
]);

export function isSilentSystemInfo(parsed: Record<string, unknown> | null | undefined): boolean {
  return typeof parsed?.type === 'string' && SILENT_SYSTEM_INFO_TYPES.has(parsed.type);
}

function formatPingpongTerminated(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const fromCatId = typeof parsed.fromCatId === 'string' ? parsed.fromCatId : 'unknown';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const pairCount = typeof parsed.pairCount === 'number' ? parsed.pairCount : undefined;
  const rounds = pairCount ? ` ${pairCount} 轮` : '';
  return {
    content: `🏓 ${fromCatId} ↔ ${targetCatId} 已连续互相 @${rounds}，链路已熔断。`,
    variant: 'info',
  };
}

function formatRoleRejected(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const action = typeof parsed.action === 'string' ? parsed.action : '当前';
  return {
    content: reason || `⛔ @${targetCatId} 不接受 ${action} 任务。`,
    variant: 'info',
  };
}

const SANITY_STATE_LABEL: Record<string, string> = { green: '绿', yellow: '黄', red: '红' };
/** 跟目标档位（to）走：黄=预警，红=紧急，绿=恢复。 */
const SANITY_STATE_EMOJI: Record<string, string> = { green: '✅', yellow: '⚠️', red: '🔴' };

/** catId → 显示名；查不到（roster 未加载/未知 cat）就原样显示 catId，不造假名字。 */
function resolveCatDisplayName(catId: string): string {
  const cat = getCachedCats().find((c) => c.id === catId);
  return cat ? formatCatName(cat) : catId;
}

/**
 * 理智线 T3 sanity_state_changed 收敛为一行人话 pill（cy 2026-07-26）。
 * 原始 payload 见 invoke-single-cat.ts：
 * `{ type:'sanity_state_changed', catId, threadId, sanityLine, usedTokens, ratio, from, to }`
 * ratio = usedTokens/sanityLine（0~1 小数，见 SessionSanityMonitor.computeSanityTransition）。
 */
function formatSanityStateChanged(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const catId = typeof parsed.catId === 'string' ? parsed.catId : '';
  const from = typeof parsed.from === 'string' ? parsed.from : '';
  const to = typeof parsed.to === 'string' ? parsed.to : '';
  const ratio = typeof parsed.ratio === 'number' ? parsed.ratio : undefined;
  const displayName = catId ? resolveCatDisplayName(catId) : '未知猫';
  const fromLabel = SANITY_STATE_LABEL[from] ?? from;
  const toLabel = SANITY_STATE_LABEL[to] ?? to;
  const emoji = SANITY_STATE_EMOJI[to] ?? '⚠️';
  const pct = ratio !== undefined ? `${(ratio * 100).toFixed(1)}%` : '?';
  return {
    content: `${emoji} ${displayName} 上下文 ${pct} ${fromLabel}→${toLabel}`,
    variant: 'info',
  };
}

export function formatVisibleSystemInfo(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (isSilentSystemInfo(parsed)) {
    return null;
  }

  if (parsed?.type === 'a2a_followup_available') {
    const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
    return {
      content: mentions.map((m) => `${m.mentionedBy} @了 ${m.catId}`).join('、'),
      variant: 'a2a_followup',
    };
  }

  if (parsed?.type === 'warning') {
    const warningText = typeof parsed.message === 'string' ? parsed.message : '';
    return {
      content: warningText ? `⚠️ ${warningText}` : '⚠️ Warning',
      variant: 'info',
    };
  }

  if (parsed?.type === 'a2a_pingpong_terminated') {
    return formatPingpongTerminated(parsed);
  }

  if (parsed?.type === 'a2a_role_rejected') {
    return formatRoleRejected(parsed);
  }

  if (parsed?.type === 'sanity_state_changed') {
    return formatSanityStateChanged(parsed);
  }

  // cy 2026-07-26 追加: sanity_* 全家族兜底。任何 sanity_ 前缀但未被上面专门处理的
  // 内部事件（如 sanity_seal_cooldown_skipped，以及任何未来新增的 sanity_* 类型）
  // 统一收敛成一行紧凑文案，类型名原样带上便于排查，绝不再让裸 JSON 刷屏。
  if (typeof parsed?.type === 'string' && parsed.type.startsWith('sanity_')) {
    return { content: `⚙️ 系统事件 · ${parsed.type}`, variant: 'info' };
  }

  return null;
}
