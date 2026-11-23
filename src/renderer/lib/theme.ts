import { useEffect } from 'react'

import { paletteToCssVars, resolveTheme } from '../../shared/contracts/theme'

/**
 * 把主题应用到 DOM（`<html>` 上的 CSS 变量 + `data-theme` + `color-scheme`）。
 *
 * 为什么写 style 而不是切 CSS class：调色板的单一真源在 `shared/contracts/theme.ts`
 * （设置面板选项、单测、E2E 断言都读它）。脚本只把变量写一次，样式表里留一份默认值兜底首帧。
 *
 * `system` 的选择要跟随系统变化实时切换：监听 `prefers-color-scheme`，
 * 用户改系统主题时窗口不必重启。
 */
export function useAppliedTheme(selection: string | undefined): void {
  useEffect(() => {
    if (selection === undefined) return undefined

    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const { definition } = resolveTheme(selection, media.matches)
      const root = document.documentElement
      for (const [name, value] of Object.entries(paletteToCssVars(definition.palette))) {
        root.style.setProperty(name, value)
      }
      // `data-theme` 供样式表做少量「非颜色」微调，也方便 E2E/人工核对当前主题
      root.dataset['theme'] = definition.id
      // 原生控件（滚动条、输入框、select 下拉）跟随明暗
      root.style.colorScheme = definition.scheme
    }

    apply()
    // 只有「跟随系统」需要监听；选了具体主题时系统变化不应影响外观
    if (selection !== 'system') return undefined
    const onChange = (): void => {
      apply()
    }
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [selection])
}
