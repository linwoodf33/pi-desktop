import { describe, expect, it } from 'vitest'

import { initialChatState, reduceRecord, reduceRecords } from '../../src/renderer/lib/reducer'

/**
 * 模型调用失败的消息归约（§5.1）。
 *
 * 归约层只做**透传**：`message_end` 里的 `stopReason` / `errorMessage` 原样进入 `ChatMessage`，
 * **不做合并、不做文案加工**（文案在 `lib/message-error.ts`，折叠在 `lib/timeline.ts`）。
 * 一条失败尝试就是一条消息 —— 与 JSONL 一一对应，历史回放才能得到同样的时间线。
 */
type JsonRecord = { type: string; [key: string]: unknown }

const ERROR_TEXT = 'Request timed out.: Connect Timeout Error (mock)'

/** pi 重试失败时的 message 形态：`content: []` + `stopReason: 'error'` + `errorMessage` */
function failedEnd(timestamp?: number, errorMessage: unknown = ERROR_TEXT): JsonRecord {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage,
      ...(timestamp === undefined ? {} : { timestamp })
    }
  }
}

/** 正常 / 中止消息（可给 stopReason，**没有** errorMessage） */
function plainEnd(text: string, stopReason?: string, timestamp = 1733234402000): JsonRecord {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: text.length === 0 ? [] : [{ type: 'text', text }],
      ...(stopReason === undefined ? {} : { stopReason }),
      timestamp
    }
  }
}

describe('失败消息透传（stopReason / errorMessage）', () => {
  it('失败 message_end 进入 messages 并带 error / stopReason', () => {
    const state = reduceRecords(initialChatState, [failedEnd(1733234402000)])

    expect(state.messages).toHaveLength(1)
    const message = state.messages[0]
    expect(message?.text).toBe('')
    expect(message?.error).toBe(ERROR_TEXT)
    expect(message?.stopReason).toBe('error')
    expect(message?.key ?? '').toMatch(/^assistant:/)
  })

  it('正常回复不产生 error 属性（消息形状稳定）', () => {
    const state = reduceRecords(initialChatState, [plainEnd('你好', 'stop')])

    const message = state.messages[0]
    expect(message?.stopReason).toBe('stop')
    expect(message).not.toHaveProperty('error')
    expect(Object.keys(message ?? {})).not.toContain('error')
  })

  it('errorMessage 非字符串（对象 / 空串）被忽略且不抛', () => {
    const state = reduceRecords(initialChatState, [
      failedEnd(1, { message: 'boom' }),
      failedEnd(2, '')
    ])

    expect(state.messages).toHaveLength(2)
    for (const message of state.messages) {
      expect(message).not.toHaveProperty('error')
      // stopReason 仍然透传：中止/失败与「有没有原文」是两件事
      expect(message.stopReason).toBe('error')
    }
  })

  it('stopReason 为 aborted 的空 content 正常入列，但无 error', () => {
    const state = reduceRecords(initialChatState, [plainEnd('', 'aborted', 7)])

    expect(state.messages).toHaveLength(1)
    const message = state.messages[0]
    expect(message?.text).toBe('')
    expect(message?.stopReason).toBe('aborted')
    expect(message).not.toHaveProperty('error')
  })

  it('aborted 收尾消息带 errorMessage 时仍原样入列（数据保真，展示由时间线决定）', () => {
    // 真实 pi 用户中止时写的是空 content + stopReason:'aborted' + errorMessage。
    // 归约层不做判断：这条消息必须照常入列并保留原文，否则历史回放就丢数据了。
    const state = reduceRecords(initialChatState, [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          errorMessage: 'This operation was aborted',
          timestamp: 1733234403000
        }
      }
    ])

    expect(state.messages).toHaveLength(1)
    const message = state.messages[0]
    expect(message?.text).toBe('')
    expect(message?.stopReason).toBe('aborted')
    expect(message?.error).toBe('This operation was aborted')
  })
})

describe('失败消息的保真与幂等', () => {
  it('连续 4 条失败（timestamp 各异）数据层不合并', () => {
    const state = reduceRecords(
      initialChatState,
      [1, 2, 3, 4].map((timestamp) => failedEnd(timestamp))
    )

    expect(state.messages).toHaveLength(4)
    expect(new Set(state.messages.map((message) => message.key)).size).toBe(4)
    expect(state.messages.every((message) => message.error === ERROR_TEXT)).toBe(true)
  })

  it('同一失败 record 重复到达幂等（返回同一 state 引用）', () => {
    const record = failedEnd(1733234402000)
    const once = reduceRecord(initialChatState, record)
    const twice = reduceRecord(once, record)

    expect(twice.messages).toHaveLength(1)
    expect(twice).toBe(once)
  })

  it('失败 message_end 清空流式增量（不残留半截文本）', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '半句' }
      },
      failedEnd(1733234402000)
    ])

    expect(state.streaming).toBe('')
    expect(state.streamingTools).toEqual([])
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text).toBe('')
  })

  it('timestamp 缺失时的已知降级：多条失败共用 key 被幂等吞成 1 条', () => {
    // 这是**故意接受**的降级（pi 若不发 timestamp，去重键退化为 `assistant:na:`）。
    // 不得为此改 key 形态：会破坏历史回放的幂等语义（§9.1 U6）。改这里前先读 §4.1 注释。
    const state = reduceRecords(initialChatState, [failedEnd(), failedEnd()])

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.error).toBe(ERROR_TEXT)
  })
})
