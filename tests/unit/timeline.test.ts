import { describe, expect, it } from 'vitest'

import type { ChatMessage, ToolItem } from '../../src/renderer/lib/reducer'
import {
  groupTimeline,
  isErrorGroup,
  isPureError,
  turnToolCount,
  type TimelineItem,
  type TimelineTurn
} from '../../src/renderer/lib/timeline'

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

/**
 * 展示项的可读标签。
 * `TimelineTurn.items` 是联合类型（`ChatMessage | TimelineErrorGroup`），折叠组没有 `text`，
 * 用次数代替 —— 断言里统一走这个辅助函数，既类型安全又能一眼看出折叠结构。
 */
function labelOf(item: TimelineItem): string {
  return isErrorGroup(item) ? `<error×${item.count}>` : item.text
}

/**
 * 一条「纯失败」消息（pi retry 失败时 `message_end` 的形态：
 * `content: []` + `stopReason:'error'` + `errorMessage`）。
 * key 里带 timestamp 是为了让连续失败各有不同 key（真实 pi 每条尝试一条消息）。
 */
function failedMessage(timestamp: number, error = 'Request timed out.'): ChatMessage {
  return {
    key: `assistant:${timestamp}:`,
    role: 'assistant',
    text: '',
    timestamp,
    stopReason: 'error',
    error
  }
}

/** 真实 pi 中止收尾消息带的原文（JSONL 实测） */
const ABORT_TEXT = 'This operation was aborted'

/**
 * 用户中止时的收尾消息：`content: []` + `stopReason:'aborted'` + `errorMessage`。
 * 中止是用户主动行为，不是模型失败 —— 它既不该成空气泡，也不该变成红色错误组。
 */
function abortedMessage(timestamp: number, error = ABORT_TEXT): ChatMessage {
  return {
    key: `assistant:${timestamp}:`,
    role: 'assistant',
    text: '',
    timestamp,
    stopReason: 'aborted',
    error
  }
}

function allItems(turns: TimelineTurn[]): TimelineItem[] {
  return turns.flatMap((turn) => turn.items)
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
    expect(turns[0]?.items.map(labelOf)).toEqual(['a1'])
    expect(turns[1]?.user?.text).toBe('q2')
    expect(turns[1]?.items.map(labelOf)).toEqual(['a2', 'a2b'])
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

/**
 * 「连续失败」展示折叠（§4.3 / §5.2）。
 *
 * 折叠只发生在**展示层**：数据里每条失败尝试仍是一条 `ChatMessage`（保真、与 JSONL 一一对应），
 * 这里只验 `groupTimeline` 的合并语义与边界（空消息丢弃、user 永不丢、工具计数）。
 */
describe('error-group：连续失败的展示折叠', () => {
  it('4 条连续纯失败折叠成 1 项：次数 4、原文取最后一条、keys 一条不少', () => {
    const turns = groupTimeline([
      message('user', 'q1'),
      failedMessage(1, 'e1'),
      failedMessage(2, 'e2'),
      failedMessage(3, 'e3'),
      failedMessage(4, 'e4')
    ])

    const items = turns[0]?.items ?? []
    expect(items).toHaveLength(1)

    const group = items[0]
    if (group === undefined || !isErrorGroup(group)) throw new Error('应折叠成一个 error-group')
    expect(group.count).toBe(4)
    // 最新诊断最有价值：组内最后一条的 errorMessage
    expect(group.error).toBe('e4')
    // 保真证据：一条都没丢，只是展示合并
    expect(group.keys).toEqual(['assistant:1:', 'assistant:2:', 'assistant:3:', 'assistant:4:'])
    expect(group.key.startsWith('errgroup:')).toBe(true)
    // React key 取组内**首条**消息：后续重试到达时不重挂 DOM
    expect(group.key).toBe('errgroup:assistant:1:')
  })

  it('折叠组 key 在新增重试时不变（React 不重挂、展开状态不丢）', () => {
    const one = groupTimeline([message('user', 'q1'), failedMessage(1)])[0]?.items[0]
    const two = groupTimeline([message('user', 'q1'), failedMessage(1), failedMessage(2)])[0]
      ?.items[0]
    if (one === undefined || !isErrorGroup(one) || two === undefined || !isErrorGroup(two)) {
      throw new Error('应为 error-group')
    }
    expect(one.count).toBe(1)
    expect(two.count).toBe(2)
    expect(two.key).toBe(one.key)
  })

  it('失败被文本消息打断则另起一组', () => {
    const items = allItems(
      groupTimeline([
        message('user', 'q1'),
        failedMessage(1),
        message('assistant', '半句'),
        failedMessage(2)
      ])
    )
    expect(items.map(labelOf)).toEqual(['<error×1>', '半句', '<error×1>'])
  })

  it('带文本 / 带工具的失败消息不折叠（保留普通气泡，气泡内仍显示错误块）', () => {
    const withText: ChatMessage = {
      key: 'assistant:2:半句',
      role: 'assistant',
      text: '半句',
      timestamp: 2,
      stopReason: 'error',
      error: 'e2'
    }
    const withTool: ChatMessage = {
      key: 'assistant:3:',
      role: 'assistant',
      text: '',
      timestamp: 3,
      stopReason: 'error',
      error: 'e3',
      tools: [tool('c1')]
    }
    const items = allItems(
      groupTimeline([message('user', 'q1'), failedMessage(1), withText, withTool])
    )
    expect(items).toHaveLength(3)
    // 首项是 failedMessage(1) 的折叠组；withText / withTool 必须保持为普通 ChatMessage
    const first = items[0]
    expect(first !== undefined && isErrorGroup(first)).toBe(true)
    expect(items.slice(1).every((item) => !isErrorGroup(item))).toBe(true)
    expect(items.map(labelOf)).toEqual(['<error×1>', '半句', ''])
  })

  it('空且无错误的 assistant 消息被丢弃（不再渲染空气泡）', () => {
    const emptyAborted: ChatMessage = {
      key: 'assistant:9:',
      role: 'assistant',
      text: '',
      timestamp: 9,
      stopReason: 'aborted'
    }
    const turns = groupTimeline([message('user', 'q1'), emptyAborted, message('assistant', 'a1')])
    expect(turns).toHaveLength(1)
    expect(allItems(turns).map(labelOf)).toEqual(['a1'])
    // 单独一条空助手消息连一轮都不成
    expect(groupTimeline([emptyAborted])).toHaveLength(0)
  })

  it('aborted 收尾消息带 errorMessage 也被丢弃（既不空气泡，也不红色错误组）', () => {
    const turns = groupTimeline([
      message('user', 'q1'),
      abortedMessage(9),
      message('assistant', 'a1')
    ])
    expect(turns).toHaveLength(1)
    expect(allItems(turns).map(labelOf)).toEqual(['a1'])
    // 单独一条 aborted 收尾连一轮都不成
    expect(groupTimeline([abortedMessage(9)])).toHaveLength(0)
  })

  it('isPureError 对 aborted 消息返回 false（中止不是失败，双保险）', () => {
    expect(isPureError(abortedMessage(9))).toBe(false)
    // 对照：同形态但 stopReason 为 error 的消息仍是纯失败
    expect(isPureError(failedMessage(9))).toBe(true)
  })

  it('失败→aborted→失败（同轮极端序列）：aborted 被丢弃后两条失败折叠为一组', () => {
    // 该序列现实中不存在（aborted 后 run 结束，下一条必是新 user 消息开新轮），
    // 这里锁定的是展示层语义：aborted 收尾不进时间线，展示层相邻的纯失败按现有规则合并；
    // 数据层仍是 3 条消息（保真），keys 能还原真实顺序。
    const items = allItems(
      groupTimeline([
        message('user', 'q1'),
        failedMessage(1, 'e1'),
        abortedMessage(2),
        failedMessage(3, 'e3')
      ])
    )
    expect(items).toHaveLength(1)

    const group = items[0]
    if (group === undefined || !isErrorGroup(group)) throw new Error('应折叠为一组')
    expect(group.count).toBe(2)
    expect(group.error).toBe('e3')
    expect(group.keys).toEqual(['assistant:1:', 'assistant:3:'])
  })

  it('带文本的 aborted 消息不丢弃（正常展示 + 已中止注脚）', () => {
    const abortedWithText: ChatMessage = {
      key: 'assistant:4:半句',
      role: 'assistant',
      text: '半句',
      timestamp: 4,
      stopReason: 'aborted',
      error: ABORT_TEXT
    }
    const items = allItems(groupTimeline([message('user', 'q1'), abortedWithText]))
    expect(items.map(labelOf)).toEqual(['半句'])
    expect(items[0] !== undefined && !isErrorGroup(items[0])).toBe(true)
  })

  it('user 消息永不被丢弃（空文本也算一轮）', () => {
    const turns = groupTimeline([{ key: 'user:empty', role: 'user', text: '' }])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.user?.key).toBe('user:empty')
  })

  it('turnToolCount 对 error-group 计 0', () => {
    const turns = groupTimeline([
      message('user', 'q1'),
      failedMessage(1),
      message('assistant', 'a1', [tool('c1')])
    ])
    expect(allItems(turns).map(labelOf)).toEqual(['<error×1>', 'a1'])
    expect(turns[0] === undefined ? -1 : turnToolCount(turns[0])).toBe(1)
  })
})
