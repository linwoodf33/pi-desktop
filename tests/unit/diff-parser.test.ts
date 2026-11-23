import { describe, expect, it } from 'vitest'

import {
  diffFileLabel,
  diffFileStats,
  diffTotals,
  parseUnifiedDiff
} from '../../src/renderer/lib/diff'

/**
 * unified diff 解析（M6 DiffView 的数据源）。
 *
 * 目标：git 输出与「快照合成补丁」两种来源都解析成同一结构，
 * 并且**不把补丁内容当作任何可执行的东西**（纯文本行）。
 */
describe('parseUnifiedDiff', () => {
  it('解析标准 git 补丁：文件 / hunk / 行类型', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const x = 1',
      '-const y = 2',
      '+const y = 3',
      ''
    ].join('\n')

    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(1)
    expect(files[0]?.oldPath).toBe('src/a.ts')
    expect(files[0]?.newPath).toBe('src/a.ts')
    expect(files[0]?.meta).toEqual(['index 111..222 100644'])
    expect(files[0]?.hunks).toHaveLength(1)
    expect(files[0]?.hunks[0]?.header).toBe('@@ -1,2 +1,2 @@')
    expect(files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(['ctx', 'del', 'add'])
    expect(files[0]?.hunks[0]?.lines[1]?.text).toBe('const y = 2')
  })

  it('解析重命名（无 hunk 的纯元信息补丁）', () => {
    const patch = [
      'diff --git a/a.txt b/sub/a2.txt',
      'similarity index 100%',
      'rename from a.txt',
      'rename to sub/a2.txt',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(1)
    expect(files[0]?.hunks).toEqual([])
    expect(files[0]?.meta).toContain('rename from a.txt')
    expect(diffFileLabel(files[0]!)).toBe('a.txt → sub/a2.txt')
  })

  it('新增文件：/dev/null 不当作路径', () => {
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hi',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files[0]?.oldPath).toBeUndefined()
    expect(files[0]?.newPath).toBe('new.txt')
    expect(diffFileStats(files[0]!)).toEqual({ additions: 1, deletions: 0 })
  })

  it('多个文件块分别解析，并统计总增删', () => {
    const patch = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b b/b',
      '--- a/b',
      '+++ b/b',
      '@@ -1 +1,2 @@',
      ' keep',
      '+added',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(2)
    expect(diffTotals(files)).toEqual({ additions: 2, deletions: 1 })
  })

  it('截断提示行作为 meta 行保留（不丢信息）', () => {
    const patch = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '（补丁超过上限，已按行截断）',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    const kinds = files[0]?.hunks[0]?.lines.map((line) => line.kind)
    expect(kinds).toEqual(['del', 'add', 'meta'])
  })

  it('空补丁 → 空数组', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('补丁里的 HTML/脚本只作为文本被解析（不存在执行路径）', () => {
    const patch = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-<script>alert(1)</script>',
      '+<img src=x onerror=alert(1)>',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    const lines = files[0]?.hunks[0]?.lines ?? []
    expect(lines[0]?.text).toBe('<script>alert(1)</script>')
    expect(lines[1]?.text).toBe('<img src=x onerror=alert(1)>')
  })
})
