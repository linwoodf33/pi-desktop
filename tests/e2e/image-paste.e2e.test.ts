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

/** 构造一个「超长边」的图片并拖入输入框（触发客户端压缩） */
async function dropLargeImage(): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('无法创建 canvas')
    const gradient = context.createLinearGradient(0, 0, 3000, 2000)
    gradient.addColorStop(0, '#112233')
    gradient.addColorStop(1, '#aabbcc')
    context.fillStyle = gradient
    context.fillRect(0, 0, 3000, 2000)
    context.fillStyle = '#ffffff'
    context.font = '120px sans-serif'
    context.fillText('screenshot', 200, 400)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (blob === null) throw new Error('toBlob 失败')
    const file = new File([blob], 'big-screenshot.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)

    const target = document.querySelector('[data-testid="composer"]')
    if (!(target instanceof HTMLElement)) throw new Error('找不到 composer')
    target.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true })
    )
    target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
    )
  })
}

describe('拖拽图片（A20）', () => {
  it('拖入超长边图片：出现缩略图、标注已压缩、实际尺寸被缩到长边上限', async () => {
    await page.waitForSelector('[data-testid="composer"]', { timeout: 20_000 })
    await dropLargeImage()

    const attachment = page.locator('[data-testid="composer-attachment"]').first()
    await attachment.waitFor({ timeout: 30_000 })

    const caption = (await attachment.locator('figcaption').textContent()) ?? ''
    expect(caption).toContain('已压缩')

    // 原图 3000×2000 → 长边压到 2000（等比 2000×1333）
    const natural = await attachment.locator('img').evaluate((node) => {
      const img = node as HTMLImageElement
      return { width: img.naturalWidth, height: img.naturalHeight }
    })
    expect(natural.width).toBe(2000)
    expect(natural.height).toBe(1333)

    // 悬停在缩略图上应能查到原图尺寸
    const title = (await attachment.locator('figcaption').getAttribute('title')) ?? ''
    expect(title).toContain('3000×2000')

    await page.click('[data-testid="composer-attachment-remove"]')
    await expect
      .poll(async () => page.locator('[data-testid="composer-attachment"]').count(), {
        timeout: 10_000
      })
      .toBe(0)
  })
})

describe('对话里的图片缩略图与查看器（A21）', () => {
  it('发送后用户消息显示缩略图，点击可看原图并可关闭', async () => {
    await page.evaluate((base64) => {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const file = new File([bytes], 'thumb.png', { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      const input = document.querySelector('.composer__input')
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('找不到输入框')
      input.focus()
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
    }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

    await page.waitForSelector('[data-testid="composer-attachment"]', { timeout: 20_000 })
    await page.click('[data-testid="send-button"]')

    // 用户消息里出现缩略图（图来自消息本身，不是输入框里的待发送缩略图）
    const thumb = page.locator('[data-testid="msg-user-image"]').first()
    await thumb.waitFor({ timeout: 30_000 })
    const src = await thumb.locator('img').getAttribute('src')
    expect(src?.startsWith('data:image/png;base64,')).toBe(true)

    // 点击 → 查看器打开
    await thumb.click()
    await page.waitForSelector('[data-testid="image-lightbox"]', { timeout: 20_000 })
    const fullSrc = await page.locator('[data-testid="image-lightbox-img"]').getAttribute('src')
    expect(fullSrc).toBe(src)

    // Esc 关闭
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => page.locator('[data-testid="image-lightbox"]').count(), { timeout: 10_000 })
      .toBe(0)
  })
})

describe('多行粘贴折叠（A28）', () => {
  it('20 行文本折叠成占位符，发送时展开为完整原文', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行 PASTEMARK`)
    const payload = lines.join(String.fromCharCode(10))

    await page.evaluate((text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      const input = document.querySelector('.composer__input')
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('找不到输入框')
      input.focus()
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
    }, payload)

    // 输入框里是占位符，不是 20 行原文
    await expect
      .poll(async () => page.inputValue('.composer__input'), { timeout: 20_000 })
      .toContain('[paste #1-20 lines]')

    await page.click('[data-testid="send-button"]')

    // 上游收到的是**展开后的完整原文**
    await expect
      .poll(
        async () => {
          const raw = await readFile(promptFile, 'utf8').catch(() => '')
          const last = raw
            .split('\n')
            .filter((line) => line.length > 0)
            .at(-1)
          if (last === undefined) return 'none'
          const record = JSON.parse(last) as { text: string }
          const ok =
            record.text.includes('第 1 行 PASTEMARK') && record.text.includes('第 20 行 PASTEMARK')
          return ok ? 'expanded' : `bad:${record.text.slice(0, 40)}`
        },
        { timeout: 30_000 }
      )
      .toBe('expanded')
  })
})
