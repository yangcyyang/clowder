/**
 * 理智线 T6（task #388）：Claude 配额（session limit）文本扫描检测器。
 *
 * Claude CLI 目前没有可靠的结构化终态信号标记"这轮撞到了配额限制"（已排查：
 * result/error 的 subtype 分类表里没有对应变体；rate_limit_event 只是接近上限
 * 时的遥测预警，命中时不一定跟这句提示同现——见 #388 gate 报告的排查证据）。
 * V0 退而求其次用文本扫描，但为了压低误判率（一只猫在正常对话中引用/转述这句
 * 提示不该被误判成撞额度），加了两条硬约束：
 * 1. 尾部锚定——只在完整回复的末尾匹配，不扫中段（真撞额度时 CLI 的提示就是
 *    回复本身或回复的截断结尾，不会嵌在大段实质内容中间；这是三条真样本共有的
 *    位置特征）。
 * 2. 精确格式——不做宽松匹配。
 * 宁可漏判（=现状：普通报错，无冷却无回归）也不误判（=好猫被无辜冷却 30 分钟）。
 *
 * resetAt 解析优先级：同轮若有 rate_limit_event 的结构化 resetsAt，优先用它
 * （比解析口语时间可靠）；没有就退到解析文本里的"H:MMam/pm (时区)"——这是不带
 * 日期的下一次出现时刻，需要"今天这个点还没过就是今天，过了就是明天"逻辑，
 * 并且要按文本里给的 IANA 时区解析（服务器本地时区可能跟文本时区不同）。
 */

const SESSION_LIMIT_TAIL_PATTERN =
  /You(?:'|’)ve hit your session limit\s*·\s*resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)\s*\**\s*$/i;

export type ClaudeQuotaResetSource = 'rate_limit_event' | 'text_parse' | 'unresolved';

export interface ClaudeQuotaSignal {
  readonly errorCode: 'usage_limit';
  readonly resetAt?: number;
  readonly matchedText: string;
  readonly resetSource: ClaudeQuotaResetSource;
}

export interface DetectClaudeQuotaSignalOptions {
  /** Structured resetsAt (epoch ms) from a rate_limit_event seen in the same turn, if any — preferred over text parsing. */
  readonly concurrentResetAtMs?: number;
}

export function detectClaudeQuotaSignal(
  fullText: string,
  options: DetectClaudeQuotaSignalOptions = {},
  now: number = Date.now(),
): ClaudeQuotaSignal | undefined {
  const match = SESSION_LIMIT_TAIL_PATTERN.exec(fullText.trimEnd());
  if (!match) return undefined;

  if (options.concurrentResetAtMs !== undefined) {
    return {
      errorCode: 'usage_limit',
      resetAt: options.concurrentResetAtMs,
      matchedText: match[0],
      resetSource: 'rate_limit_event',
    };
  }

  const [, rawHour, rawMinute, meridiem, timezone] = match;
  const resetAt = resolveNextOccurrenceInTimezone(
    Number(rawHour),
    Number(rawMinute),
    meridiem!.toLowerCase(),
    timezone!,
    now,
  );
  return {
    errorCode: 'usage_limit',
    ...(resetAt !== undefined ? { resetAt } : {}),
    matchedText: match[0],
    resetSource: resetAt !== undefined ? 'text_parse' : 'unresolved',
  };
}

/** Returns the zone's UTC offset (ms, positive east of UTC) at the given instant, or undefined for an unrecognized timezone. */
function getTimezoneOffsetMs(timezone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    if (Number.isNaN(asUTC)) return undefined;
    return asUTC - at.getTime();
  } catch {
    return undefined;
  }
}

/**
 * "H:MM am/pm (timezone)" carries no date — resolve to the next future occurrence
 * of that wall-clock time in the given IANA timezone (today if still ahead, else
 * tomorrow), using `now` as the reference instant.
 */
function resolveNextOccurrenceInTimezone(
  hour12: number,
  minute: number,
  meridiem: string,
  timezone: string,
  now: number,
): number | undefined {
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return undefined;
  const hour24 = (hour12 % 12) + (meridiem === 'pm' ? 12 : 0);

  const offsetMs = getTimezoneOffsetMs(timezone, new Date(now));
  if (offsetMs === undefined) return undefined;

  // Today's Y/M/D as seen in the target timezone (via the same offset trick).
  const nowInZoneParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string): number => Number(nowInZoneParts.find((p) => p.type === type)?.value ?? Number.NaN);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return undefined;

  const candidateUTCGuess = Date.UTC(year, month - 1, day, hour24, minute, 0);
  let candidateInstant = candidateUTCGuess - offsetMs;
  if (candidateInstant <= now) {
    candidateInstant += 24 * 60 * 60 * 1000;
  }
  return candidateInstant;
}
