import { beforeEach, describe, expect, it } from 'vitest'

import {
  BOTTOM_THRESHOLD_PX,
  DEFAULT_TURN_SLOT_PX,
  FALLBACK_VIEWPORT_PX,
  TURN_GAP_PX,
  WINDOW_BUFFER_AFTER,
  WINDOW_BUFFER_BEFORE,
  anchorAt,
  buildGeometry,
  clearTurnHeightCaches,
  computeWindow,
  indexAtOffset,
  isAtBottom,
  pruneTurnHeightCache,
  resetTurnHeightCache,
  scrollTopFor,
  turnHeightCache
} from '../../src/renderer/lib/virtual-window'

/**
 * 虚拟滚动纯计算单测（A7 方案 A：`lib/virtual-window.ts`）。
 *
 * 这里覆盖「窗口怎么算 / 未知高度怎么估 / 测量后怎么补偿 / 缓存怎么隔离」，
 * 组件层的滚动与跟随行为由 E2E 覆盖（`tests/e2e/virtual-scroll.e2e.test.ts`）。
 */

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `turn-${index}`)

describe('buildGeometry：实测优先、未知用估算', () => {
  it('没有实测值时每轮都用估算槽位高度', () => {
    const geometry = buildGeometry(ids(3), new Map())
    expect(geometry.slots).toEqual([
      DEFAULT_TURN_SLOT_PX,
      DEFAULT_TURN_SLOT_PX,
      DEFAULT_TURN_SLOT_PX
    ])
    expect(geometry.total).toBe(DEFAULT_TURN_SLOT_PX * 3)
    expect(geometry.measured).toBe(0)
  })

  it('实测高度会加上轮次间距（槽位 = 元素高度 + gap）', () => {
    const measured = new Map([
      ['turn-0', 100],
      ['turn-1', 200]
    ])
    const geometry = buildGeometry(ids(2), measured)
    expect(geometry.slots).toEqual([100 + TURN_GAP_PX, 200 + TURN_GAP_PX])
    expect(geometry.measured).toBe(2)
  })

  it('offsets 是前缀和，末尾元素等于总高度', () => {
    const measured = new Map([
      ['turn-0', 100],
      ['turn-2', 50]
    ])
    const geometry = buildGeometry(ids(3), measured)
    expect(geometry.offsets).toEqual([
      0,
      100 + TURN_GAP_PX,
      100 + TURN_GAP_PX + DEFAULT_TURN_SLOT_PX,
      geometry.total
    ])
  })

  it('高度按轮次 id 记录：追加新轮次不会让旧测量结果错位', () => {
    const measured = new Map([['turn-1', 300]])
    const before = buildGeometry(ids(2), measured)
    const after = buildGeometry(ids(4), measured)
    expect(before.slots[1]).toBe(300 + TURN_GAP_PX)
    expect(after.slots[1]).toBe(300 + TURN_GAP_PX)
    expect(after.slots[3]).toBe(DEFAULT_TURN_SLOT_PX)
  })

  it('非法/零高度不用（回退到估算值），避免 spacer 塌陷', () => {
    const measured = new Map([
      ['turn-0', 0],
      ['turn-1', -5],
      ['turn-2', Number.NaN]
    ])
    const geometry = buildGeometry(ids(3), measured)
    expect(geometry.slots).toEqual([
      DEFAULT_TURN_SLOT_PX,
      DEFAULT_TURN_SLOT_PX,
      DEFAULT_TURN_SLOT_PX
    ])
    expect(geometry.measured).toBe(0)
  })

  it('空轮次列表得到零高度几何', () => {
    const geometry = buildGeometry([], new Map())
    expect(geometry.slots).toEqual([])
    expect(geometry.offsets).toEqual([0])
    expect(geometry.total).toBe(0)
  })

  it('可覆盖 gap / 估算值（测试与调参用）', () => {
    const geometry = buildGeometry(ids(2), new Map([['turn-0', 10]]), {
      gapPx: 4,
      estimatePx: 50
    })
    expect(geometry.slots).toEqual([14, 50])
  })
})

describe('indexAtOffset：偏移量 → 轮次下标', () => {
  const geometry = buildGeometry(ids(3), new Map(), { gapPx: 0, estimatePx: 100 })

  it('命中每轮起点', () => {
    expect(indexAtOffset(geometry, 0)).toBe(0)
    expect(indexAtOffset(geometry, 100)).toBe(1)
    expect(indexAtOffset(geometry, 250)).toBe(2)
  })

  it('负偏移 / 超出总高度时收敛到首轮与末轮', () => {
    expect(indexAtOffset(geometry, -50)).toBe(0)
    expect(indexAtOffset(geometry, 10_000)).toBe(2)
  })

  it('空几何返回 0（调用方不会拿到负数下标）', () => {
    expect(indexAtOffset(buildGeometry([], new Map()), 123)).toBe(0)
  })
})

describe('computeWindow：视口 + 上下缓冲', () => {
  const geometry = buildGeometry(ids(20), new Map(), { gapPx: 0, estimatePx: 100 })

  it('视口在顶部：窗口从第 0 轮开始，向前没有缓冲可给', () => {
    const range = computeWindow(geometry, { scrollTop: 0, viewportHeight: 300 })
    expect(range.start).toBe(0)
    // 视口覆盖 0..3 轮（3 轮起点在视口内），再往后加 WINDOW_BUFFER_AFTER 轮
    expect(range.end).toBe(3 + 1 + WINDOW_BUFFER_AFTER)
  })

  it('视口在中间：前后都有缓冲', () => {
    const range = computeWindow(geometry, { scrollTop: 1000, viewportHeight: 300 })
    expect(range.start).toBe(10 - WINDOW_BUFFER_BEFORE)
    expect(range.end).toBe(13 + 1 + WINDOW_BUFFER_AFTER)
  })

  it('视口在底部：窗口右侧被裁到总轮数（不会越界）', () => {
    const range = computeWindow(geometry, { scrollTop: geometry.total - 300, viewportHeight: 300 })
    expect(range.end).toBe(20)
    expect(range.start).toBeGreaterThan(0)
  })

  it('视口高度未知（0）时用兜底高度，窗口不为空', () => {
    const range = computeWindow(geometry, { scrollTop: 0, viewportHeight: 0 })
    expect(range.start).toBe(0)
    expect(range.end).toBeGreaterThan(1)
    expect(range.end).toBe(FALLBACK_VIEWPORT_PX / 100 + 1 + WINDOW_BUFFER_AFTER)
  })

  it('空会话得到空窗口', () => {
    expect(
      computeWindow(buildGeometry([], new Map()), { scrollTop: 0, viewportHeight: 500 })
    ).toEqual({ start: 0, end: 0 })
  })

  it('forceIndex 保证目标轮一定被挂载（跳转到离屏轮次）', () => {
    const range = computeWindow(geometry, {
      scrollTop: 0,
      viewportHeight: 300,
      forceIndex: 18
    })
    expect(range.start).toBe(0)
    expect(range.end).toBeGreaterThan(18)
  })

  it('forceIndex 在窗口之前时把 start 往前扩（不改变原有 end）', () => {
    const range = computeWindow(geometry, {
      scrollTop: 1000,
      viewportHeight: 300,
      forceIndex: 0
    })
    expect(range.start).toBe(0)
    expect(range.end).toBe(13 + 1 + WINDOW_BUFFER_AFTER)
  })

  it('越界的 forceIndex 被忽略，窗口仍非空', () => {
    const range = computeWindow(geometry, { scrollTop: 0, viewportHeight: 300, forceIndex: 999 })
    expect(range.start).toBe(0)
    expect(range.end).toBeLessThanOrEqual(20)
  })
})

describe('isAtBottom：跟随底部的判定', () => {
  it('差值在容差内算在底部（流式追加的 1~2px 误差不该退出跟随）', () => {
    expect(isAtBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true)
    expect(
      isAtBottom({
        scrollTop: 1000 - 300 - BOTTOM_THRESHOLD_PX,
        scrollHeight: 1000,
        clientHeight: 300
      })
    ).toBe(true)
  })

  it('离开底部超过容差就不是', () => {
    expect(
      isAtBottom({
        scrollTop: 1000 - 300 - BOTTOM_THRESHOLD_PX - 1,
        scrollHeight: 1000,
        clientHeight: 300
      })
    ).toBe(false)
  })

  it('内容比视口还短时算在底部', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 300 })).toBe(true)
  })
})

describe('anchorAt / scrollTopFor：测量后补偿滚动位置', () => {
  it('视口上方轮次变高后，锚点对应的文字位置不变（scrollTop 增大）', () => {
    const before = buildGeometry(ids(10), new Map(), { gapPx: 0, estimatePx: 100 })
    // 视口顶部落在第 5 轮内部 30px 处
    const anchor = anchorAt(before, 530)
    expect(anchor).toEqual({ index: 5, offsetInTurn: 30 })

    // 前 5 轮实测都比估算高很多（内容更长）
    const measured = new Map(ids(5).map((id) => [id, 300]))
    const after = buildGeometry(ids(10), measured, { gapPx: 0, estimatePx: 100 })
    // 锚点仍在第 5 轮内部 30px：新偏移 = 5*300 + 30
    expect(scrollTopFor(after, anchor)).toBe(5 * 300 + 30)
    expect(scrollTopFor(after, anchor)).toBeGreaterThan(530)
  })

  it('上方轮次比估算矮时 scrollTop 相应减小（不出现跳动）', () => {
    const before = buildGeometry(ids(10), new Map(), { gapPx: 0, estimatePx: 100 })
    const anchor = anchorAt(before, 530)
    const measured = new Map(ids(5).map((id) => [id, 40]))
    const after = buildGeometry(ids(10), measured, { gapPx: 0, estimatePx: 100 })
    expect(scrollTopFor(after, anchor)).toBe(5 * 40 + 30)
  })

  it('锚点下标越界时收敛到边界，结果不会为负', () => {
    const geometry = buildGeometry(ids(3), new Map(), { gapPx: 0, estimatePx: 100 })
    expect(scrollTopFor(geometry, { index: 99, offsetInTurn: 10 })).toBe(210)
    expect(scrollTopFor(geometry, { index: -5, offsetInTurn: -10 })).toBe(0)
    expect(scrollTopFor(buildGeometry([], new Map()), { index: 0, offsetInTurn: 0 })).toBe(0)
  })

  it('锚点往返一致：几何不变时 scrollTopFor(anchorAt(x)) === x', () => {
    const geometry = buildGeometry(ids(10), new Map([['turn-2', 77]]), {
      gapPx: 6,
      estimatePx: 120
    })
    for (const value of [0, 15, 126, 300, 651]) {
      expect(scrollTopFor(geometry, anchorAt(geometry, value))).toBe(value)
    }
  })
})

describe('大历史（历史回放 2000 条上限）也不退化', () => {
  it('2000 轮的几何与窗口计算是毫秒级（不得引入 O(轮²)）', () => {
    const bigIds = Array.from({ length: 2000 }, (_, index) => `turn-${index}`)
    const startedAt = performance.now()
    let last = 0
    for (let index = 0; index < 50; index += 1) {
      const geometry = buildGeometry(bigIds, new Map())
      const range = computeWindow(geometry, {
        scrollTop: index * 5_000,
        viewportHeight: 700
      })
      last = range.end - range.start
    }
    const elapsed = performance.now() - startedAt
    // 50 次 = 10 万轮次槽位的构建 + 100 次二分;留足 CI 余量（本地实测 < 20ms）
    expect(elapsed).toBeLessThan(1_000)
    // 窗口大小与总轮数无关（封顶在「视口 + 缓冲」量级）
    expect(last).toBeLessThanOrEqual(WINDOW_BUFFER_BEFORE + 1 + WINDOW_BUFFER_AFTER + 4)
  })

  it('2000 轮时偏移量仍然单调递增、总高度等于各项之和', () => {
    const bigIds = Array.from({ length: 2000 }, (_, index) => `turn-${index}`)
    const geometry = buildGeometry(bigIds, new Map())
    expect(geometry.total).toBe(DEFAULT_TURN_SLOT_PX * 2000)
    expect(geometry.offsets.at(-1)).toBe(geometry.total)
    for (let index = 1; index < geometry.offsets.length; index += 1) {
      expect(geometry.offsets[index] ?? 0).toBeGreaterThan(geometry.offsets[index - 1] ?? 0)
    }
    // 末轮定位正确（回放后「滚到底部」要落在最后一轮）
    expect(indexAtOffset(geometry, geometry.total - 1)).toBe(1999)
  })
})

describe('高度缓存：按会话隔离', () => {
  beforeEach(() => {
    clearTurnHeightCaches()
  })

  it('不同 sessionKey 拿到不同的 Map（互不污染）', () => {
    const a = turnHeightCache('session-a')
    const b = turnHeightCache('session-b')
    expect(a).not.toBe(b)
    a.set('turn-0', 100)
    expect(b.has('turn-0')).toBe(false)
  })

  it('同一个 sessionKey 复用同一个 Map（切换回来仍记得高度）', () => {
    turnHeightCache('session-a').set('turn-0', 100)
    expect(turnHeightCache('session-a').get('turn-0')).toBe(100)
  })

  it('reset 只清指定会话', () => {
    turnHeightCache('session-a').set('turn-0', 100)
    turnHeightCache('session-b').set('turn-0', 200)
    resetTurnHeightCache('session-a')
    expect(turnHeightCache('session-a').size).toBe(0)
    expect(turnHeightCache('session-b').get('turn-0')).toBe(200)
  })

  it('prune 裁掉已消失的轮次、保留仍存在的（历史回放尾部替换）', () => {
    const cache = turnHeightCache('session-a')
    cache.set('keep', 100)
    cache.set('gone', 200)
    pruneTurnHeightCache('session-a', ['keep', 'new'])
    expect([...cache.keys()]).toEqual(['keep'])
  })

  it('prune 对未知会话是空操作（不创建空 Map）', () => {
    expect(() => {
      pruneTurnHeightCache('missing', ['x'])
    }).not.toThrow()
  })
})
