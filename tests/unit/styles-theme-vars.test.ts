import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 样式表「只许用主题变量」的结构性守卫。
 *
 * 真实缺陷（v0.3.1 用户反馈）：`.tool-card__output pre` 把底色写死成近黑色，
 * 主题切到浅色后文字是深色 → **黑底黑字**，工具调用框直接不可读。
 * 同类硬编码还有提示条、diff 行、主按钮的文字色。
 *
 * 这类问题的根因是「颜色绕过主题变量」，逐个改值只能治标。这里改成守规则：
 * 除 `:root`（兜底默认值）之外，样式中不允许出现十六进制 / `rgb()` 颜色字面量；
 * 需要颜色就加到 `shared/contracts/theme.ts` 的调色板里，由 `useAppliedTheme` 注入。
 */
const CSS_PATH = join(process.cwd(), 'src/renderer/app/styles.css')
const css = readFileSync(CSS_PATH, 'utf8')
const NEWLINE = String.fromCharCode(10)

/** 去掉 `:root { ... }`（那里允许写默认值，且必须与 pi-dark 一致，由 theme 单测守） */
function stripRootBlock(source: string): string {
  const start = source.indexOf(':root {')
  if (start < 0) throw new Error('styles.css 缺少 :root 块')
  const end = source.indexOf(NEWLINE + '}', start)
  if (end < 0) throw new Error(':root 块未闭合')
  return source.slice(0, start) + source.slice(end + 2)
}

/** `var(--x, #fff)` 里的回退色是显式兜底，不算绕过变量 */
function stripVarFallbacks(source: string): string {
  return source.replace(/var\(--[\w-]+\s*,[^)]*\)/g, 'var(--x)')
}

/**
 * `box-shadow` 里的黑色透明是投影，不参与文字可读性，也不该做成主题色
 * （深色主题也用同一种投影）。这里按行豁免，其余一律禁止字面量颜色。
 */
function stripShadows(source: string): string {
  return source
    .split(NEWLINE)
    .filter((line) => !line.includes('box-shadow'))
    .join(NEWLINE)
}

const body = stripShadows(stripVarFallbacks(stripRootBlock(css)))

describe('styles.css 不得硬编码颜色', () => {
  it('没有十六进制颜色字面量（:root 与 var() 回退除外）', () => {
    const hits = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hits, `发现硬编码 hex：${hits.join(', ')}`).toEqual([])
  })

  it('没有 rgb()/rgba() 颜色字面量', () => {
    const hits = body.match(/\brgba?\(/g) ?? []
    expect(hits, `发现硬编码 rgb()：${hits.length} 处`).toEqual([])
  })

  it('语义表面用的是变量（防止有人又写死底色）', () => {
    // 代码块 / 工具输出底色
    expect(body).toContain('background: var(--code-bg)')
    // 强调实底上的文字
    expect(body).toContain('color: var(--on-accent)')
    // 提示条与 diff 行的语义文字色
    expect(body).toContain('color: var(--danger-text)')
    expect(body).toContain('color: var(--warn-text)')
    expect(body).toContain('color: var(--success-text)')
  })

  it('样式里用到的每个主题变量都由调色板提供（拼错变量名会静默失效）', () => {
    // 只认 `var(--x` 的用法：`--` 在 BEM 修饰符里也出现（`.layout--artifacts-collapsed`），
    // 直接扫 `--\w+` 会把类名当成变量名
    const vars = new Set((css.match(/var\((--[a-z][\w-]*)/g) ?? []).map((hit) => hit.slice(4)))
    // 非颜色变量 + 与主题无关的遮罩层
    const exempt = new Set(['--mono', '--sans', '--scrim'])
    const paletteKeys = [
      '--bg',
      '--bg-panel',
      '--bg-elevated',
      '--bg-hover',
      '--border',
      '--border-strong',
      '--text',
      '--text-dim',
      '--text-faint',
      '--accent',
      '--accent-dim',
      '--ok',
      '--warn',
      '--error',
      '--code-comment',
      '--code-keyword',
      '--code-string',
      '--code-number',
      '--code-title',
      '--code-builtin',
      '--code-deletion',
      '--code-bg',
      '--on-accent',
      '--accent-hover',
      '--danger-text',
      '--warn-text',
      '--success-text'
    ]
    const missing = paletteKeys.filter((name) => !vars.has(name))
    expect(missing, `样式里没用到：${missing.join(', ')}`).toEqual([])

    const unknown = [...vars].filter((name) => !exempt.has(name) && !paletteKeys.includes(name))
    expect(unknown, `样式用了主题注册表里没有的变量：${unknown.join(', ')}`).toEqual([])
  })
})
