import { describe, expect, it } from 'vitest'

import {
  STREAMING_RENDER_INTERVAL_MS,
  shouldFlushStreaming
} from '../../src/renderer/lib/streaming-throttle'

/**
 * 流式渲染节流的判定逻辑（A7 定向优化的可测核心）。
 *
 * 约束（都不能被「性能优化」破坏）：
 * - 定稿/清空/整体替换必须**立即**生效（不能让界面停在半截文本）；
 * - 纯追加按间隔节流，但最后一定会渲染（尾部保证由 hook 的定时器提供）。
 */
describe('shouldFlushStreaming', () => {
  it('文本未变化时不重渲染', () => {
    expect(shouldFlushStreaming('abc', 'abc', 1000, 80)).toBe(false)
  })

  it('距上次渲染已超过间隔 → 立即渲染', () => {
    expect(shouldFlushStreaming('abc', 'abcdef', 80, 80)).toBe(true)
    expect(shouldFlushStreaming('abc', 'abcdef', 200, 80)).toBe(true)
  })

  it('追加且未到间隔 → 暂缓（等下一个节拍）', () => {
    expect(shouldFlushStreaming('abc', 'abcdef', 10, 80)).toBe(false)
    expect(shouldFlushStreaming('abc', 'abcdef', 79, 80)).toBe(false)
  })

  it('收缩 / 清空（message_end、中止、切换任务）→ 立即生效，不做延迟', () => {
    expect(shouldFlushStreaming('abcdef', 'abc', 0, 80)).toBe(true)
    expect(shouldFlushStreaming('abcdef', '', 0, 80)).toBe(true)
    expect(shouldFlushStreaming('', 'x', 0, 80)).toBe(true)
  })

  it('权威文本整体替换（不是前缀）→ 立即生效', () => {
    expect(shouldFlushStreaming('hello wor', 'Hello world', 0, 80)).toBe(true)
  })

  it('默认间隔在「流畅」与「省渲染」之间（≥ 1 帧，≤ 200ms）', () => {
    expect(STREAMING_RENDER_INTERVAL_MS).toBeGreaterThanOrEqual(16)
    expect(STREAMING_RENDER_INTERVAL_MS).toBeLessThanOrEqual(200)
  })
})
