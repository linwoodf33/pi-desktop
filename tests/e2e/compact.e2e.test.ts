import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A41：Composer 的「压缩上下文」按钮（pi `compact`）。
 *
 * 独立实例 + 独立临时目录：压缩会真的调 pi（mock）并刷新会话统计。
 *
 * 覆盖四个可见行为 + 一条失败路径：
 * 1. 无消息时禁用，title 说明原因（A33：不静默禁用）；
 * 2. 发过消息且回 idle 后可用；
 * 3. 点击 → 出现「压缩中…」→ info 条含「上下文已压缩：」与「→」（token 数值）；
 * 4. streaming 中禁用（F6：压缩与对话互斥）；
 * 5. `MOCK_PI_COMPACT_FAIL=1` → error 条含 mock 的错误文案。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string

/** 建任务（目录对话框已 stub 到 workDir） */
async function createTask(target: Page, dir: string): Promise<void> {
  await target.click('[data-testid="new-task-button"]')
  await target.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await target.click('[data-testid="new-task-pick-directory"]')
  await expect
    .poll(async () => target.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
    .toBe(dir)
  await target.click('[data-testid="new-task-submit"]')
  await target.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
}

const bannerText = async (target: Page): Promise<string> =>
  target.evaluate(() => document.querySelector('[data-testid="error-banner"]')?.textContent ?? '')

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-compact-'))
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(join(sessionDir, '--work--'), { recursive: true })
  await mkdir(workDir, { recursive: true })

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_SESSION_FILE: join(sessionDir, '--work--', 'live-session.jsonl'),
      // 一轮要够慢，才有稳定的「运行中」窗口验证按钮禁用
      MOCK_PI_DELAY_MS: '150',
      MOCK_PI_REPLY:
        '第一段 第二段 第三段 第四段 第五段 第六段 第七段 第八段 第九段 第十段 第十一段 第十二段 收尾'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
}, 180_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('A41：压缩上下文按钮', () => {
  it('无消息时禁用，title 说明「还没有消息」', async () => {
    await createTask(page, workDir)

    const button = page.locator('[data-testid="compact-button"]')
    await expect.poll(async () => button.count(), { timeout: 20_000 }).toBe(1)
    expect(await button.isDisabled()).toBe(true)
    expect((await button.textContent()) ?? '').toBe('压缩上下文')
    expect((await button.getAttribute('title')) ?? '').toContain('还没有消息')
  }, 120_000)

  it('发一条消息并回 idle 后按钮可用', async () => {
    await page.fill('.composer__input', '先聊一句')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
      .toBe('空闲')

    const button = page.locator('[data-testid="compact-button"]')
    await expect.poll(async () => button.isDisabled(), { timeout: 30_000 }).toBe(false)
    expect((await button.getAttribute('title')) ?? '').toContain('把较早的对话总结成摘要')
  }, 120_000)

  it('点击 → 出现「压缩中…」→ info 条含「上下文已压缩：」与「→」', async () => {
    // 压缩很快（mock 同步回放）：用 MutationObserver 抓瞬时文案，避免 poll 漏帧
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="compact-button"]')
      const texts: string[] = []
      ;(window as unknown as { __compactTexts?: string[] }).__compactTexts = texts
      if (button === null) return
      const record = (): void => {
        const text = button.textContent ?? ''
        if (texts[texts.length - 1] !== text) texts.push(text)
      }
      record()
      const observer = new MutationObserver(record)
      observer.observe(button, { childList: true, characterData: true, subtree: true })
    })

    await page.click('[data-testid="compact-button"]')

    await expect.poll(async () => bannerText(page), { timeout: 30_000 }).toContain('上下文已压缩：')
    const banner = await bannerText(page)
    expect(banner).toContain('→')
    // mock 固定回 120000 → 20000，formatTokens 为 120.0k / 20.0k
    expect(banner).toContain('120.0k')

    const texts = await page.evaluate(
      () => (window as unknown as { __compactTexts?: string[] }).__compactTexts ?? []
    )
    expect(texts).toContain('压缩中…')
    await expect
      .poll(async () => page.textContent('[data-testid="compact-button"]'), { timeout: 30_000 })
      .toBe('压缩上下文')
    // info 级（不是红色失败条）
    expect(await page.locator('.banner--info').count()).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('streaming 中按钮禁用，title 说明「本轮正在运行」', async () => {
    await page.fill('.composer__input', '再跑一轮慢的')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .not.toBe('空闲')

    const button = page.locator('[data-testid="compact-button"]')
    expect(await button.isDisabled()).toBe(true)
    expect((await button.getAttribute('title')) ?? '').toContain('本轮正在运行')

    // 收尾，避免 afterAll 在流式中关进程
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
      .toBe('空闲')
  }, 120_000)
})

describe('A41：压缩失败（MOCK_PI_COMPACT_FAIL=1）', () => {
  it('error 条含 mock 的错误文案，按钮复位可用', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-compact-fail-'))
    const workDir2 = join(root2, 'workspace')
    const sessionDir2 = join(root2, 'sessions')
    await mkdir(join(sessionDir2, '--work--'), { recursive: true })
    await mkdir(workDir2, { recursive: true })
    const wrapper2 = join(root2, 'mock-pi.cmd')
    await writeFile(wrapper2, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

    const app2 = await electron.launch({
      args: ['.', `--user-data-dir=${join(root2, 'userdata')}`],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PI_DESKTOP_PI_COMMAND: wrapper2,
        PI_CODING_AGENT_SESSION_DIR: sessionDir2,
        MOCK_PI_SESSION_FILE: join(sessionDir2, '--work--', 'fail-session.jsonl'),
        MOCK_PI_DELAY_MS: '20',
        MOCK_PI_REPLY: '好的',
        MOCK_PI_COMPACT_FAIL: '1'
      }
    })
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
      await app2.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
      }, workDir2)

      await createTask(page2, workDir2)
      await page2.fill('.composer__input', '先聊一句')
      await page2.click('[data-testid="send-button"]')
      await expect
        .poll(async () => page2.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
        .toBe('空闲')

      await page2.click('[data-testid="compact-button"]')

      await expect
        .poll(async () => bannerText(page2), { timeout: 30_000 })
        .toContain('mock compact failed')
      // 失败是 error 级（带错误码），不是静默失败
      expect(await page2.locator('.banner--error').count()).toBeGreaterThanOrEqual(1)
      await expect
        .poll(async () => page2.textContent('[data-testid="compact-button"]'), { timeout: 30_000 })
        .toBe('压缩上下文')
    } finally {
      await app2.close().catch(() => {})
      await rm(root2, { recursive: true, force: true }).catch(() => {})
    }
  }, 180_000)
})
