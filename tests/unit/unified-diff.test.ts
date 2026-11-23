import { describe, expect, it } from 'vitest'

import {
  createUnifiedDiff,
  diffLines,
  splitLines,
  truncatePatch
} from '../../src/main/services/unified-diff'

/**
 * 统一 diff 生成与截断（M6）。
 *
 * 断言的是**形态**（git 同形：`diff --git` / `---` / `+++` / `@@`），
 * 以及「不静默截断」：超限必须带显式说明。
 */
describe('splitLines', () => {
  it('尾部换行不制造空行', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines(null)).toEqual([])
  })
})

describe('diffLines', () => {
  it('相同输入没有 diff 行', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b'])
    expect(ops.every((op) => op.kind === 'ctx')).toBe(true)
  })

  it('中间插入一行：只有一处 add', () => {
    const ops = diffLines(['a', 'c'], ['a', 'b', 'c'])
    expect(ops.filter((op) => op.kind === 'add').map((op) => op.text)).toEqual(['b'])
    expect(ops.filter((op) => op.kind === 'del')).toHaveLength(0)
  })

  it('规模超预算时退化为整段替换（不爆内存）', () => {
    const before = Array.from({ length: 500 }, (_, index) => `old-${index}`)
    const after = Array.from({ length: 500 }, (_, index) => `new-${index}`)
    const ops = diffLines(before, after, 100)
    expect(ops.filter((op) => op.kind === 'del')).toHaveLength(500)
    expect(ops.filter((op) => op.kind === 'add')).toHaveLength(500)
  })
})

describe('createUnifiedDiff', () => {
  it('修改文件：git 同形头部 + hunk', () => {
    const patch = createUnifiedDiff({
      oldPath: 'a.txt',
      newPath: 'a.txt',
      before: 'one\ntwo\n',
      after: 'one\nTWO\n'
    })
    expect(patch).toContain('diff --git a/a.txt b/a.txt')
    expect(patch).toContain('--- a/a.txt')
    expect(patch).toContain('+++ b/a.txt')
    expect(patch).toMatch(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/)
    expect(patch).toContain('-two')
    expect(patch).toContain('+TWO')
    expect(patch.endsWith('\n')).toBe(true)
  })

  it('新增文件：/dev/null + new file', () => {
    const patch = createUnifiedDiff({
      oldPath: null,
      newPath: 'new.txt',
      before: null,
      after: 'hello\n'
    })
    expect(patch).toContain('new file')
    expect(patch).toContain('--- /dev/null')
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).toContain('+hello')
  })

  it('删除文件：+++ /dev/null + deleted file', () => {
    const patch = createUnifiedDiff({
      oldPath: 'gone.txt',
      newPath: null,
      before: 'bye\n',
      after: null
    })
    expect(patch).toContain('deleted file')
    expect(patch).toContain('--- a/gone.txt')
    expect(patch).toContain('+++ /dev/null')
    expect(patch).toContain('-bye')
  })

  it('内容未变 → 空补丁（调用方据此给「无变化」提示）', () => {
    expect(createUnifiedDiff({ oldPath: 'a', newPath: 'a', before: 'x\n', after: 'x\n' })).toBe('')
  })
})

describe('truncatePatch', () => {
  it('未超限时原样返回', () => {
    const patch = 'diff --git a/a b/a\n'
    expect(truncatePatch(patch, 1024)).toEqual({ patch, truncated: false })
  })

  it('超限时按行截断并追加显式说明', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `+line-${index}-${'x'.repeat(40)}`)
    const patch = `${lines.join('\n')}\n`
    const result = truncatePatch(patch, 512)
    expect(result.truncated).toBe(true)
    expect(result.patch).toContain('补丁超过上限')
    expect(Buffer.byteLength(result.patch, 'utf8')).toBeLessThan(patch.length)
    // 不切断行：每一行要么完整保留，要么不保留
    for (const line of result.patch.split('\n')) {
      if (line.startsWith('+line-')) expect(line).toMatch(/^\+line-\d+-x+$/)
    }
  })
})
