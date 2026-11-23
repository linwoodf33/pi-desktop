import { describe, expect, it } from 'vitest'

import {
  EMPTY_DISPLAY,
  TOOL_PREVIEW_LINES,
  TOOL_STATUS_CLASS,
  TOOL_STATUS_LABEL,
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  phaseLabel,
  shortenPath
} from '../../src/renderer/lib/format'
import type { RunPhase, ToolStatus } from '../../src/renderer/lib/reducer'
import { canSend, phaseFromStatus } from '../../src/renderer/stores/runStore'

/**
 * 展示格式化 + 运行态映射单测（A3：缺失字段显示「—」；U-Tool：状态映射）。
 */

describe('缺失字段显示「—」（A3）', () => {
  it('token/成本/耗时/时间缺失时统一显示占位符', () => {
    expect(formatTokens(undefined)).toBe(EMPTY_DISPLAY)
    expect(formatCost(undefined)).toBe(EMPTY_DISPLAY)
    expect(formatDuration(undefined)).toBe(EMPTY_DISPLAY)
    expect(formatTimestamp(undefined)).toBe(EMPTY_DISPLAY)
  })
})

describe('数值格式化', () => {
  it('token 数量级', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(1_234_567)).toBe('1.23M')
  })

  it('成本：0 显示 $0，小额保留 4 位小数', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.000123)).toBe('$0.0001')
    expect(formatCost(1.239)).toBe('$1.24')
  })

  it('耗时：毫秒与秒', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(350)).toBe('350ms')
    expect(formatDuration(1234)).toBe('1.2s')
  })

  it('时间戳：ISO → MM-DD HH:mm，非法串原样返回', () => {
    const formatted = formatTimestamp('2026-01-02T03:04:05.000Z')
    expect(formatted).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatTimestamp('not-a-date')).toBe('not-a-date')
  })

  it('长路径保留尾部', () => {
    const long = 'C:/Users/someone/very/deep/project/directory/src/index.ts'
    const short = shortenPath(long, 24)
    expect(short.length).toBeLessThanOrEqual(25)
    expect(short.startsWith('…')).toBe(true)
    expect(short.endsWith('index.ts')).toBe(true)
    expect(shortenPath('C:/a', 24)).toBe('C:/a')
  })
})

describe('工具状态映射（U-Tool）', () => {
  it('四种状态都有中文标签与样式类', () => {
    const statuses: ToolStatus[] = ['pending', 'running', 'success', 'error']
    for (const status of statuses) {
      expect(TOOL_STATUS_LABEL[status].length).toBeGreaterThan(0)
      expect(TOOL_STATUS_CLASS[status]).toMatch(/^tool-card--/)
    }
    expect(TOOL_STATUS_LABEL.running).toBe('执行中')
    expect(TOOL_STATUS_LABEL.success).toBe('已完成')
    expect(TOOL_STATUS_LABEL.error).toBe('失败')
  })

  it('输出预览行数是有限正整数', () => {
    expect(Number.isInteger(TOOL_PREVIEW_LINES)).toBe(true)
    expect(TOOL_PREVIEW_LINES).toBeGreaterThan(0)
  })
})

describe('运行态标签与 status 映射', () => {
  it('phase 都有中文标签', () => {
    const phases: RunPhase[] = ['idle', 'streaming', 'tool_running', 'settling']
    for (const phase of phases) expect(phaseLabel(phase).length).toBeGreaterThan(0)
  })

  it('evt:status 不把 tool_running 降级为 streaming', () => {
    expect(phaseFromStatus('tool_running', 'running')).toBe('tool_running')
    expect(phaseFromStatus('tool_running', 'settled')).toBe('idle')
    expect(phaseFromStatus('idle', 'running')).toBe('streaming')
    expect(phaseFromStatus('streaming', 'settling' as never)).toBe('streaming')
  })

  it('只有 idle 且没在 abort 时才允许发送', () => {
    expect(canSend('idle', { aborting: false })).toBe(true)
    for (const phase of ['streaming', 'tool_running', 'settling'] as RunPhase[]) {
      expect(canSend(phase, { aborting: false })).toBe(false)
    }
    expect(canSend('idle', { aborting: true })).toBe(false)
  })
})
