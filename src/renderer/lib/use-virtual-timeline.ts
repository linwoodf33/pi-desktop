import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'

import {
  anchorAt,
  buildGeometry,
  computeWindow,
  isAtBottom,
  pruneTurnHeightCache,
  scrollTopFor,
  turnHeightCache,
  type ScrollAnchor,
  type TurnGeometry,
  type WindowRange
} from './virtual-window'
import { countLiveDomNodes, installVirtualControl } from './virtual-bridge'

/**
 * 虚拟滚动的状态机（A7 方案 A）：把「窗口计算 + 高度测量 + 滚动补偿 + 跟随底部」从组件里拆出来。
 *
 * 组件（`features/chat/Timeline.tsx`）只负责渲染 `range` 内的轮次和两个 spacer；
 * 这里负责所有副作用（scroll / ResizeObserver / layout effect 落位）。
 *
 * 交互语义（唯一真源，E2E 覆盖）：
 * - `following`：停在底部时为 true。**只有用户把视口滚离底部才会退出**；
 *   「内容变高导致暂时不在底部」不会退出（那种情况直接 pin 回底部）；
 * - 用户发送新消息（`forceBottomKey` 变化）→ 强制回底；
 * - `scrollToTurn(i)` → 把离屏轮次挂载进来并滚过去（跳转期间不做跟随/锚点补偿）；
 * - 会话切换（`cacheKey` 变化）→ 换高度缓存、清待处理状态、回到底部。
 */
export interface VirtualTimelineControls {
  /** 回到最新消息（底部） */
  scrollToBottom: () => void
  /** 滚动到第 index 轮（0 基）；离屏轮次会被挂载 */
  scrollToTurn: (index: number) => void
}

export interface UseVirtualTimelineOptions {
  /** 轮次 id 列表（`groupTimeline(...).map(t => t.id)`） */
  turnIds: readonly string[]
  /** 高度缓存隔离键（会话 id） */
  cacheKey: string
  /**
   * 「强制回底」触发键：用户刚发出新消息时变化（内容形如 `轮数:首条消息 key`），
   * 空字符串表示当前没有待回复的用户消息。
   */
  forceBottomKey?: string
  /** 滚动容器获取器（对话区 `.pane__scroll`） */
  scroller: () => HTMLElement | null
  /** 内容版本号：流式文本/轮次变化时递增，用于在「跟随底部」时重新落位 */
  contentVersion: number
}

export interface VirtualTimelineState {
  /** 时间线根元素（spacer 与轮次的父节点；子元素需带 `data-turn-id` / `data-turn-index`） */
  canvasRef: RefObject<HTMLDivElement | null>
  /** 需要挂载的轮次窗口 `[start, end)` */
  range: WindowRange
  /** 几何信息（含每轮偏移与总高度，供 spacer 使用） */
  geometry: TurnGeometry
  /** 是否跟随底部 */
  following: boolean
  /** 命令式控制（与 `lib/virtual-bridge.ts` 暴露给压测/E2E 的是同一个） */
  controls: VirtualTimelineControls
}

export function useVirtualTimeline(options: UseVirtualTimelineOptions): VirtualTimelineState {
  const { turnIds, cacheKey, forceBottomKey = '', scroller, contentVersion } = options

  const canvasRef = useRef<HTMLDivElement | null>(null)
  /** 该会话的高度缓存（模块级 Map，按 sessionKey 隔离；只在事件回调里读写，不在渲染期读） */
  const heightCache = turnHeightCache(cacheKey)
  const [heightsVersion, setHeightsVersion] = useState(0)
  const [jumpToken, setJumpToken] = useState(0)
  const [range, setRange] = useState<WindowRange>({ start: 0, end: 0 })
  const [following, setFollowing] = useState(true)

  const followingRef = useRef(true)
  /** 视口顶部相对时间线内容顶部的偏移（已减去容器内其它元素与 timeline 的 padding） */
  const scrollTopRef = useRef(0)
  const viewportRef = useRef(0)
  /** 待补偿的滚动锚点（实测高度替换估算高度后由 layout effect 应用） */
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null)
  /** 待跳转的轮次下标（非空时只做跳转，不做跟随/锚点补偿） */
  const pendingJumpRef = useRef<number | null>(null)

  const geometry = useMemo(() => {
    // heightsVersion 不进计算，只用来表达「测量结果变了，需要重建几何」（缓存是可变 Map）
    void heightsVersion
    return buildGeometry(turnIds, turnHeightCache(cacheKey))
  }, [turnIds, cacheKey, heightsVersion])

  // 事件回调（scroll / ResizeObserver / layout effect）要读「最新」几何与轮次；
  // 在 layout effect 里同步 ref，避免渲染期读写 ref。
  const geometryRef = useRef(geometry)
  const turnIdsRef = useRef(turnIds)
  useLayoutEffect(() => {
    geometryRef.current = geometry
    turnIdsRef.current = turnIds
  }, [geometry, turnIds])

  const bumpHeights = useCallback((): void => {
    setHeightsVersion((version) => version + 1)
  }, [])

  /** 时间线内容顶部相对容器滚动内容顶部的偏移（含 timeline 自身的 padding-top） */
  const localOrigin = useCallback((container: HTMLElement): number => {
    const canvas = canvasRef.current
    if (canvas === null) return 0
    const canvasTop =
      canvas.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop
    const paddingTop = Number.parseFloat(getComputedStyle(canvas).paddingTop) || 0
    return canvasTop + paddingTop
  }, [])

  const applyFollowing = useCallback((next: boolean): void => {
    if (followingRef.current === next) return
    followingRef.current = next
    setFollowing(next)
  }, [])

  const findMountedSlot = useCallback((index: number): HTMLElement | null => {
    const canvas = canvasRef.current
    if (canvas === null) return null
    const wanted = String(index)
    for (const child of Array.from(canvas.children)) {
      if (child instanceof HTMLElement && child.dataset['turnIndex'] === wanted) return child
    }
    return null
  }, [])

  /**
   * 从真实滚动位置同步「跟随状态」与「挂载窗口」。
   *
   * 同步执行（不用 rAF 节流）：滚动事件先于下一帧的 layout effect 处理，
   * 用户的「上滚」能立刻被记住，不会被随后的「跟随底部」拽回去。
   */
  const sync = useCallback((): void => {
    const container = scroller()
    if (container === null) return
    const viewport = container.clientHeight
    const local = Math.max(0, container.scrollTop - localOrigin(container))
    scrollTopRef.current = local
    viewportRef.current = viewport

    const atBottom = isAtBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: viewport
    })
    applyFollowing(atBottom)

    const geo = geometryRef.current
    // 跟随底部时以「内容底部」为锚：否则新增轮次时 scrollTop 未变，最新轮次落不到窗口里
    const windowTop = followingRef.current ? Math.max(0, geo.total - viewport) : local
    const jump = pendingJumpRef.current
    const next = computeWindow(geo, {
      scrollTop: windowTop,
      viewportHeight: viewport,
      forceIndex: jump ?? undefined
    })
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [applyFollowing, localOrigin, scroller])

  /** 同步测量所有已挂载轮次（`offsetHeight`，不等 ResizeObserver 回调） */
  const measureMounted = useCallback((): boolean => {
    const canvas = canvasRef.current
    if (canvas === null) return false
    let changed = false
    let anchor: ScrollAnchor | null = null
    for (const child of Array.from(canvas.children)) {
      if (!(child instanceof HTMLElement)) continue
      const id = child.dataset['turnId']
      if (id === undefined || id.length === 0) continue
      const height = Math.round(child.offsetHeight)
      if (!Number.isFinite(height) || height <= 0) continue
      const previous = heightCache.get(id)
      if (previous !== undefined && Math.abs(previous - height) < 0.5) continue
      if (!changed && !followingRef.current) {
        // 高度变化会影响锚点：先按**旧几何**记下视口顶部位置
        anchor = anchorAt(geometryRef.current, scrollTopRef.current)
      }
      heightCache.set(id, height)
      changed = true
    }
    if (!changed) return false
    pendingAnchorRef.current = anchor
    return true
  }, [heightCache])

  useEffect(() => {
    // 会话切换：清掉待处理的锚点/跳转，回到最新消息。
    // 高度缓存按 sessionKey 隔离（`turnHeightCache`），几何也会随 cacheKey 变化重建，无需手动失效。
    pendingAnchorRef.current = null
    pendingJumpRef.current = null
    applyFollowing(true)
  }, [cacheKey, applyFollowing])

  // 轮次集合变化时裁掉已消失轮次的高度记录（保留仍存在的）
  useEffect(() => {
    pruneTurnHeightCache(cacheKey, turnIds)
  }, [cacheKey, turnIds])

  // 滚动容器：scroll（同步）+ 尺寸变化（面板折叠 / 窗口缩放）
  useEffect(() => {
    const container = scroller()
    if (container === null) return
    const onScroll = (): void => {
      sync()
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(() => {
      sync()
    })
    observer.observe(container)
    sync()
    return () => {
      container.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [scroller, sync])

  // 已挂载轮次的测量：`observe()` 会立即回调一次（首帧测量），此后内容变化（工具卡展开、
  // 图片加载、字体回退…）也会回调。测量结果写入高度缓存并触发一次几何重建。
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const observer = new ResizeObserver(() => {
      if (measureMounted()) bumpHeights()
    })
    for (const child of Array.from(canvas.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child.dataset['turnId'] === undefined) continue
      observer.observe(child)
    }
    return () => {
      observer.disconnect()
    }
  }, [measureMounted, bumpHeights, range.start, range.end])

  // 用户刚发出新消息（乐观插入、尚无回复）→ 强制回底
  const previousForceBottomRef = useRef('')
  useLayoutEffect(() => {
    const previous = previousForceBottomRef.current
    previousForceBottomRef.current = forceBottomKey
    if (forceBottomKey.length === 0 || forceBottomKey === previous) return
    pendingJumpRef.current = null
    pendingAnchorRef.current = null
    applyFollowing(true)
  }, [forceBottomKey, applyFollowing])

  // 滚动落位：跳转 > 跟随底部 > 锚点补偿
  useLayoutEffect(() => {
    const container = scroller()
    if (container === null) return
    const origin = localOrigin(container)
    const geo = geometryRef.current
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)

    const jump = pendingJumpRef.current
    if (jump !== null) {
      const target = Math.min(Math.max(0, (geo.offsets[jump] ?? 0) + origin), maxTop)
      if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target
      const id = turnIdsRef.current[jump]
      const measured = id !== undefined && heightCache.has(id)
      if (findMountedSlot(jump) !== null && measured) {
        // 目标轮已挂载且高度已知：再对齐一次（修正估算误差）后结束跳转
        const settled = Math.min(
          Math.max(0, (geo.offsets[jump] ?? 0) + origin),
          Math.max(0, container.scrollHeight - container.clientHeight)
        )
        if (Math.abs(container.scrollTop - settled) > 1) container.scrollTop = settled
        pendingJumpRef.current = null
      }
      return
    }

    if (followingRef.current) {
      const target = Math.max(0, container.scrollHeight - container.clientHeight)
      if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target
      pendingAnchorRef.current = null
      // 窗口跟着底部走（新增轮次 / 流式文本变高后要挂载最新轮次）
      sync()
      return
    }

    const anchor = pendingAnchorRef.current
    if (anchor !== null) {
      pendingAnchorRef.current = null
      const target = Math.min(Math.max(0, scrollTopFor(geo, anchor) + origin), maxTop)
      if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target
    }
  }, [
    geometry,
    range,
    turnIds,
    contentVersion,
    following,
    jumpToken,
    localOrigin,
    scroller,
    sync,
    findMountedSlot,
    heightCache
  ])

  const scrollToBottom = useCallback((): void => {
    pendingJumpRef.current = null
    pendingAnchorRef.current = null
    applyFollowing(true)
    const container = scroller()
    if (container === null) return
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    sync()
  }, [applyFollowing, scroller, sync])

  const scrollToTurn = useCallback(
    (index: number): void => {
      const count = turnIdsRef.current.length
      if (!Number.isInteger(index) || index < 0 || index >= count) return
      pendingJumpRef.current = index
      pendingAnchorRef.current = null
      applyFollowing(index === count - 1)
      const geo = geometryRef.current
      const next = computeWindow(geo, {
        scrollTop: geo.offsets[index] ?? 0,
        viewportHeight: viewportRef.current,
        forceIndex: index
      })
      // 目标轮必须挂载（否则既测不到高度，也渲染不出内容）
      setRange((prev) => ({
        start: Math.min(prev.start, next.start),
        end: Math.max(prev.end, next.end)
      }))
      setJumpToken((token) => token + 1)
    },
    [applyFollowing]
  )

  const controls = useMemo<VirtualTimelineControls>(
    () => ({ scrollToBottom, scrollToTurn }),
    [scrollToBottom, scrollToTurn]
  )

  // 观测钩子（压测 / E2E 用；不渲染任何东西、不含消息内容）
  useEffect(() => {
    return installVirtualControl({
      metrics: () => {
        const container = scroller()
        const canvas = canvasRef.current
        const scrollTop = container?.scrollTop ?? 0
        const scrollHeight = container?.scrollHeight ?? 0
        const clientHeight = container?.clientHeight ?? 0
        return {
          mountedTurns: canvas === null ? 0 : canvas.querySelectorAll('[data-turn-id]').length,
          totalTurns: turnIdsRef.current.length,
          liveDomNodes: countLiveDomNodes(),
          scrollTop,
          scrollHeight,
          clientHeight,
          following: followingRef.current,
          atBottom: isAtBottom({ scrollTop, scrollHeight, clientHeight })
        }
      },
      scrollToTurn,
      scrollToBottom
    })
  }, [scroller, scrollToBottom, scrollToTurn])

  return { canvasRef, range, geometry, following, controls }
}
