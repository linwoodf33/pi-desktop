import { memo, useCallback, useEffect, useMemo, useState, type RefObject } from 'react'

import type { ChatMessage } from '../../lib/reducer'
import { useThrottledStreaming } from '../../lib/streaming-throttle'
import { groupTimeline, turnToolCount, type TimelineTurn } from '../../lib/timeline'
import { useVirtualTimeline, type VirtualTimelineControls } from '../../lib/use-virtual-timeline'
import { TURN_GAP_PX } from '../../lib/virtual-window'
import { ImageLightbox } from './ImageLightbox'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

/**
 * Timeline（§5.5 features/chat/Timeline）：按 assistant turn 分组渲染消息流。
 *
 * 分组逻辑在 `lib/timeline.ts`（纯函数，单测覆盖），组件只负责排版：
 * 每一轮左侧是步骤序号（时间线轴），右侧是用户消息 + 助手回复 + 工具卡片。
 *
 * 性能（A7 方案 A：窗口化渲染）——
 * `docs/perf/a7-memory.md` 的结论是：240 轮下监听器与每轮耗时都不增长，RSS 增长全部来自
 * 「所有轮次都真实渲染在 DOM」（活 DOM 733 → 5463，Blink embedder 堆同步增长）。
 * 所以这里以**轮次**为虚拟单元（一个用户消息 + 它的回复始终在一起），只挂载
 * 「视口 + 上下缓冲（前 2 / 后 4）」内的轮次：
 * - 离屏轮次用**上下两个 spacer** 撑住滚动高度（不是「每轮一个空 div」）→ DOM 节点数与轮数解耦；
 * - 高度「测量后缓存」（`lib/virtual-window.ts`，按会话隔离），未知高度用保守估算；
 * - 估算被实测替换时按滚动锚点补偿 `scrollTop`，文字视觉位置不变（不跳动）。
 *
 * 状态机（窗口 / 测量 / 补偿 / 跟随底部）在 `lib/use-virtual-timeline.ts`，本组件只渲染。
 * 交互语义（流式跟随底部、上滚不跳回、发消息强制回底、跳到离屏轮次、会话切换重置）
 * 由该 hook 保证并被 E2E 覆盖（`tests/e2e/virtual-scroll.e2e.test.ts`）。
 */
export interface TimelineProps {
  messages: ChatMessage[]
  /** 正在流式拼接的助手文本（尚未被 message_end 覆盖） */
  streaming: string
  /** 滚动容器（对话区的 `.pane__scroll`）；不传时退化为自身父元素 */
  scrollRef?: RefObject<HTMLElement | null>
  /** 高度缓存隔离键（会话）；不同会话的测量结果互不影响 */
  cacheKey?: string
  /** 「跟随底部」状态变化（父组件据此显示/隐藏「回到底部」） */
  onFollowChange?: (following: boolean) => void
  /** 命令式控制入口（回到底部 / 跳到某轮） */
  controlsRef?: RefObject<VirtualTimelineControls | null>
}

/** 没有 cacheKey 时的兜底隔离键（单会话内行为与之前一致） */
const DEFAULT_CACHE_KEY = '__default__'

export function Timeline({
  messages,
  streaming,
  scrollRef,
  cacheKey,
  onFollowChange,
  controlsRef
}: TimelineProps) {
  const turns = useMemo(() => groupTimeline(messages), [messages])
  // 流式文本按 80ms 节流渲染（定稿文本立即生效）：高频增量下避免「每个 delta 都重解析整段 markdown」
  const streamedText = useThrottledStreaming(streaming)

  const turnIds = useMemo(() => turns.map((turn) => turn.id), [turns])

  /**
   * 「用户刚发出新消息」的触发键：最后一轮是**只有用户消息、还没有回复**的轮次。
   * 内容带上轮数，保证同一轮不会重复触发，而新一轮一定触发。
   */
  const forceBottomKey = useMemo((): string => {
    const last = turns[turns.length - 1]
    if (last === undefined || last.user === undefined) return ''
    if ((last.items?.length ?? 0) > 0) return ''
    return `${turns.length}:${last.id}`
  }, [turns])

  const scroller = useCallback((): HTMLElement | null => scrollRef?.current ?? null, [scrollRef])

  const { canvasRef, range, geometry, following, controls } = useVirtualTimeline({
    turnIds,
    cacheKey: cacheKey ?? DEFAULT_CACHE_KEY,
    forceBottomKey,
    scroller,
    contentVersion: streamedText.length
  })

  // 跟随状态变化上报给父组件（「回到底部」按钮显隐）；只在 following 变化时触发
  useEffect(() => {
    onFollowChange?.(following)
  }, [following, onFollowChange])

  // 命令式控制交给父组件（「回到底部」按钮 / 跳转到某轮）
  useEffect(() => {
    if (controlsRef === undefined) return
    controlsRef.current = controls
    return () => {
      controlsRef.current = null
    }
  }, [controlsRef, controls])

  const start = Math.min(Math.max(range.start, 0), turns.length)
  const end = Math.min(Math.max(range.end, start), turns.length)
  const visible = turns.slice(start, end)
  const topSpacer = geometry.offsets[start] ?? 0
  const bottomSpacer = Math.max(0, geometry.total - (geometry.offsets[end] ?? geometry.total))

  return (
    <div
      className="timeline"
      data-testid="timeline"
      ref={canvasRef}
      data-mounted-turns={visible.length}
      data-total-turns={turns.length}
    >
      <div
        className="timeline__spacer"
        data-testid="timeline-spacer-top"
        style={{ height: `${topSpacer}px` }}
        aria-hidden="true"
      />

      {visible.map((turn, offset) => (
        <div
          key={turn.id}
          className="timeline__item"
          data-turn-id={turn.id}
          data-turn-index={start + offset}
          style={{ marginBottom: `${TURN_GAP_PX}px` }}
        >
          <TimelineTurnView turn={turn} />
        </div>
      ))}

      <div
        className="timeline__spacer"
        data-testid="timeline-spacer-bottom"
        style={{ height: `${bottomSpacer}px` }}
        aria-hidden="true"
      />

      {streaming.length === 0 ? null : (
        <section className="turn turn--streaming" data-testid="timeline-streaming">
          <div className="turn__axis" aria-hidden="true">
            <span className="turn__index turn__index--live">·</span>
          </div>
          <div className="turn__body">
            <article className="msg msg--assistant">
              <div className="msg__role">pi（生成中）</div>
              <div className="msg__body">
                <Markdown text={streamedText} streaming />
                <span className="caret" aria-hidden="true" />
              </div>
            </article>
          </div>
        </section>
      )}
    </div>
  )
}

/** 单轮渲染（memo：已完成轮次在后续流式增量里不重渲染） */
const TimelineTurnView = memo(function TimelineTurnView({ turn }: { turn: TimelineTurn }) {
  const toolCount = turnToolCount(turn)
  /** A21：点缩略图放大看原图（undefined = 未打开） */
  const [lightboxIndex, setLightboxIndex] = useState<number | undefined>(undefined)
  return (
    <section className="turn" data-testid="timeline-turn" data-turn-number={turn.index}>
      <div className="turn__axis" aria-hidden="true">
        <span className="turn__index">{turn.index}</span>
      </div>

      <div className="turn__body">
        <header className="turn__meta">
          <span>第 {turn.index} 轮</span>
          {toolCount === 0 ? null : <span>· {toolCount} 个工具调用</span>}
        </header>

        {turn.user === undefined ? null : (
          <div className="msg msg--user" data-testid="msg-user">
            <div className="msg__role">你</div>
            <div className="msg__body">
              {turn.user.text.length === 0 ? null : <Markdown text={turn.user.text} />}
              {turn.user.images === undefined || turn.user.images.length === 0 ? null : (
                <ul className="msg__images" data-testid="msg-user-images">
                  {turn.user.images.map((image, index) => (
                    <li key={`${turn.id}-img-${index}`}>
                      <button
                        type="button"
                        className="msg__image-button"
                        data-testid="msg-user-image"
                        title="点击查看原图"
                        onClick={() => {
                          setLightboxIndex(index)
                        }}
                      >
                        <img src={image} alt={`消息图片 ${index + 1}`} loading="lazy" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {lightboxIndex === undefined || turn.user?.images === undefined ? null : (
          <ImageLightbox
            images={turn.user.images}
            initialIndex={lightboxIndex}
            onClose={() => {
              setLightboxIndex(undefined)
            }}
          />
        )}

        {turn.items.map((message) => (
          <article className="msg msg--assistant" key={message.key} data-testid="msg-assistant">
            <div className="msg__role">pi</div>
            <div className="msg__body">
              {message.text.length === 0 ? null : <Markdown text={message.text} />}
              {(message.tools ?? []).map((tool) => (
                <ToolCard key={tool.toolCallId} tool={tool} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
})
