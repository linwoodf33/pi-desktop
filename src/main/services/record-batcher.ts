import { buildMergedTextDelta, readTextDelta } from '../transport/protocol'
import type { RpcRecord } from '../transport/types'

/**
 * `text_delta` 合并窗口（架构文档 §5.4 事件表：`evt:record` 逐条推送，
 * `text_delta` 合并窗口 16ms；§9.2 I9 高频 delta 不拖垮渲染帧率）。
 *
 * 规则：
 * - 连续同 `contentIndex` 的 `text_delta` 在 `windowMs` 内合并成一条记录（delta 已拼接）；
 * - 遇到任何非 `text_delta` 记录先 flush，保证事件顺序不变；
 * - `flush()` 在 `agent_settled` / 退出 / dispose 前调用，保证不丢尾巴。
 */
export const TEXT_DELTA_WINDOW_MS = 16

export interface RecordBatcherOptions {
  emit: (record: RpcRecord, mergedCount: number) => void
  windowMs?: number
}

export class RecordBatcher {
  private readonly emit: (record: RpcRecord, mergedCount: number) => void
  private readonly windowMs: number

  private buffered = ''
  private contentIndex = 0
  private count = 0
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(options: RecordBatcherOptions) {
    this.emit = options.emit
    this.windowMs = options.windowMs ?? TEXT_DELTA_WINDOW_MS
  }

  push(record: RpcRecord): void {
    if (this.disposed) return
    const delta = readTextDelta(record)
    if (!delta) {
      this.flush()
      this.emit(record, 1)
      return
    }
    if (this.count > 0 && delta.contentIndex !== this.contentIndex) this.flush()
    this.contentIndex = delta.contentIndex
    this.buffered += delta.delta
    this.count += 1
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.windowMs)
      this.timer.unref?.()
    }
  }

  /** 立即把已缓冲的 delta 作为一条合并记录吐出 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.count === 0) return
    const mergedCount = this.count
    const delta = this.buffered
    const contentIndex = this.contentIndex
    this.buffered = ''
    this.count = 0
    this.emit(buildMergedTextDelta(contentIndex, delta, mergedCount), mergedCount)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }
}
