import { describe, expect, it } from 'vitest'

import { RecordBatcher, TEXT_DELTA_WINDOW_MS } from '../../src/main/services/record-batcher'
import type { RpcRecord } from '../../src/main/transport/types'
import { readTextDelta } from '../../src/main/transport/protocol'

/** §5.4 事件表：`text_delta` 合并窗口 16ms；§9.2 I9 高频 delta 不拖垮渲染 */

function delta(text: string, contentIndex = 0): RpcRecord {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text }
  }
}

function collect(windowMs = 10): { batcher: RecordBatcher; emitted: RpcRecord[] } {
  const emitted: RpcRecord[] = []
  const batcher = new RecordBatcher({
    windowMs,
    emit: (record) => emitted.push(record)
  })
  return { batcher, emitted }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('RecordBatcher', () => {
  it('默认窗口是 16ms（§5.4）', () => {
    expect(TEXT_DELTA_WINDOW_MS).toBe(16)
  })

  it('窗口内的多条 text_delta 合并成一条记录（delta 拼接）', async () => {
    const { batcher, emitted } = collect()
    batcher.push(delta('He'))
    batcher.push(delta('llo'))
    batcher.push(delta(' world'))

    expect(emitted).toHaveLength(0)
    await sleep(25)

    expect(emitted).toHaveLength(1)
    const merged = emitted[0]
    expect(merged?.['mergedCount']).toBe(3)
    expect(readTextDelta(merged as RpcRecord)).toEqual({ contentIndex: 0, delta: 'Hello world' })
  })

  it('非 text_delta 记录先 flush，保证事件顺序不变', () => {
    const { batcher, emitted } = collect()
    batcher.push(delta('a'))
    batcher.push(delta('b'))
    batcher.push({ type: 'turn_end' })

    expect(emitted.map((record) => record.type)).toEqual(['message_update', 'turn_end'])
    expect(readTextDelta(emitted[0] as RpcRecord)?.delta).toBe('ab')
  })

  it('contentIndex 变化时先 flush 旧块', () => {
    const { batcher, emitted } = collect()
    batcher.push(delta('a', 0))
    batcher.push(delta('b', 1))

    expect(emitted).toHaveLength(1)
    expect(readTextDelta(emitted[0] as RpcRecord)).toEqual({ contentIndex: 0, delta: 'a' })
  })

  it('flush() 立即吐出缓冲，重复 flush 不重复发射', () => {
    const { batcher, emitted } = collect(1000)
    batcher.push(delta('x'))
    batcher.flush()
    batcher.flush()

    expect(emitted).toHaveLength(1)
    expect(readTextDelta(emitted[0] as RpcRecord)?.delta).toBe('x')
  })

  it('dispose() 冲掉尾巴后不再发射', () => {
    const { batcher, emitted } = collect(1000)
    batcher.push(delta('tail'))
    batcher.dispose()
    batcher.push(delta('ignored'))

    expect(emitted).toHaveLength(1)
    expect(readTextDelta(emitted[0] as RpcRecord)?.delta).toBe('tail')
  })

  it('合并记录仍能被 readTextDelta 识别（渲染侧无需特殊分支）', async () => {
    const { batcher, emitted } = collect()
    batcher.push(delta('一'))
    batcher.push(delta('二'))
    await sleep(25)

    const merged = emitted[0] as RpcRecord
    expect(merged.type).toBe('message_update')
    expect(merged['assistantMessageEvent']).toMatchObject({ type: 'text_delta', contentIndex: 0 })
  })

  it('非 delta 记录原样透传', () => {
    const { batcher, emitted } = collect()
    batcher.push({ type: 'agent_start' })
    expect(emitted).toEqual([{ type: 'agent_start' }])
  })
})
