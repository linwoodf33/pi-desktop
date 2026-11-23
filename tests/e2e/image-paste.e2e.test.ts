import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A19：把剪贴板里的截图粘进对话框。
 *
 * 真实用户路径是「截图工具 → Ctrl+V」，Playwright 无法操作系统剪贴板，
 * 因此这里**构造一个真实的 ClipboardEvent**（带 `DataTransfer` + 图片 `File`）派发到输入框，
 * 走的是与浏览器完全相同的事件路径：paste 事件 → `readClipboardImages` → 缩略图 → 发送。
 *
 * 断言两层：
 * 1. UI：出现缩略图、可移除、只有图没有文字也能发送；
 * 2. 真的发出去了：mock 把收到的 `prompt` 载荷（含图片数量与 MIME）落盘。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 1×1 透明 PNG */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let app: ElectronApplication
let page: Page
let tempRoot: string
let promptFile: string

/** 构造并派发一次「粘贴图片」事件 */
async function pasteImage(): Promise<void> {
  await page.evaluate((base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const file = new File([bytes], 'screenshot.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    const target = document.querySelector('.composer__input')
    if (!(target instanceof HTMLTextAreaElement)) throw new Error('找不到输入框')
    target.focus()
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
  }, PNG_BASE64)
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-paste-'))
  const workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  promptFile = join(tempRoot, 'prompts.jsonl')

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_PROMPT_FILE: promptFile,
      MOCK_PI_DELAY_MS: '10'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)

  // 建一个任务，输入框才可用
  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await page.click('[data-testid="new-task-pick-directory"]')
  // `expect.poll` 只能在用例内用（vitest 限制）；beforeAll 里用 waitForFunction 等价等待
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[data-testid="new-task-cwd"]')?.value === expected,
    workDir,
    { timeout: 20_000 }
  )
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
}, 180_000)

afterAll(async () => {
  await app.close()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('粘贴截图进对话框', () => {
  it('Ctrl+V 出现缩略图，且可以移除', async () => {
    await pasteImage()
    await page.waitForSelector('[data-testid="composer-attachment"]', { timeout: 20_000 })
    expect(await page.locator('[data-testid="composer-attachment"]').count()).toBe(1)

    await page.click('[data-testid="composer-attachment-remove"]')
    await expect
      .poll(async () => page.locator('[data-testid="composer-attachment"]').count(), {
        timeout: 10_000
      })
      .toBe(0)
  })

  it('只有图片、没有文字也能发送，且图片真的进了 prompt', async () => {
    await pasteImage()
    await page.waitForSelector('[data-testid="composer-attachment"]', { timeout: 20_000 })
    // 输入框为空也应可发送（截图直接问「这是什么」）
    expect(await page.isEnabled('[data-testid="send-button"]')).toBe(true)

    await page.click('[data-testid="send-button"]')

    await expect
      .poll(
        async () => {
          const raw = await readFile(promptFile, 'utf8').catch(() => '')
          const lines = raw.split('\n').filter((line) => line.length > 0)
          const last = lines.at(-1)
          if (last === undefined) return 'none'
          const record = JSON.parse(last) as { imageCount: number; mimeTypes: string[] }
          return `${record.imageCount}:${record.mimeTypes.join(',')}`
        },
        { timeout: 30_000 }
      )
      .toBe('1:image/png')

    // 发送后缩略图应清空（不会残留在下一条消息里）
    await expect
      .poll(async () => page.locator('[data-testid="composer-attachment"]').count(), {
        timeout: 10_000
      })
      .toBe(0)
  })
})
