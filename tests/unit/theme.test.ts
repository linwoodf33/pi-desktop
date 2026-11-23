import { describe, expect, it } from 'vitest'

import {
  THEMES,
  THEME_IDS,
  cssVarName,
  normalizeThemeId,
  paletteToCssVars,
  resolveTheme,
  type ThemePalette
} from '../../src/shared/contracts/theme'

/**
 * 主题注册表（`shared/contracts/theme.ts`）。
 *
 * 这里守的是「可读性」这条硬约束：颜色再好看，对比度不够就等于缺陷。
 * 用 WCAG 2.1 的相对亮度公式算对比度，阈值取 AA：
 * - 正文 / 次要文本 vs 背景 ≥ 4.5
 * - 强调色（链接、按钮文字）vs 背景 ≥ 3（UI 组件的 AA 门槛）
 */

/** WCAG 相对亮度（sRGB） */
function luminance(hex: string): number {
  const value = hex.replace('#', '')
  if (value.length !== 6) throw new Error(`不是 6 位 hex：${hex}`)
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255
  )
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  const [r, g, b] = linear as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

describe('主题注册表', () => {
  it('id 唯一，且 THEME_IDS = system + 全部主题', () => {
    const ids = THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(THEME_IDS).toEqual(['system', ...ids])
  })

  it('每个主题的调色板键齐全、都是 6 位 hex', () => {
    const expectedKeys: (keyof ThemePalette)[] = [
      'bg',
      'bgPanel',
      'bgElevated',
      'bgHover',
      'border',
      'borderStrong',
      'text',
      'textDim',
      'textFaint',
      'accent',
      'accentDim',
      'ok',
      'warn',
      'error',
      'codeComment',
      'codeKeyword',
      'codeString',
      'codeNumber',
      'codeTitle',
      'codeBuiltin',
      'codeDeletion'
    ]
    for (const theme of THEMES) {
      expect(Object.keys(theme.palette).sort()).toEqual([...expectedKeys].sort())
      for (const value of Object.values(theme.palette)) {
        expect(value, `${theme.id} 的颜色 ${value}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('正文与次要文本对背景的对比度 ≥ 4.5（WCAG AA）', () => {
    for (const theme of THEMES) {
      const { bg, bgPanel, bgElevated, text, textDim } = theme.palette
      expect(contrast(text, bg), `${theme.id} text/bg`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(text, bgPanel), `${theme.id} text/panel`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(text, bgElevated), `${theme.id} text/elevated`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(textDim, bg), `${theme.id} textDim/bg`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('强调色与状态色对背景的对比度 ≥ 3（UI 组件 AA）', () => {
    for (const theme of THEMES) {
      const { bg, accent, ok, warn, error } = theme.palette
      expect(contrast(accent, bg), `${theme.id} accent/bg`).toBeGreaterThanOrEqual(3)
      expect(contrast(ok, bg), `${theme.id} ok/bg`).toBeGreaterThanOrEqual(3)
      expect(contrast(warn, bg), `${theme.id} warn/bg`).toBeGreaterThanOrEqual(3)
      expect(contrast(error, bg), `${theme.id} error/bg`).toBeGreaterThanOrEqual(3)
    }
  })

  it('代码 token 色对代码块底色 ≥ 3（否则高亮等于没高亮）', () => {
    for (const theme of THEMES) {
      const {
        bgElevated,
        codeComment,
        codeKeyword,
        codeString,
        codeNumber,
        codeTitle,
        codeBuiltin
      } = theme.palette
      for (const [name, color] of Object.entries({
        codeComment,
        codeKeyword,
        codeString,
        codeNumber,
        codeTitle,
        codeBuiltin
      })) {
        expect(contrast(color, bgElevated), `${theme.id} ${name}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('明暗声明与背景亮度一致（浅色主题的 bg 必须比文字亮）', () => {
    for (const theme of THEMES) {
      const bgLum = luminance(theme.palette.bg)
      const textLum = luminance(theme.palette.text)
      if (theme.scheme === 'light') expect(bgLum, theme.id).toBeGreaterThan(textLum)
      else expect(bgLum, theme.id).toBeLessThan(textLum)
    }
  })
})

describe('resolveTheme', () => {
  it('具体 id 原样返回', () => {
    expect(resolveTheme('nord', true).id).toBe('nord')
    expect(resolveTheme('github-light', false).id).toBe('github-light')
  })

  it('system 按系统偏好解析成 pi 深色 / pi 浅色', () => {
    expect(resolveTheme('system', true).id).toBe('pi-dark')
    expect(resolveTheme('system', false).id).toBe('pi-light')
  })

  it('历史值 dark / light 映射到同族主题（升级后主题不被重置）', () => {
    expect(resolveTheme('dark', false).id).toBe('pi-dark')
    expect(resolveTheme('light', true).id).toBe('pi-light')
  })

  it('未知值退回默认主题而不是抛错', () => {
    expect(resolveTheme('no-such-theme', true).id).toBe('pi-dark')
  })
})

describe('normalizeThemeId', () => {
  it('历史值归一为当前 id', () => {
    expect(normalizeThemeId('dark')).toBe('pi-dark')
    expect(normalizeThemeId('light')).toBe('pi-light')
  })

  it('现役 id 与 system 保持不变', () => {
    expect(normalizeThemeId('system')).toBe('system')
    expect(normalizeThemeId('dracula')).toBe('dracula')
  })

  it('非法/非字符串退回 system', () => {
    expect(normalizeThemeId('weird')).toBe('system')
    expect(normalizeThemeId(undefined)).toBe('system')
    expect(normalizeThemeId(42)).toBe('system')
  })
})

describe('CSS 变量映射', () => {
  it('驼峰键转 kebab 变量名', () => {
    expect(cssVarName('bgPanel')).toBe('--bg-panel')
    expect(cssVarName('codeDeletion')).toBe('--code-deletion')
    expect(cssVarName('bg')).toBe('--bg')
  })

  it('调色板展开后变量数量与键数量一致，且都是 -- 前缀', () => {
    const vars = paletteToCssVars(THEMES[0]!.palette)
    expect(Object.keys(vars)).toHaveLength(Object.keys(THEMES[0]!.palette).length)
    expect(Object.keys(vars).every((name) => name.startsWith('--'))).toBe(true)
    expect(vars['--bg']).toBe(THEMES[0]!.palette.bg)
  })
})
