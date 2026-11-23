/**
 * 主题注册表（单一真源）。
 *
 * 为什么把调色板放在 TS 而不是 CSS：主题要能被「设置面板选项 / 单元测试 / E2E 断言 /
 * 截图回归」同时读取，写在 CSS 里就只能靠人工比对字符串。运行时把调色板写进
 * `document.documentElement.style` 的 CSS 变量，样式表里只留一份默认值兜底首帧。
 *
 * 取色来源（公开的官方配色，未做「二次创作」，便于用户认出来）：
 * - pi-dark / pi-light：沿用本应用既有暗色，外加同族浅色
 * - github-light：GitHub 官方 Primer light 配色
 * - solarized-light：Solarized（Ethan Schoonover）light 变体
 * - nord：Nord（Arctic Ice Studio）Polar Night + Frost
 * - dracula：Dracula 官方
 * - one-dark：Atom One Dark
 * - tokyonight：Tokyo Night（enkia）
 * - catppuccin-mocha：Catppuccin Mocha
 *
 * 代码高亮（highlight.js 的 token 类别）也用主题变量，否则浅色主题里代码块会是
 * 深色语法色叠在浅底上（对比度不足）。
 */

/** 主题 id（`system` 是「跟随系统」，不是具体调色板） */
export type ThemeId =
  | 'system'
  | 'pi-dark'
  | 'pi-light'
  | 'github-light'
  | 'solarized-light'
  | 'nord'
  | 'dracula'
  | 'one-dark'
  | 'tokyonight'
  | 'catppuccin-mocha'

/** 应用到 DOM 的具体主题（`system` 已被解析掉） */
export type ConcreteThemeId = Exclude<ThemeId, 'system'>

export type ColorScheme = 'dark' | 'light'

/** 一套调色板：键名与 CSS 变量同名（驼峰 ↔ kebab 由 `cssVarName` 转换） */
export interface ThemePalette {
  bg: string
  bgPanel: string
  bgElevated: string
  bgHover: string
  border: string
  borderStrong: string
  text: string
  textDim: string
  textFaint: string
  accent: string
  accentDim: string
  ok: string
  warn: string
  error: string
  /**
   * 代码块 / diff 的语法着色。
   *
   * 注释色刻意比上游原始配色亮一档：Dracula/One Dark/Tokyo Night/Catppuccin 的官方注释色
   * 对各自 elevated 底只有 1.7–2.6:1（编辑器里能忍，在 12px 中文行里就是不可读）。
   * `tests/unit/theme.test.ts` 用 3:1 卡这条线。
   */
  codeComment: string
  codeKeyword: string
  codeString: string
  codeNumber: string
  codeTitle: string
  codeBuiltin: string
  codeDeletion: string
  /** 代码块 / 工具输出的底色（浅色主题不能沿用近黑底，否则黑底黑字） */
  codeBg: string
  /** 强调色实底（主按钮 / 药丸）上的文字色 */
  onAccent: string
  /** 主按钮 hover 底色：必须仍能撑住 `onAccent` 的 4.5:1（不能直接用更亮的 accent） */
  accentHover: string
  /** 提示条与 diff 行上的语义文字色（比 ok/warn/error 更亮或更暗，保证在 12–14% 染色底上仍可读） */
  dangerText: string
  warnText: string
  successText: string
}

export interface ThemeDefinition {
  id: ConcreteThemeId
  /** 设置面板里的显示名 */
  label: string
  scheme: ColorScheme
  palette: ThemePalette
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'pi-dark',
    label: 'pi 深色（默认）',
    scheme: 'dark',
    palette: {
      bg: '#0f1216',
      bgPanel: '#14181d',
      bgElevated: '#1a1f26',
      bgHover: '#20262e',
      border: '#262d36',
      borderStrong: '#333c47',
      text: '#d8dee6',
      textDim: '#8b95a3',
      textFaint: '#66707d',
      accent: '#4c9ef0',
      accentDim: '#2b6ba8',
      ok: '#3fb27f',
      warn: '#d3a03a',
      error: '#e0625e',
      codeBg: '#0b0e12',
      onAccent: '#ffffff',
      accentHover: '#3070b3',
      dangerText: '#f3c3c1',
      warnText: '#f0dcae',
      successText: '#9ae6b4',
      codeComment: '#6a737d',
      codeKeyword: '#c792ea',
      codeString: '#9ecb7a',
      codeNumber: '#f2b26b',
      codeTitle: '#6fb3f2',
      codeBuiltin: '#4fd1c5',
      codeDeletion: '#e0625e'
    }
  },
  {
    id: 'pi-light',
    label: 'pi 浅色',
    scheme: 'light',
    palette: {
      bg: '#ffffff',
      bgPanel: '#f7f8fa',
      bgElevated: '#ffffff',
      bgHover: '#eef1f5',
      border: '#e1e5ea',
      borderStrong: '#c9d0d8',
      text: '#1c2329',
      textDim: '#5b6570',
      textFaint: '#8a949f',
      accent: '#2f81c9',
      accentDim: '#1f5f99',
      ok: '#2e8b63',
      warn: '#a97817',
      error: '#c7413d',
      codeBg: '#f2f4f7',
      onAccent: '#ffffff',
      accentHover: '#266db0',
      dangerText: '#c7413d',
      warnText: '#8a6200',
      successText: '#226b4b',
      codeComment: '#6f7985',
      codeKeyword: '#8250df',
      codeString: '#116329',
      codeNumber: '#a97817',
      codeTitle: '#2f81c9',
      codeBuiltin: '#0f766e',
      codeDeletion: '#c7413d'
    }
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    scheme: 'light',
    palette: {
      bg: '#ffffff',
      bgPanel: '#f6f8fa',
      bgElevated: '#ffffff',
      bgHover: '#eaeef2',
      border: '#d0d7de',
      borderStrong: '#afb8c1',
      text: '#1f2328',
      textDim: '#59636e',
      textFaint: '#818b98',
      accent: '#0969da',
      accentDim: '#0550ae',
      ok: '#1a7f37',
      warn: '#9a6700',
      error: '#cf222e',
      codeBg: '#f6f8fa',
      onAccent: '#ffffff',
      accentHover: '#0a5ec2',
      dangerText: '#cf222e',
      warnText: '#9a6700',
      successText: '#1a7f37',
      codeComment: '#6e7781',
      codeKeyword: '#cf222e',
      codeString: '#0a3069',
      codeNumber: '#0550ae',
      codeTitle: '#8250df',
      codeBuiltin: '#953800',
      codeDeletion: '#82071e'
    }
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    scheme: 'light',
    palette: {
      // Solarized Light 原版正文对比度只有 4.39（低于 AA 4.5），这里按同一色相加深到
      // 满足 AA/AA-UI 的档位（「Solarized Light 高对比度」变体），色相仍是 Solarized 家族。
      bg: '#fdf6e3',
      bgPanel: '#eee8d5',
      bgElevated: '#f7f1de',
      bgHover: '#e6dfc9',
      border: '#ddd6c1',
      borderStrong: '#c3bda9',
      text: '#46595f',
      textDim: '#546a71',
      textFaint: '#6f7d7d',
      accent: '#1f78bd',
      accentDim: '#1a6ba0',
      ok: '#647400',
      warn: '#8a6700',
      error: '#b52b29',
      codeBg: '#f3ecda',
      onAccent: '#ffffff',
      accentHover: '#1f78bd',
      dangerText: '#b52b29',
      warnText: '#8a6700',
      successText: '#647400',
      codeComment: '#6f7d7d',
      codeKeyword: '#647400',
      codeString: '#17807a',
      codeNumber: '#a82565',
      codeTitle: '#1f78bd',
      codeBuiltin: '#8a6700',
      codeDeletion: '#b52b29'
    }
  },
  {
    id: 'nord',
    label: 'Nord',
    scheme: 'dark',
    palette: {
      // Nord 的分层：nord0 底 → nord1 面板 → nord2 hover → nord3 边框。
      // 注释色必须比原版更亮（原版 #616e88 是为最暗底设计的，放在 nord1 上只有 1.96:1）。
      bg: '#2e3440',
      bgPanel: '#292e39',
      bgElevated: '#3b4252',
      bgHover: '#434c5e',
      border: '#434c5e',
      borderStrong: '#4c566a',
      text: '#eceff4',
      textDim: '#d8dee9',
      textFaint: '#a3abb8',
      accent: '#88c0d0',
      accentDim: '#48628a',
      ok: '#a3be8c',
      warn: '#ebcb8b',
      error: '#bf616a',
      codeBg: '#272c36',
      onAccent: '#ffffff',
      accentHover: '#53749f',
      dangerText: '#ffb3b1',
      warnText: '#ffe9b8',
      successText: '#b8e6c0',
      codeComment: '#8f9bb3',
      codeKeyword: '#81a1c1',
      codeString: '#a3be8c',
      codeNumber: '#b48ead',
      codeTitle: '#88c0d0',
      codeBuiltin: '#8fbcbb',
      codeDeletion: '#bf616a'
    }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    scheme: 'dark',
    palette: {
      bg: '#282a36',
      bgPanel: '#21222c',
      bgElevated: '#343746',
      bgHover: '#44475a',
      border: '#44475a',
      borderStrong: '#6272a4',
      text: '#f8f8f2',
      textDim: '#c8c8d0',
      textFaint: '#8f92a8',
      accent: '#bd93f9',
      accentDim: '#7556b8',
      ok: '#50fa7b',
      warn: '#f1fa8c',
      error: '#ff5555',
      codeBg: '#1e1f29',
      onAccent: '#ffffff',
      accentHover: '#8062c6',
      dangerText: '#ffb3b3',
      warnText: '#f8f8b0',
      successText: '#b6ffc4',
      codeComment: '#8b93bd',
      codeKeyword: '#ff79c6',
      codeString: '#f1fa8c',
      codeNumber: '#bd93f9',
      codeTitle: '#8be9fd',
      codeBuiltin: '#50fa7b',
      codeDeletion: '#ff5555'
    }
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    scheme: 'dark',
    palette: {
      bg: '#282c34',
      bgPanel: '#21252b',
      bgElevated: '#2c313a',
      bgHover: '#3a404c',
      border: '#3e4451',
      borderStrong: '#4b5263',
      text: '#abb2bf',
      textDim: '#9aa1ad',
      textFaint: '#6b7280',
      accent: '#61afef',
      accentDim: '#316894',
      ok: '#98c379',
      warn: '#e5c07b',
      error: '#e06c75',
      codeBg: '#1b1e24',
      onAccent: '#ffffff',
      accentHover: '#3a7aad',
      dangerText: '#f0a8a8',
      warnText: '#f0dcae',
      successText: '#b6e3a8',
      codeComment: '#7d8593',
      codeKeyword: '#c678dd',
      codeString: '#98c379',
      codeNumber: '#d19a66',
      codeTitle: '#61afef',
      codeBuiltin: '#56b6c2',
      codeDeletion: '#e06c75'
    }
  },
  {
    id: 'tokyonight',
    label: 'Tokyo Night',
    scheme: 'dark',
    palette: {
      bg: '#1a1b26',
      bgPanel: '#16161e',
      bgElevated: '#1f2335',
      bgHover: '#292e42',
      border: '#292e42',
      borderStrong: '#3b4261',
      text: '#c0caf5',
      textDim: '#a9b1d6',
      textFaint: '#565f89',
      accent: '#7aa2f7',
      accentDim: '#3d59a1',
      ok: '#9ece6a',
      warn: '#e0af68',
      error: '#f7768e',
      codeBg: '#12131c',
      onAccent: '#ffffff',
      accentHover: '#4a6fc4',
      dangerText: '#ffb4c0',
      warnText: '#f5d9a8',
      successText: '#c4ecac',
      codeComment: '#6d77a3',
      codeKeyword: '#bb9af7',
      codeString: '#9ece6a',
      codeNumber: '#ff9e64',
      codeTitle: '#7aa2f7',
      codeBuiltin: '#2ac3de',
      codeDeletion: '#f7768e'
    }
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    scheme: 'dark',
    palette: {
      bg: '#1e1e2e',
      bgPanel: '#181825',
      bgElevated: '#313244',
      bgHover: '#45475a',
      border: '#313244',
      borderStrong: '#45475a',
      text: '#cdd6f4',
      textDim: '#a6adc8',
      textFaint: '#6c7086',
      accent: '#89b4fa',
      accentDim: '#3a639f',
      ok: '#a6e3a1',
      warn: '#f9e2af',
      error: '#f38ba8',
      codeBg: '#16161f',
      onAccent: '#ffffff',
      accentHover: '#4374b8',
      dangerText: '#f8b8c8',
      warnText: '#f8e8c0',
      successText: '#c4f0c0',
      codeComment: '#8489a3',
      codeKeyword: '#cba6f7',
      codeString: '#a6e3a1',
      codeNumber: '#fab387',
      codeTitle: '#89b4fa',
      codeBuiltin: '#94e2d5',
      codeDeletion: '#f38ba8'
    }
  }
] as const

/** 全部可选值（含 `system`），用于 zod 枚举与设置面板 */
export const THEME_IDS: readonly ThemeId[] = ['system', ...THEMES.map((theme) => theme.id)]

/**
 * 历史值 → 当前 id。
 *
 * v0.1 的配置里只有 `dark` / `light`（当年并未真正应用），直接删会让人「主题被重置」；
 * 读配置时静默映射到同族主题。
 */
const LEGACY_THEME_ALIASES: Readonly<Record<string, ConcreteThemeId>> = {
  dark: 'pi-dark',
  light: 'pi-light'
}

/** 解析成具体主题：处理历史别名与 `system`（需要调用方给出系统偏好） */
export function resolveTheme(
  selection: string,
  prefersDark: boolean
): { id: ConcreteThemeId; definition: ThemeDefinition } {
  const legacy = LEGACY_THEME_ALIASES[selection]
  const requested = legacy ?? selection
  const concrete: ConcreteThemeId =
    requested === 'system' ? (prefersDark ? 'pi-dark' : 'pi-light') : (requested as ConcreteThemeId)
  const definition = THEMES.find((theme) => theme.id === concrete) ?? THEMES[0]
  if (definition === undefined) throw new Error('主题注册表为空')
  return { id: definition.id, definition }
}

/** 规范化一个主题选择：历史别名的写入值改成当前 id，未知值退回 `system` */
export function normalizeThemeId(value: unknown): ThemeId {
  if (typeof value !== 'string') return 'system'
  const legacy = LEGACY_THEME_ALIASES[value]
  if (legacy !== undefined) return legacy
  return (THEME_IDS as readonly string[]).includes(value) ? (value as ThemeId) : 'system'
}

/** 调色板键 → CSS 变量名（`bgPanel` → `--bg-panel`） */
export function cssVarName(key: keyof ThemePalette): string {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
}

/** 调色板 → CSS 变量表（应用主题时一次性写入） */
export function paletteToCssVars(palette: ThemePalette): Record<string, string> {
  const vars: Record<string, string> = {}
  // 逐键取值而不是 `Object.entries`：后者的类型退化成 `[string, any][]`，
  // 触发 @typescript-eslint/no-unsafe-assignment（CI 会红，本地 tail 却容易看漏）
  for (const key of Object.keys(palette) as (keyof ThemePalette)[]) {
    vars[cssVarName(key)] = palette[key]
  }
  return vars
}
