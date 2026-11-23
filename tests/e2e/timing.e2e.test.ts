import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A1 / A6 的**计时类**端到端断言（docs/architecture.md §10）。
 *
 * - A1：新建会话里点一次发送 → **首个流式 token ≤ 1.5s**（本地 mock provider 基准）。
 * - A6：强杀 pi 子进程 → **2s 内出现可操作入口**（「继续对话」）→ 历史完整 → 可继续对话。
 *
 * 计时口径（为什么这样测）：
 * - 用**页面内** `performance.now()` + `MutationObserver` 起止，避免 CDP 往返与轮询间隔污染；
 *   起点是「点击发送」时页面里的时间戳，终点是目标 DOM 节点出现的那一帧。
 * - A1 的计时**不含** pi 进程冷启动：本架构里「新建任务」就已经 `session:create` 拉起子进程，
 *   点发送只走 `session:prompt` 热路径（这才是 A1 描述的场景：1 次点击发出首条消息）。
 * - 抖动系数：默认阈值就是文档值（1500ms / 2000ms）。CI 上若需要放宽，用
 *   `PI_DESKTOP_TIMING_FACTOR=1.5` 显式放大并在报告里注明——**不默认放宽**。
 *
 * 前置：先 `npm run build`（本用例启动 out/ 产物，与 app.e2e.test.ts 一致）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 文档阈值（§10 A1 / A6），**不因 CI 自动放宽** */
const FIRST_TOKEN_BUDGET_MS = 1500
const RECONNECT_BUDGET_MS = 2000

/** 只允许显式放大（>1），不允许用来缩小阈值 */
const TIMING_FACTOR = (() => {
  const raw = Number(process.env['PI_DESKTOP_TIMING_FACTOR'] ?? '1')
  return Number.isFinite(raw) && raw > 1 ? raw : 1
})()

const FIRST_TOKEN_LIMIT_MS = Math.round(FIRST_TOKEN_BUDGET_MS * TIMING_FACTOR)
const RECONNECT_LIMIT_MS = Math.round(RECONNECT_BUDGET_MS * TIMING_FACTOR)

const STREAMING_SELECTOR = '[data-testid="timeline-streaming"]'
const CONTINUE_SELECTOR = '[data-testid="continue-conversation"]'

interface Harness {
  app: ElectronApplication
  page: Page
  tempRoot: string
  workDir: string
}

/**
 * 启动一个独立的 Electron 实例（独立 userData / 会话目录 / mock-pi 包装）。
 *
 * `prepareEnv` 拿得到临时目录，用来放本用例专属的文件（如 A6 的 pid 文件）。
 */
async function launch(
  prepareEnv?: (ctx: { tempRoot: string; sessionDir: string }) => Record<string, string>
): Promise<Harness> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-timing-'))
  const workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  // mock 的会话文件落在会话根的 `--work--` 分组下（与 app.e2e.test.ts 同口径）
  await mkdir(join(sessionDir, '--work--'), { recursive: true })

  // .cmd 包装：走 §7 约束 11 的 cmd.exe 分支（与真实 Windows pi.cmd 同路径）
  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_SESSION_FILE: join(sessionDir, '--work--', 'mock-session.jsonl'),
      ...(prepareEnv === undefined ? {} : prepareEnv({ tempRoot, sessionDir }))
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 30_000 })

  // 原生目录对话框无法自动化：在主进程内替换（不改产品代码）
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)

  return { app, page, tempRoot, workDir }
}

async function close(harness: Harness | undefined): Promise<void> {
  await harness?.app.close().catch(() => undefined)
  if (harness !== undefined) {
    await rm(harness.tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 新建任务（目录对话框已被 stub）并等输入区可用 */
async function createTask(harness: Harness): Promise<void> {
  const { page } = harness
  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await page.click('[data-testid="new-task-pick-directory"]')
  await expect
    .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
    .toBe(harness.workDir)
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })
  await expect
    .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 20_000 })
    .toBe('空闲')
}

/**
 * 测量「执行 action 后目标 selector 首次出现在 DOM」的耗时（毫秒）。
 *
 * 计时在**页面内**用 `performance.now()`：观察者在点击同一帧装好，概率上不会漏掉首个
 * 流式分片（分片至少要经过一次 IPC + 渲染，远晚于一帧）。
 */
async function measureAppear(
  page: Page,
  selector: string,
  action: () => void | Promise<void>,
  timeoutMs: number
): Promise<number> {
  const measurement = page.evaluate(
    ({ target, timeout }) =>
      new Promise<number>((resolveMeasurement, rejectMeasurement) => {
        const startedAt = performance.now()
        const found = (): boolean => document.querySelector(target) !== null
        if (found()) {
          resolveMeasurement(0)
          return
        }
        const observer: MutationObserver = new MutationObserver(() => {
          if (!found()) return
          observer.disconnect()
          clearTimeout(timer)
          resolveMeasurement(performance.now() - startedAt)
        })
        const timer = setTimeout(() => {
          observer.disconnect()
          rejectMeasurement(new Error(`等待 ${target} 超时（${String(timeout)}ms）`))
        }, timeout)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }),
    { target: selector, timeout: timeoutMs }
  )

  await action()
  return await measurement
}

/** 清掉当前所有横幅（强杀会产生「进程退出」诊断条，不清会干扰后续断言） */
async function dismissBanners(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = await page.locator('.banner__close').count()
    if (remaining === 0) return
    await page.locator('.banner__close').first().click()
    await expect
      .poll(async () => page.locator('.banner__close').count(), { timeout: 5_000 })
      .toBeLessThan(remaining)
  }
}

/* ------------------------------------------------------------------ A1 */

describe('A1 首 token ≤ 1.5s（本地 mock provider 基准）', () => {
  let harness: Harness | undefined

  beforeAll(async () => {
    harness = await launch(() => ({
      // mock provider 的「首字延迟」（模拟本地模型的 TTFT）：60ms 一个分片
      MOCK_PI_DELAY_MS: '60',
      MOCK_PI_REPLY: '好的 已经 开始 执行 请 稍候 马上 就 有 结果'
    }))
  }, 120_000)

  afterAll(async () => {
    await close(harness)
  })

  it('新建会话点一次发送，首个流式 token ≤ 1500ms（3 次采样，逐次断言 + 中位数）', async () => {
    if (harness === undefined) throw new Error('harness 未初始化')
    const { page } = harness
    const samples: number[] = []

    // 3 个全新会话（并行上限正好 3，不会触发第 4 个的挂起态）
    for (let round = 1; round <= 3; round += 1) {
      await createTask(harness)
      await page.fill('.composer__input', `首 token 计时 第 ${String(round)} 轮`)

      // measureAppear 先装观察者，再点发送 → 起点就是点击那一刻
      const elapsed = await measureAppear(
        page,
        STREAMING_SELECTOR,
        async () => {
          await page.click('[data-testid="send-button"]')
        },
        FIRST_TOKEN_LIMIT_MS * 4
      )
      samples.push(Math.round(elapsed))
      console.log(
        `[A1] 第 ${String(round)} 轮：首 token ${String(Math.round(elapsed))}ms（阈值 ${String(FIRST_TOKEN_LIMIT_MS)}ms）`
      )

      // 逐次断言：中位数会掩盖偶发的慢轮次
      expect(
        elapsed,
        `第 ${String(round)} 轮首 token 超过 ${String(FIRST_TOKEN_LIMIT_MS)}ms`
      ).toBeLessThanOrEqual(FIRST_TOKEN_LIMIT_MS)

      // 等本轮真正结束，避免下一轮串流/统计互相干扰
      await expect
        .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
        .toBe('空闲')
      await expect
        .poll(async () => page.locator('[data-testid="msg-assistant"]').count(), {
          timeout: 10_000
        })
        .toBeGreaterThan(0)
    }

    const sorted = [...samples].sort((left, right) => left - right)
    const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
    console.log(
      `[A1] 采样 ${samples.join(', ')}ms；中位数 ${String(median)}ms；阈值 ${String(FIRST_TOKEN_LIMIT_MS)}ms；抖动系数 ${String(TIMING_FACTOR)}`
    )
    expect(median).toBeLessThanOrEqual(FIRST_TOKEN_LIMIT_MS)
    expect(await page.locator('.banner--error').count()).toBe(0)
  })
})

/* ------------------------------------------------------------------ A6 */

describe('A6 强杀子进程 → 2s 内可操作入口 → 历史完整 → 可继续对话', () => {
  let harness: Harness | undefined
  let pidFile = ''

  beforeAll(async () => {
    harness = await launch(({ tempRoot }) => {
      pidFile = join(tempRoot, 'mock-pi.pid')
      return {
        MOCK_PI_DELAY_MS: '20',
        MOCK_PI_REPLY: '已经 完成',
        // 夹具：mock pi 把自身 pid 落盘，测试据此真正 TerminateProcess（不是「模拟崩溃」）
        MOCK_PI_PID_FILE: pidFile
      }
    })
  }, 120_000)

  afterAll(async () => {
    await close(harness)
  })

  it('kill -9 pi 后 2s 内出现「继续对话」，重开后历史完整且能继续对话', async () => {
    if (harness === undefined) throw new Error('harness 未初始化')
    const { page } = harness

    await createTask(harness)

    // 先跑完一轮，得到「强杀前」的历史与真实会话文件
    await page.fill('.composer__input', '强杀前的一句')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')

    const userBefore = await page.locator('[data-testid="msg-user"]').count()
    const assistantBefore = await page.locator('[data-testid="msg-assistant"]').count()
    expect(userBefore).toBeGreaterThan(0)

    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(Number.isInteger(pid) && pid > 0, `mock pi 未落盘 pid（${pidFile}）`).toBe(true)
    // 前置：强杀前不该已经有「继续对话」（否则下面的计时没有意义）
    expect(await page.isVisible(CONTINUE_SELECTOR)).toBe(false)

    // 起点 = 真正 TerminateProcess 的那一刻（不是「发起探测」的时刻，避免测试脚手架耗时计入）
    const elapsed = await measureAppear(
      page,
      CONTINUE_SELECTOR,
      () => {
        process.kill(pid, 'SIGKILL')
      },
      RECONNECT_LIMIT_MS * 10
    )
    console.log(
      `[A6] 强杀 pid=${String(pid)} → 可操作入口出现 ${String(Math.round(elapsed))}ms（阈值 ${String(RECONNECT_LIMIT_MS)}ms）`
    )
    expect(elapsed).toBeLessThanOrEqual(RECONNECT_LIMIT_MS)

    // 可操作入口齐全：按钮 + 只读回放提示 + 「进程退出」横幅
    expect(await page.isVisible(CONTINUE_SELECTOR)).toBe(true)
    expect(await page.isVisible('[data-testid="resume-hint"]')).toBe(true)
    await expect
      .poll(async () => page.textContent('.banners'), { timeout: 10_000 })
      .toContain('继续对话')

    // 历史完整：强杀前的消息一条不少、内容还在
    expect(await page.locator('[data-testid="msg-user"]').count()).toBe(userBefore)
    expect(await page.locator('[data-testid="msg-assistant"]').count()).toBe(assistantBefore)
    expect(await page.textContent('[data-testid="conversation-scroll"]')).toContain('强杀前的一句')
    expect(await page.textContent('[data-testid="conversation-scroll"]')).toContain('已经 完成')

    // 清掉强杀产生的横幅，后续断言只看「恢复过程中是否新增错误」
    await dismissBanners(page)

    // 继续对话：resume 成功 → 按钮消失（重新拿到 sessionKey）
    await page.click(CONTINUE_SELECTOR)
    await expect
      .poll(async () => page.isVisible(CONTINUE_SELECTOR), { timeout: 20_000 })
      .toBe(false)
    expect(await page.locator('.banner--error').count()).toBe(0)

    // 确实是**新起**了 pi 进程（pid 变了），而不是复用死掉的那个
    await expect
      .poll(async () => Number((await readFile(pidFile, 'utf8')).trim()), { timeout: 20_000 })
      .not.toBe(pid)

    // 可继续对话：再发一条并真的收到回复
    await page.fill('.composer__input', '恢复后的新问题')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.locator('[data-testid="msg-user"]').count(), { timeout: 30_000 })
      .toBe(userBefore + 1)
    await expect
      .poll(async () => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 30_000 })
      .toBe(assistantBefore + 1)
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')
    expect(await page.locator('.banner--error').count()).toBe(0)
  })
})
