import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../chatStore';

/**
 * 跨视图感知修复(F001): globalCatActivity 全局切片。
 *
 * 背景事故: 铲屎官在主频道 @芝芝 发任务 → thread-first 把执行路由进分支 → 芝芝干活
 * 108 秒并完成 → 铲屎官全程零感知。根因之一是 useSocket 里 cat_status(catStatusChange)
 * 事件只在猫属于"当前 thread 的 targetCats/activeInvocations"时才 setCatStatus,否则
 * 直接丢弃——分支里的执行状态对其他视图完全不可见。
 *
 * `setGlobalCatActivity` 是这条链路的落地点:无条件写入,不做"当前 thread"门槛判断。
 * 这里只测 reducer 本身的行为;useSocket 是否无条件调用它,由
 * useSocket-thread-guard.test.ts 的"跨视图感知修复"describe block 覆盖。
 */
describe('setGlobalCatActivity (F001 跨视图感知修复)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-1',
      activeInvocations: {},
      globalCatActivity: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('active 写入 catId -> {status, threadId, updatedAt}', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');

    const entry = useChatStore.getState().globalCatActivity.zhizhi;
    expect(entry?.status).toBe('active');
    expect(entry?.threadId).toBe('thread-branch-1');
    expect(typeof entry?.updatedAt).toBe('number');
  });

  it('对照组: per-thread catStatuses 完全不受影响(两个切片相互独立)', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');

    expect(useChatStore.getState().catStatuses).toEqual({});
    expect(useChatStore.getState().targetCats).toEqual([]);
  });

  it('idle 清除该 cat 的记录(不留僵尸灯)', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');
    expect(useChatStore.getState().globalCatActivity.zhizhi).toBeDefined();

    setGlobalCatActivity('zhizhi', 'idle');
    expect(useChatStore.getState().globalCatActivity.zhizhi).toBeUndefined();
  });

  it('idle 对从未出现过的 cat 是无操作(不产生新引用/不触发监听)', () => {
    const { setGlobalCatActivity } = useChatStore.getState();
    const ref1 = useChatStore.getState().globalCatActivity;

    const listener = vi.fn();
    const unsub = useChatStore.subscribe(listener);

    setGlobalCatActivity('never-seen', 'idle');

    expect(useChatStore.getState().globalCatActivity).toBe(ref1);
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('重复写入相同 status+threadId 是幂等的(引用不变,监听不触发)', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');
    const ref1 = useChatStore.getState().globalCatActivity;

    const listener = vi.fn();
    const unsub = useChatStore.subscribe(listener);

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');

    expect(useChatStore.getState().globalCatActivity).toBe(ref1);
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('同一只猫从分支 A 切换到分支 B 时 threadId 会更新', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');
    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-2');

    expect(useChatStore.getState().globalCatActivity.zhizhi?.threadId).toBe('thread-branch-2');
  });

  it('多只猫的记录互不覆盖', () => {
    const { setGlobalCatActivity } = useChatStore.getState();

    setGlobalCatActivity('zhizhi', 'active', 'thread-branch-1');
    setGlobalCatActivity('opus', 'active', 'thread-branch-2');

    const activity = useChatStore.getState().globalCatActivity;
    expect(activity.zhizhi?.threadId).toBe('thread-branch-1');
    expect(activity.opus?.threadId).toBe('thread-branch-2');

    setGlobalCatActivity('zhizhi', 'idle');
    expect(useChatStore.getState().globalCatActivity.zhizhi).toBeUndefined();
    expect(useChatStore.getState().globalCatActivity.opus?.threadId).toBe('thread-branch-2');
  });
});
