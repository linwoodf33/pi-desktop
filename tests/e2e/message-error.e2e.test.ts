import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * E2E（§5.4）：模型连续失败时只出现**一个**可懂的错误气泡。
 *
 * 前置与 `tests/e2e/app.e2e.test.ts` 的 E3 块一致（**独立** Electron 实例 + `--user-data-dir`
 * 隔离，避免与主实例的单实例锁/会话状态互相干扰）：
 * - 启动 `out/main/index.js`（需先 `npm run build`）；
 * - pi 用 `tests/integration/fixtures/mock-pi.mjs` 顶替（`.cmd` 包装，走 cmd.exe 分支）；
 * - `MOCK_PI_ERROR_MODE=1` 让 mock 只发失败尝试（无 text delta、无成功回复）；
 * - 目录选择是原生对话框，用 `app.evaluate` 在主进程内替换 `dialog.showOpenDialog`（不改产品代码）。
 *
 * 硬断言对应决策 4：失败只进时间线，**不联动**全局错误条。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const ERROR_TEXT = 'Request timed out.: Connect Timeout Error (mock)'

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-msg-error-'))
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  // mock 的会话文件落在会话根内的分组目录下（session:history 的路径校验要求父目录真实存在）
  await mkdir(join(sessionDir, '--work--'), { recursive: true })

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      // 3 次尝试 × 160ms：时间戳互不相同 → 不会被 reducer 的去重键幂等吞并
      MOCK_PI_DELAY_MS: '40',
      MOCK_PI_ERROR_MODE: '1',
      MOCK_PI_ERROR_ATTEMPTS: '3',
      MOCK_PI_ERROR_TEXT: ERROR_TEXT,
      MOCK_PI_SESSION_FILE: join(sessionDir, '--work--', 'mock-error-session.jsonl')
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 30_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
}, 120_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('M6 模型连接失败：连续失败折叠成一个错误气泡', () => {
  it('3 次连续失败 → 1 个错误气泡 + 可懂标题 + 可展开详情；无空气泡、无全局错误条、仍可发送', async () => {
    // 新建任务（目录对话框已 stub 到 workDir）
    await page.click('[data-testid="new-task-button"]')
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    await page.click('[data-testid="new-task-pick-directory"]')
    await expect
      .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir)
    await page.click('[data-testid="new-task-submit"]')
    await page.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })

    await page.fill('.composer__input', '你好')
    await page.click('[data-testid="send-button"]')

    await page.waitForSelector('[data-testid="msg-error"]', { timeout: 30_000 })
    // 等本轮收尾（agent_settled → idle）再数气泡，避开中间态
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')

    // ① 恰好 1 个错误气泡（不是 3、不是 4）：连续纯失败在展示层折叠
    const bubbles = page.locator('[data-testid="msg-error"]')
    expect(await bubbles.count()).toBe(1)
    expect(await bubbles.first().getAttribute('data-error-count')).toBe('3')

    // ② 标题可懂（不是原始堆栈）
    expect(await page.textContent('[data-testid="msg-error-title"]')).toBe('模型请求超时')

    // ③ 次数文案：连续 3 次 + pi 已自动重试 2 次
    const retry = (await page.textContent('[data-testid="msg-error-retry"]')) ?? ''
    expect(retry).toContain('连续 3 次')
    expect(retry).toContain('重试 2 次')

    // ④ 技术详情默认折叠，展开后能看到 pi 的原始 errorMessage
    await page.click('[data-testid="msg-error-detail"] summary')
    const detail = (await page.textContent('[data-testid="msg-error-detail"] pre')) ?? ''
    expect(detail).toContain('Connect Timeout Error')

    // ⑤ 无空气泡：失败消息全部被折叠，普通助手气泡数为 0（且整轮没有空白气泡）
    expect(await page.locator('[data-testid="msg-assistant"]').count()).toBe(0)

    // ⑥ 决策 4：失败不联动全局错误条
    expect(await page.locator('[data-testid="error-banner"]').count()).toBe(0)
    expect(await page.locator('.banner--error').count()).toBe(0)

    // ⑦ 仍可继续发送
    await page.fill('.composer__input', '再试一次')
    expect(await page.isEnabled('[data-testid="send-button"]')).toBe(true)
  })
})
