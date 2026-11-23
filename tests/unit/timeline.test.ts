import { describe, expect, it } from 'vitest'

import type { ChatMessage, ToolItem } from '../../src/renderer/lib/reducer'
import { groupTimeline, turnToolCount } from '../../src/renderer/lib/timeline'

/**
 * 时间线分组单测（§5.5 features/chat/Timeline / §8.1 M3「按 assistant turn 分组的步骤时间线」）。
 */
function message(role: string, text: string, tools: ToolItem[] = []): ChatMessage {
  return {
    key: `${role}:${text}`,
    role,
    text,
    ...(tools.length === 0 ? {} : { tools })
  }
}

function tool(toolCallId: string, toolName = 'bash'): ToolItem {
  return {
    toolCallId,
    toolName,
    argsText: '',
    argsSummary: '',
    status: 'success',
    output: '',
    isError: false
  }
}

describe('groupTimeline：按 assistant turn 分组', () => {
  it('每个 user 消息开启新的一轮，助手消息归属当前轮', () => {
    const turns = groupTimeline([
      message('user', 'q1'),
      message('assistant', 'a1'),
      message('user', 'q2'),
      message('assistant', 'a2'),
      message('assistant', 'a2b')
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]?.user?.text).toBe('q1')
    expect(turns[0]?.items.map((item) => item.text)).toEqual(['a1'])
    expect(turns[1]?.user?.text).toBe('q2')
    expect(turns[1]?.items.map((item) => item.text)).toEqual(['a2', 'a2b'])
  })

  it('轮次序号从 1 递增，id 使用该轮首条消息的 key', () => {
    const turns = groupTimeline([message('user', 'q1'), message('assistant', 'a1')])
    expect(turns[0]?.index).toBe(1)
    expect(turns[0]?.id).toBe('user:q1')
  })

  it('首条是 assistant 时形成无 user 的一轮（回放/系统提示场景）', () => {
    const turns = groupTimeline([message('assistant', 'hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.user).toBeUndefined()
    expect(turns[0]?.items).toHaveLength(1)
  })

  it('连续 user 消息各自成轮（乐观插入后可能的排列）', () => {
    const turns = groupTimeline([message('user', 'q1'), message('user', 'q2')])
    expect(turns).toHaveLength(2)
    expect(turns[1]?.items).toHaveLength(0)
  })

  it('空消息列表得到空时间线', () => {
    expect(groupTimeline([])).toEqual([])
  })
})

describe('turnToolCount：工具卡片计数', () => {
  it('统计该轮内所有消息的工具卡片', () => {
    const turns = groupTimeline([
      message('user', 'q1'),
      message('assistant', 'a1', [tool('c1'), tool('c2')]),
      message('assistant', 'a2', [tool('c3')])
    ])
    expect(turns[0] === undefined ? -1 : turnToolCount(turns[0])).toBe(3)
  })

  it('没有工具卡片时为 0', () => {
    const turns = groupTimeline([message('user', 'q1'), message('assistant', 'a1')])
    expect(turns[0] === undefined ? -1 : turnToolCount(turns[0])).toBe(0)
  })
})
