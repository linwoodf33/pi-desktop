import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { THEMES, type ConcreteThemeId } from '../../src/shared/contracts/theme'

/**
 * 主题切换 E2E。
 *
 * 守两件事：
 * 1. 选中的主题**真的作用到 DOM**（`data-theme` + `--bg` 等 CSS 变量 + `color-scheme`），
 *    而不是像 v0.1 那样只把选择写进配置、界面毫无变化；
 * 2. 生效后的实际颜色**满足 WCAG AA**（正文/背景 ≥ 4.5）—— 单测守的是注册表数据，
 *    这里守的是「浏览器里算出来的值」。
 *
 * 另外为每个主题出一张整窗截图（`docs/screenshots/theme-<id>.png`），供人工复核观感。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const SHOT_DIR = resolve(APP_ROOT, 'docs/screenshots')

/** 截图与断言覆盖的主题：明暗各取代表，避免用例时长失控 */
const COVERED: readonly ConcreteThemeId[] = [
  'pi-dark',
  'pi-light',
  'github-light',
  'solarized-light',
  'nord',
  'dracula',
  'one-dark',
  'tokyonight',
  'catppuccin-mocha'
]

let app: ElectronApplication
let page: Page
let tempRoot: string

interface ThemeSnapshot {
  applied: string | null
  colorScheme: string
  bg: string
  text: string
  accent: string
  /** 由浏览器计算出的正文/背景对比度 */
  contrast: number
}

/** 页面内在用的对比度算法（与单测同一套 WCAG 公式，但输入是浏览器算出的 rgb） */
async function snapshot(): Promise<ThemeSnapshot> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number] => {
      const match = /rgba?\(([^)]+)\)/.exec(value)
      const parts = (match?.[1] ?? '0,0,0').split(',').map((item) => Number(item.trim()))
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    }
    const luminance = (rgb: [number, number, number]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      }) as [number, number, number]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const style = getComputedStyle(document.documentElement)
    const bgRaw = style.getPropertyValue('--bg').trim()
    const textRaw = style.getPropertyValue('--text').trim()
    const accentRaw = style.getPropertyValue('--accent').trim()
    // 变量是 hex；用一次性元素让浏览器把它规范成 rgb，避免自己再写一套 hex 解析
    const probe = document.createElement('div')
    document.body.append(probe)
    const toRgb = (value: string): string => {
      probe.style.color = value
      return getComputedStyle(probe).color
    }
    const bg = toRgb(bgRaw)
    const text = toRgb(textRaw)
    const accent = toRgb(accentRaw)
    probe.remove()
    const [high, low] = [luminance(parse(text)), luminance(parse(bg))].sort((a, b) => b - a) as [
      number,
      number
    ]
    return {
      applied: document.documentElement.dataset['theme'] ?? null,
      colorScheme: style.colorScheme,
      bg,
      text,
      accent,
      contrast: (high + 0.05) / (low + 0.05)
    }
  })
}

async function openSettings(): Promise<void> {
  const toggle = page.locator('.settings-toggle')
  const isOpen = await toggle.evaluate((el) => (el as HTMLDetailsElement).open)
  if (!isOpen) await page.click('.settings-toggle > summary')
  await page.waitForSelector('[data-testid="settings-theme"]', { timeout: 30_000 })
}

/** 选主题 → 保存 → 等 DOM 应用 */
async function selectTheme(id: string): Promise<ThemeSnapshot> {
  await openSettings()
  await page.selectOption('[data-testid="settings-theme"]', id)
  await page.click('[data-testid="settings-save"]')
  const expected = id === 'system' ? null : id
  await page.waitForFunction(
    (want) =>
      want === null
        ? document.documentElement.dataset['theme'] !== undefined
        : document.documentElement.dataset['theme'] === want,
    expected,
    { timeout: 20_000 }
  )
  return snapshot()
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-theme-'))
  const workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
  })
}, 180_000)

afterAll(async () => {
  await app.close()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('主题切换', () => {
  it('设置面板列出全部主题（system + 注册表里的每个 id）', async () => {
    await openSettings()
    const values = await page
      .locator('[data-testid="settings-theme"] option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    expect(values).toEqual(['system', ...THEMES.map((theme) => theme.id)])
  })

  for (const id of COVERED) {
    it(`${id}：应用到 DOM 且正文对比度 ≥ 4.5`, async () => {
      const theme = THEMES.find((item) => item.id === id)
      if (theme === undefined) throw new Error(`注册表缺少 ${id}`)

      const state = await selectTheme(id)
      expect(state.applied).toBe(id)
      expect(state.colorScheme).toBe(theme.scheme)
      expect(state.contrast).toBeGreaterThanOrEqual(4.5)

      // 截图前把面板收起、回到完整三栏，观感复核才有意义
      await page.click('.settings-toggle > summary')
      await page.waitForTimeout(150)
      await page.screenshot({ path: join(SHOT_DIR, `theme-${id}.png`), fullPage: false })
    })
  }

  it('选择会持久化：重载窗口后仍是该主题', async () => {
    await selectTheme('dracula')
    await page.reload()
    await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'dracula', {
      timeout: 30_000
    })
    const state = await snapshot()
    expect(state.applied).toBe('dracula')
    expect(state.contrast).toBeGreaterThanOrEqual(4.5)
  })

  it('跟随系统：解析成 pi 深色或 pi 浅色之一', async () => {
    const state = await selectTheme('system')
    expect(['pi-dark', 'pi-light']).toContain(state.applied)
    expect(state.contrast).toBeGreaterThanOrEqual(4.5)
  })
})
