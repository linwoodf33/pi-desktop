import { describe, expect, it } from 'vitest'

import {
  initialChatState,
  collectToolCalls,
  extractToolOutput,
  formatArgs,
  reduceRecord,
  reduceRecords,
  summarizeToolArgs,
  MAX_TOOL_OUTPUT_CHARS,
  type ChatState
} from '../../src/renderer/lib/reducer'

/**
 * §8.1 M3「工具卡片」归约单测（对应 §9.1 U5–U7 的扩展）：
 * 工具卡片的名称/参数/状态/耗时/输出都必须来自事件本身，且按 `toolCallId` 关联。
 */

const start = (id: string, name: string, args: unknown = { command: 'ls -la' }): {
  type: string
  [key: string]: unknown
} => ({ type: 'tool_execution_start', toolCallId: id, toolName: name, args })

const end = (
  id: string,
  name: string,
  text: string,
  extra: { isError?: boolean; durationMs?: number; details?: unknown } = {}
): { type: string; [key: string]: unknown } => ({
  type: 'tool_execution_end',
  toolCallId: id,
  toolName: name,
  result: {
    content: [{ type: 'text', text }],
    ...(extra.details === undefined ? {} : { details: extra.details })
  },
  isError: extra.isError ?? false,
  ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs })
})

const assistantWithToolCall = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  timestamp = 1
): { type: string; [key: string]: unknown } => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '我来执行一下' },
      { type: 'toolCall', id: toolCallId, name: toolName, arguments: args }
    ],
    timestamp
  }
})

/** 所有可见的工具卡片：消息里已归属的 + 仍在流式期的 */
function toolsOf(state: ChatState) {
  return [
    ...state.messages.flatMap((message) => message.tools ?? []),
    ...state.streamingTools
  ]
}

describe('工具卡片生命周期（tool_execution_start/update/end）', () => {
  it('start → running，end → success 并带耗时与输出', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      start('call_1', 'bash'),
      end('call_1', 'bash', 'total 0\nfile.txt', { durationMs: 42 })
    ])

    const tool = toolsOf(state)[0]
    expect(tool?.toolCallId).toBe('call_1')
    expect(tool?.toolName).toBe('bash')
    expect(tool?.status).toBe('success')
    expect(tool?.durationMs).toBe(42)
    expect(tool?.output).toContain('file.txt')
    expect(tool?.isError).toBe(false)
  })

  it('工具运行中 phase=tool_running，结束后回到 streaming', () => {
    let state = reduceRecord(initialChatState, { type: 'agent_start' })
    state = reduceRecord(state, start('call_1', 'bash'))
    expect(state.phase).toBe('tool_running')

    state = reduceRecord(state, end('call_1', 'bash', 'ok'))
    expect(state.phase).toBe('streaming')
  })

  it('isError=true → status=error（A2：状态与事件一一对应）', () => {
    const state = reduceRecords(initialChatState, [
      start('call_9', 'bash'),
      end('call_9', 'bash', 'command failed', { isError: true, durationMs: 5 })
    ])
    expect(toolsOf(state)[0]?.status).toBe('error')
    expect(toolsOf(state)[0]?.isError).toBe(true)
  })

  it('partialResult 写入中间输出（执行中可看到进度）', () => {
    const state = reduceRecords(initialChatState, [
      start('call_2', 'bash'),
      {
        type: 'tool_execution_update',
        toolCallId: 'call_2',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'partial output' }] }
      }
    ])
    const tool = toolsOf(state)[0]
    expect(tool?.status).toBe('running')
    expect(tool?.output).toBe('partial output')
  })

  it('大输出的 fullOutputPath 来自 result.details（§7 约束 14）', () => {
    const state = reduceRecords(initialChatState, [
      start('call_3', 'bash'),
      end('call_3', 'bash', 'truncated...', {
        details: { truncation: { truncated: true }, fullOutputPath: 'C:/tmp/pi-bash.log' }
      })
    ])
    expect(toolsOf(state)[0]?.fullOutputPath).toBe('C:/tmp/pi-bash.log')
  })
})

describe('工具卡片与助手消息的归属', () => {
  it('message_end 声明的 toolCall 先落成 pending 卡片，随后被 start/end 更新', () => {
    let state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      assistantWithToolCall('call_4', 'bash', { command: 'ls' }, 100)
    ])

    const message = state.messages[0]
    expect(message?.tools?.[0]?.status).toBe('pending')
    expect(message?.text).toBe('我来执行一下')

    state = reduceRecord(state, start('call_4', 'bash', { command: 'ls' }))
    state = reduceRecord(state, end('call_4', 'bash', 'a.txt', { durationMs: 7 }))

    // 仍是同一条消息上的同一张卡片（不会因为 start 又新建一张）
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.tools).toHaveLength(1)
    expect(state.messages[0]?.tools?.[0]?.status).toBe('success')
    expect(state.streamingTools).toHaveLength(0)
  })

  it('工具先于 message_end 到达时挂在流式卡片上，message_end 后合并进消息', () => {
    let state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      start('call_5', 'read', { path: 'a.txt' })
    ])
    expect(state.streamingTools).toHaveLength(1)

    state = reduceRecord(state, assistantWithToolCall('call_5', 'read', { path: 'a.txt' }, 200))
    const message = state.messages[0]
    expect(message?.tools).toHaveLength(1)
    // 已经 running，不应被 message_end 的声明降级回 pending
    expect(message?.tools?.[0]?.status).toBe('running')
  })

  it('历史回放：toolResult 消息把卡片置为 success/error 并写入输出', () => {
    const state = reduceRecords(initialChatState, [
      assistantWithToolCall('call_6', 'bash', { command: 'ls' }, 300),
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call_6',
          toolName: 'bash',
          content: [{ type: 'text', text: 'a.txt\nb.txt' }],
          isError: false,
          timestamp: 301
        }
      }
    ])

    const tool = toolsOf(state)[0]
    expect(tool?.status).toBe('success')
    expect(tool?.output).toBe('a.txt\nb.txt')
    // toolResult 不是对话消息，不进入 messages
    expect(state.messages).toHaveLength(1)
  })

  it('未知 toolCallId 的 toolResult 不产生副作用', () => {
    const before = reduceRecord(initialChatState, assistantWithToolCall('call_7', 'bash', {}, 1))
    const after = reduceRecord(before, {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'unknown', content: [], isError: true }
    })
    expect(after).toBe(before)
  })
})

describe('运行态（idle / streaming / tool_running / settling）', () => {
  it('settled 时把无归属的工具卡片落成一条助手消息（切回历史不丢卡片）', () => {
    const state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      start('call_orphan', 'bash'),
      end('call_orphan', 'bash', 'ok'),
      { type: 'agent_settled', aborted: false }
    ])
    expect(state.streamingTools).toHaveLength(0)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.tools?.[0]?.toolCallId).toBe('call_orphan')
    expect(state.messages[0]?.tools?.[0]?.status).toBe('success')
  })

  it('agent_end 后进入 settling，工具事件不把它降级为 streaming', () => {
    let state = reduceRecords(initialChatState, [
      { type: 'agent_start' },
      { type: 'agent_end', willRetry: true }
    ])
    expect(state.phase).toBe('settling')

    state = reduceRecord(state, start('call_8', 'bash'))
    expect(state.phase).toBe('settling')

    state = reduceRecord(state, { type: 'agent_settled', aborted: false })
    expect(state.phase).toBe('idle')
  })
})

describe('纯函数辅助（参数摘要 / 输出提取 / 截断）', () => {
  it('summarizeToolArgs 优先取语义字段，否则退化为 JSON 片段', () => {
    expect(summarizeToolArgs({ command: 'ls -la' })).toBe('command: ls -la')
    expect(summarizeToolArgs({ path: 'src/a.ts' })).toBe('path: src/a.ts')
    expect(summarizeToolArgs({ foo: 'bar' })).toContain('"foo":"bar"')
    expect(summarizeToolArgs(undefined)).toBe('')
  })

  it('formatArgs：字符串原样，对象格式化', () => {
    expect(formatArgs('ls -la')).toBe('ls -la')
    expect(formatArgs({ a: 1 })).toContain('"a": 1')
    expect(formatArgs(undefined)).toBe('')
  })

  it('collectToolCalls 只取 toolCall 块，忽略 malformed', () => {
    const tools = collectToolCalls([
      { type: 'text', text: 'hi' },
      { type: 'toolCall', id: 'x', name: 'bash', arguments: { command: 'ls' } },
      { type: 'toolCall', name: 'no-id' }
    ])
    expect(tools).toHaveLength(1)
    expect(tools[0]?.argsSummary).toBe('command: ls')
  })

  it('extractToolOutput 支持 string / content 数组 / details', () => {
    expect(extractToolOutput('plain').output).toBe('plain')
    expect(
      extractToolOutput({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
          { type: 'text', text: 'b' }
        ]
      }).output
    ).toBe('ab')
    expect(extractToolOutput({ details: { fullOutputPath: '/tmp/x' } }).fullOutputPath).toBe('/tmp/x')
  })

  it('超长输出被截断并显式标记（不静默）', () => {
    const huge = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 10)
    const state = reduceRecords(initialChatState, [
      start('call_big', 'bash'),
      end('call_big', 'bash', huge)
    ])
    const output = toolsOf(state)[0]?.output ?? ''
    // 超出部分被剪掉，只保留 MAX_TOOL_OUTPUT_CHARS + 显式截断标记
    expect(output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 120)
    expect(output.startsWith('x'.repeat(100))).toBe(true)
    expect(output).toContain('输出过长：已截断')
  })
})

describe('畸形记录不影响状态', () => {
  it('缺 toolCallId/toolName 的工具事件被忽略（引用不变）', () => {
    for (const record of [
      { type: 'tool_execution_start' },
      { type: 'tool_execution_start', toolCallId: 'x' },
      { type: 'tool_execution_update', toolName: 'bash' },
      { type: 'tool_execution_end', toolCallId: 'x' }
    ]) {
      expect(reduceRecord(initialChatState, record)).toBe(initialChatState)
    }
  })
})

describe('乐观插入的用户消息被 pi 回显时就地替换（不重复成两轮）', () => {
  it('同文本的最后一条乐观用户消息被权威消息替换', () => {
    const state = reduceRecords(
      {
        ...initialChatState,
        messages: [
          { key: 'user:local:1700000000000:1', role: 'user', text: '列出目录', timestamp: 1 }
        ]
      },
      [
        {
          type: 'message_end',
          message: { role: 'user', content: '列出目录', timestamp: 1700000001000 }
        }
      ]
    )

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.key).toBe('user:1700000001000:列出目录')
  })

  it('历史回放里相同文本的历史消息不会被误替换（只匹配最后一条乐观项）', () => {
    const state = reduceRecords(
      {
        ...initialChatState,
        messages: [
          { key: 'user:1:列出目录', role: 'user', text: '列出目录', timestamp: 1 },
          { key: 'assistant:2:好的', role: 'assistant', text: '好的', timestamp: 2 }
        ]
      },
      [
        {
          type: 'message_end',
          message: { role: 'user', content: '列出目录', timestamp: 3 }
        }
      ]
    )

    expect(state.messages).toHaveLength(3)
  })
})
