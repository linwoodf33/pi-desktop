/**
 * 虚拟滚动纯计算（A7 方案 A：按「轮次（turn）」窗口化渲染）。
 *
 * 背景（`docs/perf/a7-memory.md`）：240 轮压测显示 RSS 增长 43.1%，根因是**全部轮次都真实渲染进 DOM**
 * （活 DOM 节点 733 → 5463，Blink embedder 堆随之增长），监听器与每轮耗时都不增长（不是泄漏）。
 * 因此 A7 的方案 A 是「只渲染视口内的轮次 + 上下缓冲」，离屏轮次用两个占位块（spacer）撑住滚动高度。
 *
 * 设计约束：
 * - **虚拟单元是轮次**（`lib/timeline.ts` 的 `groupTimeline` 输出），不是单条消息：按轮切分能让
 *   一个用户消息与它的回复始终保持在一起（时间线语义不变）；
 * - **占位块只有两个**（顶部 / 底部 spacer），不是「每轮一个空 div」——否则 DOM 节点数仍与轮数线性相关；
 * - 高度策略「测量后缓存」：已知高度用实测值，未知高度用保守估算值；估算与实测的差值靠
 *   **滚动锚点补偿**（`anchorAt` / `scrollTopFor`）修正，避免滚动时跳动。
 *
 * 本文件是纯函数、不引 React、不碰 DOM，便于单测（U-VirtualWindow）。
 */

/** 轮次之间的固定间距（与 `styles.css` 的 `.turn { margin-bottom }` 一致） */
export const TURN_GAP_PX = 14
/** 未测量轮次的保守估算槽位高度（含间距；只影响滚动条长度，滚动到该处会立刻测量并修正） */
export const DEFAULT_TURN_SLOT_PX = 360
/** 视口上方的缓冲轮数（向上滚时不易看到空白） */
export const WINDOW_BUFFER_BEFORE = 2
/** 视口下方的缓冲轮数（向下滚 / 自动跟随底部时不易看到空白） */
export const WINDOW_BUFFER_AFTER = 4
/** 判定「停在底部」的容差（px）：流式追加时 onScroll 可能读到 1~2px 的误差 */
export const BOTTOM_THRESHOLD_PX = 32
/** 视口高度未知时（首帧 / 容器未布局）使用的兜底值 */
export const FALLBACK_VIEWPORT_PX = 600

/**
 * 一轮的几何信息。
 *
 * 统一用「**槽位（slot）**」而不是「元素高度」来表达：一个槽位 = 该轮元素高度 + `TURN_GAP_PX`。
 * 这样 `offsets` 直接就是「从时间线内容顶部到第 i 轮顶部的距离」，spacer 的高度可以直接取用，
 * 不需要再和 flex `gap` 对账。
 */
export interface TurnGeometry {
  /** 每轮槽位高度（ps：长度 = 轮数） */
  slots: number[]
  /** 每轮起始偏移；`offsets.length === slots.length + 1`，最后一个元素 = 总高度 */
  offsets: number[]
  /** 所有槽位高度之和（= 时间线内容总高度，不含容器 padding） */
  total: number
  /** 已测量（有实测高度）的轮数，仅用于观测/测试 */
  measured: number
}

export interface GeometryOptions {
  /** 槽位间距（默认 `TURN_GAP_PX`） */
  gapPx?: number
  /** 未测量轮的估算槽位高度（默认 `DEFAULT_TURN_SLOT_PX`） */
  estimatePx?: number
}

/**
 * 构建几何信息：实测高度优先，其余用估算值。
 *
 * `measured` 的 key 是**轮次 id**（该轮首条消息的 key），与轮次序号解耦：
 * 会话内追加新轮次时，前面轮次的测量结果依然有效（不会因为下标变化而错位）。
 */
export function buildGeometry(
  ids: readonly string[],
  measured: ReadonlyMap<string, number>,
  options: GeometryOptions = {}
): TurnGeometry {
  const gap = options.gapPx ?? TURN_GAP_PX
  const estimate = options.estimatePx ?? DEFAULT_TURN_SLOT_PX

  const slots: number[] = new Array<number>(ids.length)
  const offsets: number[] = new Array<number>(ids.length + 1)
  let total = 0
  let measuredCount = 0

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] ?? ''
    const raw = measured.get(id)
    // 非有限值 / 非正值（测量失败、元素被 display:none）一律回退到估算值，避免 NaN 污染整条几何
    const valid = raw !== undefined && Number.isFinite(raw) && raw > 0
    const slot = valid ? raw + gap : estimate
    slots[index] = slot
    offsets[index] = total
    total += slot
    if (valid) measuredCount += 1
  }
  offsets[ids.length] = total

  return { slots, offsets, total, measured: measuredCount }
}

/**
 * 偏移量 `offsetPx` 落在第几轮（二分查找）。
 *
 * 边界：空几何 → 0；负偏移 → 0；超出总高度 → 最后一轮（滚动到流式回复区时仍算最后一轮）。
 */
export function indexAtOffset(geometry: TurnGeometry, offsetPx: number): number {
  const count = geometry.slots.length
  if (count === 0) return 0
  if (!Number.isFinite(offsetPx) || offsetPx <= 0) return 0

  let low = 0
  let high = count - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    const start = geometry.offsets[mid] ?? 0
    if (start <= offsetPx) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

export interface WindowRange {
  /** 起始轮次下标（含） */
  start: number
  /** 结束轮次下标（**不含**） */
  end: number
}

export interface WindowInput {
  /** 滚动容器当前 scrollTop 相对时间线内容顶部的偏移 */
  scrollTop: number
  /** 滚动容器可视高度 */
  viewportHeight: number
  bufferBefore?: number
  bufferAfter?: number
  /** 必须挂载的轮次（「跳转到某条消息」用） */
  forceIndex?: number | undefined
}

/**
 * 计算需要挂载的轮次窗口 `[start, end)`：视口内 + 上下缓冲。
 *
 * 不变量：结果一定非空（只要还有轮次），且不越界。
 */
export function computeWindow(geometry: TurnGeometry, input: WindowInput): WindowRange {
  const count = geometry.slots.length
  if (count === 0) return { start: 0, end: 0 }

  const viewport = input.viewportHeight > 0 ? input.viewportHeight : FALLBACK_VIEWPORT_PX
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(input.scrollTop, 0) : 0
  const bufferBefore = Math.max(0, input.bufferBefore ?? WINDOW_BUFFER_BEFORE)
  const bufferAfter = Math.max(0, input.bufferAfter ?? WINDOW_BUFFER_AFTER)

  const first = indexAtOffset(geometry, scrollTop)
  const last = indexAtOffset(geometry, scrollTop + viewport)

  let start = Math.max(0, first - bufferBefore)
  let end = Math.min(count, last + 1 + bufferAfter)

  const force = input.forceIndex
  if (force !== undefined && Number.isInteger(force) && force >= 0 && force < count) {
    if (force < start) start = force
    if (force >= end) end = force + 1
  }
  if (end <= start) end = Math.min(count, start + 1)

  return { start, end }
}

export interface BottomInput {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  threshold?: number
}

/** 是否停在底部（**跟随底部**状态机的唯一判定入口） */
export function isAtBottom(input: BottomInput): boolean {
  const threshold = Math.max(0, input.threshold ?? BOTTOM_THRESHOLD_PX)
  const remaining = input.scrollHeight - (input.scrollTop + input.clientHeight)
  return remaining <= threshold
}

/** 滚动锚点：视口顶部落在一轮的哪个位置（测量到更真实的高度后据此补偿 scrollTop） */
export interface ScrollAnchor {
  index: number
  /** 视口顶部距离该轮顶部的偏移（px） */
  offsetInTurn: number
}

/** 记录当前视口顶部锚点（内容上方高度变化时用来「钉住」视觉位置） */
export function anchorAt(geometry: TurnGeometry, scrollTop: number): ScrollAnchor {
  const index = indexAtOffset(geometry, scrollTop)
  const start = geometry.offsets[index] ?? 0
  return { index, offsetInTurn: Math.max(0, scrollTop - start) }
}

/**
 * 按锚点反算新的 scrollTop。
 *
 * 典型用法：视口上方某些轮次的估算高度被实测值替换后，用旧锚点 + 新几何重新求 scrollTop，
 * 这样用户看到的文字位置不变（滚动条滑块长度会变，这是虚拟滚动的正常表现）。
 */
export function scrollTopFor(geometry: TurnGeometry, anchor: ScrollAnchor): number {
  const count = geometry.slots.length
  if (count === 0) return 0
  const index = Math.min(Math.max(anchor.index, 0), count - 1)
  const start = geometry.offsets[index] ?? 0
  return Math.max(0, start + Math.max(0, anchor.offsetInTurn))
}

/**
 * 高度缓存（by 会话）：**按 sessionKey 隔离**，避免串会话的高度互相污染。
 *
 * 只缓存数字（每轮一个 number），占用与轮数同阶但极小（240 轮 ≈ 240 个数字），
 * 相比「整棵 DOM 子树」可以忽略。
 */
const heightCaches = new Map<string, Map<string, number>>()

/** 取某个会话的高度缓存（同一个 key 永远返回同一个 Map 实例） */
export function turnHeightCache(cacheKey: string): Map<string, number> {
  let cache = heightCaches.get(cacheKey)
  if (cache === undefined) {
    cache = new Map<string, number>()
    heightCaches.set(cacheKey, cache)
  }
  return cache
}

/** 清掉某个会话的高度缓存（会话内容被整体替换 / 分叉得到新会话时用） */
export function resetTurnHeightCache(cacheKey: string): void {
  heightCaches.delete(cacheKey)
}

/**
 * 裁掉已不存在的轮次的高度记录。
 *
 * 只在「轮次 id 集合发生变化」时调用；保留仍然存在的轮次（例如历史回放尾部替换）不会丢测量结果。
 */
export function pruneTurnHeightCache(cacheKey: string, liveIds: readonly string[]): void {
  const cache = heightCaches.get(cacheKey)
  if (cache === undefined || cache.size === 0) return
  const live = new Set(liveIds)
  for (const id of [...cache.keys()]) {
    if (!live.has(id)) cache.delete(id)
  }
}

/** 仅供测试：清空所有会话的高度缓存 */
export function clearTurnHeightCaches(): void {
  heightCaches.clear()
}
