'use client';

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/**
 * 复刻 Raft 的"长消息默认折叠"体验（铲屎官带截图指定，2026-07-27）：正文限高 + 底部
 * 渐隐遮罩(fade-out) + 次要色小号 "Show more" 链接；点击展开全文，全文底部换成
 * "Collapse" 收起。纯前端 UI 态(useState，per message)——不写 store、不持久化、不发请求。
 *
 * 折叠阈值 400px 的理由：
 * - 这是"真实渲染后的像素高度"(ResizeObserver/scrollHeight 量出来的，含 markdown 富
 *   文本/代码块/图片排版后的实际占位)，不是按字符数或行数估算。400px 在正文
 *   [font-size:var(--clowder-type-body)] + [line-height:var(--clowder-leading-body)] 的
 *   排版下大致对应 10~13 行纯文本，跟 Raft 截图里"一整段落地文字后开始起遮罩"的观感
 *   吻合，也留出足够空间让代码块/图片这类单个富文本块基本能完整看到开头。
 * - 只有 scrollHeight 明显超过阈值(> 400 * 1.25 = 500px)才提供折叠控件，避免"刚过一点点
 *   就被收起"的碎体验——踩线内容折叠后展开只多露一两行，用户还没看清就要点第二次，
 *   体验比不折叠还差。1.25 是经验缓冲值：给内容留 25% 的"免折叠"余量。
 */
const COLLAPSE_THRESHOLD_PX = 400;
const COLLAPSE_TRIGGER_RATIO = 1.25;

/** 渐隐遮罩淡出区的高度——约占阈值高度的 1/6，足够柔和又不会吃掉太多正文可视区。 */
const FADE_MASK_HEIGHT_PX = 64;

const CHAT_LAYOUT_CHANGED_EVENT = 'catcafe:chat-layout-changed';

export function CollapsibleMessageBody({
  children,
  disabled = false,
  fadeBackgroundVar = '--cafe-surface',
}: {
  children?: ReactNode;
  /**
   * 流式生成中的消息传 true：猫正在写的时候必须能实时看到全文，不折叠，否则用户会
   * 以为卡住了。判据字段见 ChatMessage.tsx 里已有的 message.isStreaming（ChatMessage
   * 渲染 CatAvatar/CliOutputBlock/打字光标都复用同一个字段，这里跟随既有判据，不新开
   * 一套)。streaming 结束(disabled 变回 false)后会照常按真实高度重新判定要不要折叠。
   */
  disabled?: boolean;
  /**
   * 渐隐遮罩要淡出到的目标背景色变量名(不含 var())，必须匹配这条消息实际坐落的背景，
   * 否则多主题下会露"白边"(或者说，露出跟气泡背景不一致的色块)。默认
   * --cafe-surface：ChatMessage.tsx 里普通 user/assistant 消息都没有单独的气泡底色，
   * 直接坐在面板背景上(只有 whisper 未揭秘态才会套 bg-conn-amber-bg)，所以默认取面板
   * 背景色即可；--cafe-surface 在 [data-theme="dark"] 下有正确的深色重定义(见
   * theme-tokens.css)，明暗主题都不会露错色。whisper 调用方应传 '--conn-amber-bg'。
   */
  fadeBackgroundVar?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsFold, setNeedsFold] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasMountedRef = useRef(false);

  // 测量真实内容高度决定要不要显示折叠控件——用 scrollHeight 而不是 clientHeight/
  // getBoundingClientRect，因为 scrollHeight 天然返回"完整内容高度"，不受同一个元素
  // 当前是否被 max-height+overflow:hidden 裁切影响，折叠态/展开态下量出来的都是同一个
  // 真实值，不会因为裁切自身而产生震荡(先折叠→量到裁切后的高度→误判"不用折叠"→展开→
  // 再次震荡)这种自反馈循环。
  //
  // 依赖数组只放 disabled：children 每次渲染都是新的对象引用，放进去只会让这个 effect
  // 无意义地跟着每次渲染重跑；内容尺寸的后续变化(流式增长/图片加载/编辑)已经由下面的
  // ResizeObserver 盯着真实渲染盒子来捕获，不需要靠 children 这个引用变化来触发。
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (disabled || !el) {
      setNeedsFold(false);
      return;
    }

    const measure = () => {
      setNeedsFold(el.scrollHeight > COLLAPSE_THRESHOLD_PX * COLLAPSE_TRIGGER_RATIO);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [disabled]);

  // 折叠/展开态切换会改变这条消息占的高度——沿用 CollapsibleMarkdown / ThinkingContent /
  // CliOutputBlock 同款约定，广播 catcafe:chat-layout-changed 让滚动跟随逻辑
  // (ScrollToBottomButton.tsx / useChatHistory.ts 监听方)重新计算。首帧不广播，避免
  // 消息一挂载就误触发一次无意义的布局重算。
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded is intentional — dispatch on toggle
  useLayoutEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
    }
  }, [expanded]);

  if (disabled) {
    return <div ref={contentRef}>{children}</div>;
  }

  const collapsed = needsFold && !expanded;

  return (
    <div>
      <div className="relative">
        <div ref={contentRef} style={collapsed ? { maxHeight: COLLAPSE_THRESHOLD_PX, overflow: 'hidden' } : undefined}>
          {children}
        </div>
        {collapsed && (
          <div
            aria-hidden="true"
            data-testid="collapsible-message-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              height: FADE_MASK_HEIGHT_PX,
              background: `linear-gradient(to top, var(${fadeBackgroundVar}), transparent)`,
            }}
          />
        )}
      </div>
      {needsFold && (
        <button
          type="button"
          data-testid="collapsible-message-toggle"
          aria-expanded={!collapsed}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-1 text-xs text-cafe-secondary transition-colors hover:text-cafe"
        >
          {collapsed ? 'Show more' : 'Collapse'}
        </button>
      )}
    </div>
  );
}
