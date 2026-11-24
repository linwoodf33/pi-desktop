import { describe, expect, it } from 'vitest'

import {
  PASTE_MIN_CHARS,
  PASTE_MIN_LINES,
  expandPastes,
  planPaste,
  pruneBlocks
} from '../../src/renderer/lib/paste'

/**
 * A28：多行粘贴折叠。
 *
 * 目标：粘一份 200 行日志不要把输入框撑爆；发送时必须**完整**发出原文。
 */
const NL = String.fromCharCode(10)

describe('planPaste', () => {
  it('短文本/少量行不折叠（保持原生粘贴体验）', () => {
    const plan = planPaste('hello world', 1)
    expect(plan.compacted).toBe(false)
    expect(plan.insertText).toBe('hello world')
    expect(plan.block).toBeUndefined()
  })

  it(`行数达到 ${PASTE_MIN_LINES} 就折叠，占位符形如 [paste #1-6 lines]`, () => {
    const text = Array.from({ length: PASTE_MIN_LINES }, (_, i) => `line ${i + 1}`).join(NL)
    const plan = planPaste(text, 1)
    expect(plan.compacted).toBe(true)
    expect(plan.insertText).toBe(`[paste #1-${PASTE_MIN_LINES} lines]`)
    expect(plan.block?.content).toBe(text)
  })

  it('单行超长（>= 800 字符）也折叠（base64/压缩 JSON 场景）', () => {
    const plan = planPaste('x'.repeat(PASTE_MIN_CHARS), 3)
    expect(plan.compacted).toBe(true)
    expect(plan.insertText).toBe('[paste #3-1 lines]')
  })

  it('序号决定占位符编号（多次粘贴可区分）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join(NL)
    expect(planPaste(text, 2).insertText).toBe('[paste #2-10 lines]')
  })
})

describe('expandPastes', () => {
  it('把占位符替换回原文', () => {
    const text = Array.from({ length: 8 }, (_, i) => `row ${i}`).join(NL)
    const block = planPaste(text, 1).block
    if (block === undefined) throw new Error('应折叠')
    const input = `请看这段日志 ${block.placeholder} 然后总结`
    expect(expandPastes(input, [block])).toBe(`请看这段日志 ${text} 然后总结`)
  })

  it('占位符已被删掉时不展开（不能「删了却还在发」）', () => {
    const text = Array.from({ length: 8 }, (_, i) => `row ${i}`).join(NL)
    const block = planPaste(text, 1).block
    if (block === undefined) throw new Error('应折叠')
    expect(expandPastes('只剩文字', [block])).toBe('只剩文字')
    expect(pruneBlocks('只剩文字', [block])).toEqual([])
  })

  it('保留仍在输入框里的块', () => {
    const text = Array.from({ length: 8 }, (_, i) => `row ${i}`).join(NL)
    const block = planPaste(text, 1).block
    if (block === undefined) throw new Error('应折叠')
    expect(pruneBlocks(`x ${block.placeholder}`, [block])).toHaveLength(1)
  })
})
