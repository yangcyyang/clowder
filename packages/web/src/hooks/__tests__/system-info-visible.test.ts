/**
 * cy 2026-07-26: sanity_state_changed 原始 JSON 收敛为人话 pill。
 *
 * 根因定位：frontend `formatVisibleSystemInfo`（system-info-visible.ts）是
 * useAgentMessages.ts 里两条 system_info 派发路径（前台 inline + 后台
 * consumeBackgroundSystemInfo）共用的唯一"人话化"入口——两条路径都是
 * `parsed = JSON.parse(sysContent); const visible = formatVisibleSystemInfo(parsed);
 * if (visible) sysContent = visible.content; ... else if (parsed?.type === 'invocation_created') ...`
 * 这样的 if/else-if 链。`sanity_state_changed` 之前不在这条 if/else-if 链的任何分支里
 * （既不在 formatVisibleSystemInfo，也不在后续几十个 else-if），所以 consumed 恒为
 * false，兜底把原始 JSON 字符串直接塞进 type:'system' 消息——即"裸 JSON 粉条"。
 *
 * 红→绿：本测试断言 formatVisibleSystemInfo 对 sanity_state_changed 返回人话 pill，
 * 在实现前必然失败（当前返回 null）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  getCachedCats: () => [
    { id: 'gpt52', displayName: '砚砚', variantLabel: undefined },
    { id: 'opus', displayName: '布偶猫', variantLabel: '4.6' },
  ],
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

const { formatVisibleSystemInfo } = await import('../system-info-visible');

describe('formatVisibleSystemInfo — sanity_state_changed', () => {
  it('formats a green→yellow transition as a compact human-readable pill with the resolved cat name', () => {
    const result = formatVisibleSystemInfo({
      type: 'sanity_state_changed',
      catId: 'gpt52',
      threadId: 'thread-1',
      sanityLine: 120000,
      usedTokens: 96720,
      ratio: 0.806,
      from: 'green',
      to: 'yellow',
    });

    expect(result).not.toBeNull();
    expect(result?.content).toBe('⚠️ 砚砚 上下文 80.6% 绿→黄');
    expect(result?.variant).toBe('info');
  });

  it('uses 🔴 for a transition into red', () => {
    const result = formatVisibleSystemInfo({
      type: 'sanity_state_changed',
      catId: 'opus',
      from: 'yellow',
      to: 'red',
      ratio: 0.95,
    });

    expect(result?.content).toBe('🔴 布偶猫（4.6） 上下文 95.0% 黄→红');
  });

  it('uses ✅ for a recovery transition back to green', () => {
    const result = formatVisibleSystemInfo({
      type: 'sanity_state_changed',
      catId: 'opus',
      from: 'red',
      to: 'green',
      ratio: 0.1,
    });

    expect(result?.content).toBe('✅ 布偶猫（4.6） 上下文 10.0% 红→绿');
  });

  it('falls back to the raw catId when the cat cannot be resolved', () => {
    const result = formatVisibleSystemInfo({
      type: 'sanity_state_changed',
      catId: 'unknown-cat-99',
      from: 'green',
      to: 'yellow',
      ratio: 0.81,
    });

    expect(result?.content).toBe('⚠️ unknown-cat-99 上下文 81.0% 绿→黄');
  });

  it('never leaks the raw JSON shape — content is a plain human sentence, not `{"type":...}`', () => {
    const result = formatVisibleSystemInfo({
      type: 'sanity_state_changed',
      catId: 'gpt52',
      from: 'green',
      to: 'yellow',
      ratio: 0.806,
    });

    expect(result?.content).not.toMatch(/[{}]/);
    expect(result?.content).not.toContain('"type"');
  });
});
