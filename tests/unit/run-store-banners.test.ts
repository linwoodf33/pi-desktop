import { beforeEach, describe, expect, it } from 'vitest'

import { useRunStore } from '../../src/renderer/stores/runStore'

/**
 * 横幅（提示条）队列语义。
 *
 * 约束：同一条文案重复触发**替换**而不是追加 —— 用户连续点「保存设置」时，
 * 不该看到一摞内容完全相同的提示层层堆叠（E2E 截图里就暴露过这个问题）。
 * 不同文案仍然按顺序累积，最多保留 5 条。
 */
describe('runStore.pushBanner', () => {
  const push = useRunStore.getState().pushBanner
  const clear = useRunStore.getState().clearBanners

  beforeEach(() => {
    clear()
  })

  it('同一文案重复推送只保留一条（替换，不追加）', () => {
    push({ level: 'info', message: '设置已保存' })
    push({ level: 'info', message: '设置已保存' })
    push({ level: 'info', message: '设置已保存' })

    const banners = useRunStore.getState().banners
    expect(banners).toHaveLength(1)
    expect(banners[0]?.message).toBe('设置已保存')
  })

  it('替换后位置在末尾（读起来仍是「刚发生的那条在最后」）', () => {
    push({ level: 'info', message: 'A' })
    push({ level: 'info', message: 'B' })
    push({ level: 'info', message: 'A' })

    expect(useRunStore.getState().banners.map((banner) => banner.message)).toEqual(['B', 'A'])
  })

  it('level 或 detail 不同则视为不同横幅', () => {
    push({ level: 'info', message: '同样的文案' })
    push({ level: 'error', message: '同样的文案' })
    push({ level: 'info', message: '同样的文案', detail: '附注' })

    expect(useRunStore.getState().banners).toHaveLength(3)
  })

  it('不同文案累积，最多保留最近 5 条', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
      push({ level: 'info', message: letter })
    }
    expect(useRunStore.getState().banners.map((banner) => banner.message)).toEqual([
      'B',
      'C',
      'D',
      'E',
      'F'
    ])
  })

  it('dismiss 只移除指定的一条', () => {
    push({ level: 'info', message: 'A' })
    push({ level: 'info', message: 'B' })
    const first = useRunStore.getState().banners[0]
    if (first === undefined) throw new Error('缺少横幅')

    useRunStore.getState().dismissBanner(first.id)
    expect(useRunStore.getState().banners.map((banner) => banner.message)).toEqual(['B'])
  })
})
