import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 设置面板排版回归 E2E。
 *
 * 为什么需要它：`<details class="settings-toggle">` 挂在 `.app__footer`（`flex:0 0 auto`）里，
 * 展开后若不限高，会把三栏挤扁且溢出部分被 `body{overflow:hidden}` 裁掉（保存按钮点不到）；
 * `.settings__list` 曾用 `repeat(auto-fit, minmax(220px, 1fr))`，宽屏下被切成 5–6 列，
 * 长路径与 `nowrap` 按钮会把输入框压成一条缝。
 *
 * 断言口径（两种宽度的窗口各跑一遍）：
 * 1. 页面与设置面板**无横向溢出**（`scrollWidth <= clientWidth + 1`）；
 * 2. 设置面板高度被封顶（不把三栏挤到 0）；
 * 3. 关键控件可见、保存按钮可点击且落在面板可视区内；
 * 4. 超长路径/长文案不撑破布局；
 * 5. 截图落到 `docs/screenshots/`（供人工复核观感）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const SHOT_DIR = resolve(APP_ROOT, 'docs/screenshots')

/** 极长的会话目录：用来验证长文本折行不撑破布局 */
const LONG_PATH =
  '/very/long/path/for/layout/regression/that/should/wrap/instead/of/overflowing/the/grid/cell/and/never/widen/the/settings/panel/horizontally/at/all'

const SIZES = [
  { label: '1280', width: 1280, height: 800 },
  { label: '1440', width: 1440, height: 900 },
  { label: '1920', width: 1920, height: 1080 }
] as const

/** 按 ±1px 容差去重，用于断言「同一列共用一条左对齐线」 */
function dedupeNear(values: number[]): number[] {
  const out: number[] = []
  for (const value of values) {
    if (!out.some((existing) => Math.abs(existing - value) <= 1)) out.push(value)
  }
  return out
}

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string

interface OverflowReport {
  docScrollWidth: number
  docClientWidth: number
  settingsScrollWidth: number
  settingsClientWidth: number
  settingsHeight: number
  viewportHeight: number
  mainPaneHeight: number
  saveVisible: boolean
  saveInPanel: boolean
  sessionDirInputWidth: number
  piCommandInputWidth: number
  settingsScrollHeight: number
  panelLeft: number
  widestRightEdge: number
  /** 各 `dt` / `dd` 左边界去重后的集合（用于断言标签列/控件列对齐） */
  dtLefts: number[]
  ddLefts: number[]
}

async function setContentSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setContentSize(size.width, size.height)
    },
    { width, height }
  )
  // 等一帧让布局稳定
  await page.waitForTimeout(250)
}

async function measure(): Promise<OverflowReport> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.settings')
    const save = document.querySelector<HTMLElement>('[data-testid="settings-save"]')
    const main = document.querySelector<HTMLElement>('.layout')
    const sessionDir = document.querySelector<HTMLElement>('[data-testid="settings-session-dir"]')
    const piCommand = document.querySelector<HTMLElement>('[data-testid="settings-pi-command"]')
    if (panel === null || save === null) throw new Error('设置面板未渲染')

    const panelRect = panel.getBoundingClientRect()
    const saveRect = save.getBoundingClientRect()

    // 面板内所有元素的最大右边界（用于发现「撑破容器」的子元素）
    let widestRightEdge = panelRect.left
    for (const node of Array.from(panel.querySelectorAll<HTMLElement>('*'))) {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.right > widestRightEdge) widestRightEdge = rect.right
    }

    return {
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      settingsScrollWidth: panel.scrollWidth,
      settingsClientWidth: panel.clientWidth,
      settingsHeight: panelRect.height,
      settingsScrollHeight: panel.scrollHeight,
      viewportHeight: window.innerHeight,
      mainPaneHeight: main?.getBoundingClientRect().height ?? 0,
      saveVisible: saveRect.width > 0 && saveRect.height > 0,
      saveInPanel: saveRect.top >= panelRect.top - 1 && saveRect.bottom <= panelRect.bottom + 1,
      sessionDirInputWidth: sessionDir?.getBoundingClientRect().width ?? 0,
      piCommandInputWidth: piCommand?.getBoundingClientRect().width ?? 0,
      panelLeft: panelRect.left,
      widestRightEdge,
      dtLefts: Array.from(panel.querySelectorAll<HTMLElement>('.settings__row dt')).map((node) =>
        Math.round(node.getBoundingClientRect().left)
      ),
      ddLefts: Array.from(panel.querySelectorAll<HTMLElement>('.settings__row dd')).map((node) =>
        Math.round(node.getBoundingClientRect().left)
      )
    }
  })
}

async function openSettings(): Promise<void> {
  const toggle = page.locator('.settings-toggle')
  const isOpen = await toggle.evaluate((el) => (el as HTMLDetailsElement).open)
  if (!isOpen) await page.click('.settings-toggle > summary')
  await page.waitForSelector('[data-testid="settings-save"]', { timeout: 30_000 })
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-settings-'))
  workDir = join(tempRoot, 'workspace')
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
}, 180_000)

afterAll(async () => {
  await app.close()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('设置面板排版', () => {
  for (const size of SIZES) {
    it(`${size.label}×${size.height} 无横向溢出且保存按钮可达`, async () => {
      await setContentSize(size.width, size.height)
      await openSettings()

      const report = await measure()

      // 1. 页面无横向溢出
      expect(report.docScrollWidth).toBeLessThanOrEqual(report.docClientWidth + 1)
      // 2. 设置面板自身无横向溢出
      expect(report.settingsScrollWidth).toBeLessThanOrEqual(report.settingsClientWidth + 1)
      // 3. 面板高度封顶，且不把主区挤没（三栏仍保有可用高度）
      expect(report.settingsHeight).toBeLessThanOrEqual(report.viewportHeight * 0.53 + 1)
      expect(report.mainPaneHeight).toBeGreaterThan(120)
      // 4. 标签列与控件列各自共用一条左对齐线
      expect(dedupeNear(report.dtLefts)).toHaveLength(1)
      expect(dedupeNear(report.ddLefts)).toHaveLength(1)
      // 5. 输入框不被压成一条缝
      expect(report.piCommandInputWidth).toBeGreaterThanOrEqual(120)
      // 6. 保存按钮常驻面板底部：即使内容超高、面板停在顶部，也无需先滚动即可点击
      expect(report.saveVisible).toBe(true)
      expect(report.saveInPanel).toBe(true)
      // 6. 面板内没有元素越过面板右边界
      expect(report.widestRightEdge).toBeLessThanOrEqual(
        report.panelLeft + report.settingsClientWidth + 2
      )

      // 截图 1：面板顶部态（默认观感）
      await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.settings')
        if (panel !== null) panel.scrollTop = 0
      })
      await page.waitForTimeout(120)
      await page.screenshot({
        path: join(SHOT_DIR, `settings-after-default-${size.label}.png`),
        fullPage: false
      })

      // 7. 内容超高时面板内部滚动（不靠拉高面板），且滚到底后保存按钮可见可点
      if (report.settingsScrollHeight > report.settingsHeight) {
        expect(report.settingsHeight).toBeLessThanOrEqual(report.viewportHeight * 0.53 + 1)
      }
      await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.settings')
        if (panel !== null) panel.scrollTop = panel.scrollHeight
      })
      await page.waitForTimeout(120)
      const afterScroll = await measure()
      expect(afterScroll.saveVisible).toBe(true)
      expect(afterScroll.saveInPanel).toBe(true)

      await page.screenshot({
        path: join(SHOT_DIR, `settings-after-scrolled-${size.label}.png`),
        fullPage: false
      })
    })
  }

  it('超长路径不撑破布局（1280 宽）', async () => {
    await setContentSize(1280, 800)
    await openSettings()

    const sessionDir = page.locator('[data-testid="settings-session-dir"]')
    await sessionDir.fill(LONG_PATH)
    await page.waitForTimeout(200)

    const report = await measure()
    expect(report.docScrollWidth).toBeLessThanOrEqual(report.docClientWidth + 1)
    expect(report.settingsScrollWidth).toBeLessThanOrEqual(report.settingsClientWidth + 1)
    expect(report.sessionDirInputWidth).toBeGreaterThanOrEqual(120)

    await page.screenshot({
      path: join(SHOT_DIR, 'settings-after-longpath-1280.png'),
      fullPage: false
    })

    // 复原，避免影响后续用例/持久化
    await sessionDir.fill('')
    await page.click('[data-testid="settings-save"]')
    await page.waitForTimeout(200)
  })

  it('pi 路径非法时自检失败信息不撑破布局（1920 宽）', async () => {
    await setContentSize(1920, 1080)
    await openSettings()

    await page.locator('[data-testid="settings-pi-command"]').fill('/nonexistent/pi-binary-path')
    await page.click('[data-testid="settings-pi-check"]')
    await page.waitForTimeout(500)

    const report = await measure()
    expect(report.docScrollWidth).toBeLessThanOrEqual(report.docClientWidth + 1)
    await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.settings')
      if (panel !== null) panel.scrollTop = panel.scrollHeight
    })
    await page.waitForTimeout(120)
    const afterScroll = await measure()
    expect(afterScroll.saveInPanel).toBe(true)

    await page.screenshot({
      path: join(SHOT_DIR, 'settings-after-selfcheck-fail-1920.png'),
      fullPage: false
    })
  })
})
