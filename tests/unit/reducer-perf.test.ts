import { describe, expect, it } from 'vitest'

import {
  initialChatState,
  reduceRecord,
  reduceRecords,
  type ChatState
} from '../../src/renderer/lib/reducer'
import { useSessionStore } from '../../src/renderer/stores/sessionStore'

/**
 * 历史回放归约性能（M4 前置修复 + M4 复核修复 B2）。
 *
 * 背景：M3 的 reducer 每处理一条 `message_end` 都要
 * ① `messages.some(...)` 扫描去重键、② `[...messages, next]` 全量拷贝，
 * 30k 条记录实测约 4.9s（O(n²)），大会话选中时会明显卡白。
 *
 * M4 改为「可变游标 + 懒建索引」后，索引与数组拷贝都只在必要时发生（均摊 O(n)）。
 *
 * **B2 教训（2026-11-20 复核）**：批量路径 `reduceRecords` 是 O(n)，但 renderer 真正走的是
 * `sessionStore.replay()`，它当时仍用逐条 `reduceRecord`（20k 条 8,296ms）。只测批量路径
 * 会给出「已修复」的假信心，所以这里**必须对 `replay()` 本身**做性能断言。
 * 阈值统一取 300ms（CI 机器上留足余量）。
 */

type Record_ = { type: string; [key: string]: unknown }

function turnRecords(index: number): Record_[] {
  const timestamp = 1_700_000_000_000 + index * 2000
  return [
    {
      type: 'message_end',
      message: { role: 'user', content: `第 ${index} 个问题`, timestamp }
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${index} 个回答` }],
        timestamp: timestamp + 1000
      }
    }
  ]
}

function buildRecords(turns: number): Record_[] {
  const records: Record_[] = []
  for (let index = 0; index < turns; index += 1) records.push(...turnRecords(index))
  return records
}

function timeReduce(records: Record_[]): { state: ChatState; ms: number } {
  const startedAt = performance.now()
  const state = reduceRecords(initialChatState, records)
  const ms = performance.now() - startedAt
  return { state, ms }
}

/** 走 renderer 的真实回放入口（store 方法），名字与组件调用一致 */
function timeReplay(records: Record_[]): { state: ChatState; ms: number } {
  const taskId = 'perf-task'
  const startedAt = performance.now()
  const state = useSessionStore.getState().replay(taskId, records)
  const ms = performance.now() - startedAt
  return { state, ms }
}

describe('回放归约性能（20k 条 < 300ms）', () => {
  it('批量路径 reduceRecords：20k 条实测耗时', () => {
    const records = buildRecords(10_000) // 10k 轮 = 20k 条消息
    expect(records).toHaveLength(20_000)

    const { state, ms } = timeReduce(records)
    // 实测数字直接打印，便于报告与回归对比
    console.log(`[perf] reduceRecords 20k 条：${ms.toFixed(1)}ms，产出 ${state.messages.length} 条消息`)

    expect(state.messages).toHaveLength(20_000)
    expect(ms).toBeLessThan(300)
  })

  it('真实回放路径 sessionStore.replay：20k 条实测耗时（B2 回归）', () => {
    const records = buildRecords(10_000)
    expect(records).toHaveLength(20_000)

    const { state, ms } = timeReplay(records)
    console.log(`[perf] sessionStore.replay 20k 条：${ms.toFixed(1)}ms，产出 ${state.messages.length} 条消息`)

    expect(state.messages).toHaveLength(20_000)
    // 逐条 reduceRecord 的老实现是 8,296ms 级；这里必须落在百毫秒内
    expect(ms).toBeLessThan(300)
  })

  it('重复回放同一批记录仍然幂等（去重索引在批量路径上有效）', () => {
    const records = buildRecords(2_000)
    const once = reduceRecords(initialChatState, records)
    const twice = reduceRecords(once, records)
    // 重复记录全部命中 key 索引，状态引用保持不变（U6 的批量版）
    expect(twice).toBe(once)
    expect(once.messages).toHaveLength(4_000)
  })
})

/**
 * 批量归约必须与逐条归约**结果等价**：replay 换成批量路径后行为不能变。
 *
 * 覆盖复核点名的高风险场景：
 * - `message_end` 权威覆盖流式增量；
 * - 重复 key（重复到达幂等）；
 * - 乱序记录（工具卡片先于 / 晚于 message_end 到达）；
 * - 乐观用户消息被权威消息就地替换。
 */
describe('批量归约与逐条归约等价', () => {
  const oneByOne = (records: Record_[]): ChatState =>
    records.reduce((state, record) => reduceRecord(state, record), initialChatState)

  const cases: Array<{ name: string; records: Record_[] }> = [
    {
      name: '普通一问一答（含流式增量与权威覆盖）',
      records: [
        { type: 'agent_start' },
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_end', content: '你好（权威）' }
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '你好（权威）' }],
            timestamp: 1
          }
        },
        { type: 'agent_end' },
        { type: 'agent_settled', aborted: false }
      ]
    },
    {
      name: '重复 key（同一条 message_end 到达两次）',
      records: [
        {
          type: 'message_end',
          message: { role: 'user', content: '重复', timestamp: 10 }
        },
        {
          type: 'message_end',
          message: { role: 'user', content: '重复', timestamp: 10 }
        },
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '答' }], timestamp: 11 }
        }
      ]
    },
    {
      name: '乱序工具卡片（start/end 早于 message_end，结果消息晚到）',
      records: [
        { type: 'agent_start' },
        { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
        {
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'a.txt' }] },
          isError: false,
          durationMs: 5
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '看完了' },
              { type: 'toolCall', id: 'call_2', name: 'read', arguments: { path: 'a.txt' } }
            ],
            timestamp: 20
          }
        },
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'read',
            content: [{ type: 'text', text: 'file body' }],
            isError: false,
            timestamp: 21
          }
        },
        { type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'read' },
        { type: 'agent_end' },
        { type: 'agent_settled', aborted: false }
      ]
    },
    {
      name: '乐观用户消息被权威 message_end 就地替换',
      records: [
        { type: 'message_end', message: { role: 'user', content: '待替换', timestamp: 30 } },
        { type: 'agent_start' },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: '流式中' }
        }
      ]
    },
    {
      name: '2k 轮大序列（4000 条，批量路径的规模回归）',
      records: buildRecords(2_000)
    }
  ]

  for (const testCase of cases) {
    it(`${testCase.name}：批量 === 逐条 === replay`, () => {
      const batched = reduceRecords(initialChatState, testCase.records)
      const sequential = oneByOne(testCase.records)
      const replayed = useSessionStore.getState().replay('equiv-task', testCase.records)

      expect(sequential).toEqual(batched)
      expect(replayed).toEqual(batched)
    })
  }

  it('同规模下逐条路径的 O(n²) 与批量路径的差距（实测对比）', () => {
    const records = buildRecords(2_500) // 5k 条
    const batchStart = performance.now()
    const batched = reduceRecords(initialChatState, records)
    const batchMs = performance.now() - batchStart

    const seqStart = performance.now()
    const sequential = oneByOne(records)
    const seqMs = performance.now() - seqStart

    console.log(
      `[perf] 5k 条对比：reduceRecords ${batchMs.toFixed(1)}ms vs 逐条 reduceRecord ${seqMs.toFixed(1)}ms`
    )
    // 等价性：换路径不能改结果（这就是 B2 修复可以被信任的依据）
    expect(sequential).toEqual(batched)
    // 逐条路径在 5k 条上已是数百毫秒级（20k 条 → 8s 级）；批量路径应快一个数量级
    expect(batchMs).toBeLessThan(seqMs)
  }, 30_000)

  it('乐观用户消息在 replay 与实时 applyRecord 上都被就地替换（结果一致）', () => {
    const records: Record_[] = [
      { type: 'message_end', message: { role: 'user', content: '待替换', timestamp: 30 } }
    ]
    const replayTask = 'optimistic-replay'
    const liveTask = 'optimistic-live'
    const store = useSessionStore.getState()
    store.ensureChat(replayTask)
    store.appendUserMessage(replayTask, '待替换')
    store.ensureChat(liveTask)
    store.appendUserMessage(liveTask, '待替换')

    // 历史回放走 replay（批量），实时事件走 applyRecord（单条）：结果必须一致
    const viaReplay = useSessionStore.getState().replay(replayTask, records)
    const live = useSessionStore.getState().applyRecord(liveTask, records[0] as Record_)

    expect(viaReplay.messages).toHaveLength(1)
    expect(viaReplay).toEqual(live)
    expect(viaReplay.messages[0]?.key).not.toContain('user:local:')
  })
})
