import { describe, expect, it } from 'vitest'

import {
  initialChatState,
  reduceRecord,
  reduceRecords,
  type ChatState
} from '../../src/renderer/lib/reducer'

/** §9.1 U5/U6/U7/U12：事件归约纯函数（§5.5、§7 约束 7） */

function delta(text: string, contentIndex = 0): { type: string; [key: string]: unknown } {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text }
  }
}

function messageEnd(text: string, role = 'assistant', timestamp = 1733234402000): {
  type: string
  [key: string]: unknown
} {
  return { type: 'message_end', message: { role, content: [{ type: 'text', text }], timestamp } }
}

describe('U5：delta 序列 + message_end', () => {
  it('最终文本等于权威文本（增量被整体替换）', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant' } },
      delta('Hello'),
      delta(', '),
      delta('wor'),
      delta('ld'),
      messageEnd('Hello, world'),
      { type: 'agent_end' },
      { type: 'agent_settled', aborted: false }
    ])

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text).toBe('Hello, world')
    expect(state.streaming).toBe('')
    expect(state.phase).toBe('idle')
  })

  it('流式过程中 streaming 逐段拼接', () => {
    let state: ChatState = reduceRecord(initialChatState, { type: 'agent_start' })
    state = reduceRecord(state, delta('He'))
    state = reduceRecord(state, delta('llo'))
    expect(state.streaming).toBe('Hello')
    expect(state.phase).toBe('streaming')
  })

  it('text_end 用权威文本块整体替换增量', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      delta('He'),
      delta('llo'),
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello!' }
      }
    ])
    expect(state.streaming).toBe('Hello!')
  })

  it('string 形式的 content 与 content 数组都被正确提取', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 1 } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }], timestamp: 2 } }
    ])
    expect(state.messages.map((message) => message.text)).toEqual(['hi', 'yo'])
  })
})

describe('U6：重复 message_end 幂等', () => {
  const authoritative = messageEnd('done')

  it('同一条 message_end 重复到达不产生第二条消息', () => {
    const once = reduceRecord(initialChatState, authoritative)
    const twice = reduceRecord(once, authoritative)

    expect(twice.messages).toHaveLength(1)
    expect(twice).toBe(once) // 状态引用不变，避免无谓重渲染
  })

  it('timestamp 不同则视为新消息', () => {
    const state = reduceRecords(initialChatState, [
      messageEnd('a', 'assistant', 1),
      messageEnd('a', 'assistant', 2)
    ])
    expect(state.messages).toHaveLength(2)
  })
})

describe('U7：agent_end 后仍有排队事件 → 保持 settling', () => {
  it('agent_end 不回到 idle，只有 agent_settled 才回 idle', () => {
    let state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      delta('step1'),
      { type: 'agent_end', willRetry: true }
    ])
    expect(state.phase).toBe('settling')

    // agent_end 之后继续有事件（retry / 排队消息）
    state = reduceRecord(state, delta('step2'))
    expect(state.phase).not.toBe('idle')

    state = reduceRecord(state, { type: 'agent_end' })
    expect(state.phase).toBe('settling')

    state = reduceRecord(state, { type: 'agent_settled', aborted: false })
    expect(state.phase).toBe('idle')
    expect(state.streaming).toBe('')
  })
})

describe('U12：增量拼接 + 整体替换二次聚合幂等', () => {
  it('两次完整的 delta→message_end 循环结果一致', () => {
    const records = [
      { type: 'agent_start' },
      delta('A'),
      delta('B'),
      messageEnd('AB'),
      { type: 'agent_settled', aborted: false }
    ]

    const once = reduceRecords(initialChatState, records)
    const twice = reduceRecords(once, records)

    // 同一轮重复回放：不会追加第二条消息（幂等）
    expect(twice.messages).toEqual(once.messages)
    expect(twice.messages[0]?.text).toBe('AB')
  })
})

describe('未知记录与畸形载荷', () => {
  it('未知 type 原样返回同一状态引用', () => {
    const state = reduceRecord(initialChatState, { type: 'tool_execution_start' })
    expect(state).toBe(initialChatState)
  })

  it('message_end 载荷缺失 message 时不崩溃', () => {
    const state = reduceRecord(initialChatState, { type: 'message_end' })
    expect(state).toBe(initialChatState)
  })

  it('message_update 缺 contentIndex 也能拼接', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }
    ])
    expect(state.streaming).toBe('x')
  })
})
