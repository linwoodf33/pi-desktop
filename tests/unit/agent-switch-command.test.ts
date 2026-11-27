import { describe, expect, it } from 'vitest'

import {
  AGENT_CLEAR_TOKEN,
  agentSwitchCommand,
  isAgentNameSwitchable
} from '../../src/shared/contracts/agents'

/**
 * A40：`/agent` 命令文本与「能否运行中切换」的判定。
 *
 * 两条都直接来自已核实的事实（F4）：`pi-open-agents` 把 `args.trim()` **整体**当名字，
 * 所以含空白的名字会被解析错；而 `none` / `clear` 是「清除」保留字，不是专家名。
 */
describe('agentSwitchCommand', () => {
  it('null → /agent none（清除，回落到默认专家）', () => {
    expect(agentSwitchCommand(null)).toBe('/agent none')
    expect(AGENT_CLEAR_TOKEN).toBe('none')
  })

  it('具体名字 → /agent <name>', () => {
    expect(agentSwitchCommand('scout')).toBe('/agent scout')
    expect(agentSwitchCommand('a.b_c-1')).toBe('/agent a.b_c-1')
  })
})

describe('isAgentNameSwitchable', () => {
  it('普通名字（含 . _ -）可切换', () => {
    expect(isAgentNameSwitchable('scout')).toBe(true)
    expect(isAgentNameSwitchable('a.b_c-1')).toBe(true)
    expect(isAgentNameSwitchable('Scout')).toBe(true)
  })

  it('含空白/tab 的名字不可切换（会被解析成别的名字）', () => {
    expect(isAgentNameSwitchable('a b')).toBe(false)
    expect(isAgentNameSwitchable('a\tb')).toBe(false)
    expect(isAgentNameSwitchable('a\nb')).toBe(false)
    expect(isAgentNameSwitchable(' a')).toBe(false)
  })

  it('控制字符不可切换', () => {
    expect(isAgentNameSwitchable('a\u0000b')).toBe(false)
    expect(isAgentNameSwitchable('a\u0001b')).toBe(false)
    expect(isAgentNameSwitchable('a\u007fb')).toBe(false)
  })

  it('none / clear 是清除保留字，不是可切换的专家名（大小写不敏感）', () => {
    expect(isAgentNameSwitchable('none')).toBe(false)
    expect(isAgentNameSwitchable('clear')).toBe(false)
    expect(isAgentNameSwitchable('NONE')).toBe(false)
    expect(isAgentNameSwitchable('Clear')).toBe(false)
  })

  it('长度边界：空串拒绝、64 通过、65 拒绝', () => {
    expect(isAgentNameSwitchable('')).toBe(false)
    expect(isAgentNameSwitchable('a'.repeat(64))).toBe(true)
    expect(isAgentNameSwitchable('a'.repeat(65))).toBe(false)
  })
})
