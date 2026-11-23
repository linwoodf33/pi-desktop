import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A7 方案 A（窗口化渲染）的交互语义 E2E。
 *
 * 为什么单独一个文件 + 单独一个 Electron 实例：长会话需要先跑够轮数让早期轮次**离开挂载窗口**，
 * 而 `app.e2e.test.ts` 里那台实例的会话状态是逐个用例累积的（互相依赖），塞进多轮负载会污染既有用例。
 * 单实例锁按 `--user-data-dir` 隔离，所以换一个目录就能独立跑（e2e 工程本身 `fileParallelism: false`）。
 *
 * 覆盖（§「必须保持的交互语义」）：
 * 1. 长会话滚到底部 → 最新消息可见（窗口化后仍能到最新轮）；
 * 2. 上滚后新消息到达**不强制跳回**，且「回到底部」可用；
 * 3. 发送新消息 → 自动回底；
 * 4. 跳转到离屏轮次 → 内容被挂载并可见。
 *
 * 另外断言「DOM 节点数与轮数解耦」：挂载轮数远小于总轮数（窗口化真的生效）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 需要跑够轮数：视口约 700px、估算槽位 360px → 窗口 + 缓冲约 9 轮，跑 18 轮足以让首轮离屏 */
const ROUNDS = 18

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string

/** 页面里的观测钩子（`lib/virtual-bridge.ts` 暴露，非可视） */
interface VirtualProbe {
  metrics: () => {
    mountedTurns: number
    totalTurns: number
    liveDomNodes: number
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    following: boolean
    atBottom: boolean
  }
  scrollToTurn: (index: number) => void
  scrollToBottom: () => void
}

async function metrics(): Promise<ReturnType<VirtualProbe['metrics']>> {
  return page.evaluate(() => {
    const scope = window as unknown as { __piDesktopVirtual?: VirtualProbe }
    const probe = scope.__piDesktopVirtual
    if (probe === undefined) throw new Error('缺少 window.__piDesktopVirtual')
    return probe.metrics()
  })
}

async function scrollToTurn(index: number): Promise<void> {
  await page.evaluate((target) => {
    const scope = window as unknown as { __piDesktopVirtual?: VirtualProbe }
    scope.__piDesktopVirtual?.scrollToTurn(target)
  }, index)
}

async function waitIdle(): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-state"]')?.textContent === '空闲',
    undefined,
    { timeout: 60_000 }
  )
}

/** 直接滚到底部并等待状态生效 */
async function scrollToBottomAndWait(): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="conversation-scroll"]')
    if (container instanceof HTMLElement) container.scrollTop = container.scrollHeight
  })
  await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(true)
}

/** 发一轮消息并等到 settled */
async function sendRound(text: string): Promise<void> {
  await page.fill('.composer__input', text)
  await page.click('[data-testid="send-button"]')
  await waitIdle()
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-virtual-'))
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      // 每轮 ~800ms（20ms/增量）：既够撑出真实高度，也留出「流式中上滚」的时间窗
      MOCK_PI_DELAY_MS: '20',
      MOCK_PI_REPLY:
        '这是 一段 比较 长 的 回复 用于 撑出 真实 高度 第一 行 内容 继续 补充 一些 文字 让 它 换 行 第二 行 内容 再 补 一点 收尾 结束',
      MOCK_PI_TOOL: '1',
      MOCK_PI_SESSION_FILE: join(sessionDir, '--work--', 'mock-session.jsonl')
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)

  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 30_000 })
  await page.click('[data-testid="new-task-pick-directory"]')
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[data-testid="new-task-cwd"]')?.value === expected,
    workDir,
    { timeout: 30_000 }
  )
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
  await waitIdle()

  for (let round = 1; round <= ROUNDS; round += 1) {
    await sendRound(`第 ${round} 轮：请重放一次长回复`)
  }
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('A7 方案 A：窗口化渲染的交互语义', () => {
  it('长会话：DOM 只挂载窗口内的轮次（与总轮数解耦），且可见最新消息', async () => {
    const snapshot = await metrics()
    expect(snapshot.totalTurns).toBeGreaterThanOrEqual(ROUNDS)
    // 窗口化生效：挂载轮数远小于总轮数（视口 + 前 2 / 后 4 缓冲）
    expect(snapshot.mountedTurns).toBeLessThan(snapshot.totalTurns)
    expect(snapshot.mountedTurns).toBeLessThanOrEqual(12)
    // 停在底部：最新一轮（用户消息 + 助手回复）可见
    expect(snapshot.atBottom).toBe(true)
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 10_000
      })
      .toContain(`第 ${ROUNDS} 轮`)
    // 早期轮次已离屏（DOM 里没有）
    expect(await page.locator('[data-testid="timeline-turn"]').count()).toBeLessThan(ROUNDS)
  })

  it('跳转到离屏轮次：内容被挂载并滚动到可见位置', async () => {
    // 第 0 轮早就离屏了
    expect(await page.textContent('[data-testid="conversation-scroll"]')).not.toContain('第 1 轮：')

    await scrollToTurn(0)
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 10_000
      })
      .toContain('第 1 轮：')

    const firstTurn = page.locator('[data-testid="timeline-turn"]').first()
    expect(await firstTurn.textContent()).toContain('第 1 轮')
    // 滚动位置确实到了顶部（不再跟随底部）
    const snapshot = await metrics()
    expect(snapshot.atBottom).toBe(false)
    expect(snapshot.scrollTop).toBeLessThan(200)
  })

  it('流式中上滚：后续内容到达不强制跳回底部，「回到底部」可用', async () => {
    await scrollToBottomAndWait()

    await page.fill('.composer__input', '上滚验证：请重放一次长回复')
    await page.click('[data-testid="send-button"]')

    // 流式还在进行时立刻上滚到历史区（模拟用户翻看旧消息）
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="conversation-scroll"]')
      if (container instanceof HTMLElement) container.scrollTop = 0
    })
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(false)
    // 这一轮还没结束：断言后面确实还会有内容到达（否则本用例没验证到「流式不跳回」）
    expect(await page.textContent('[data-testid="composer-state"]')).not.toBe('空闲')

    // 等这一轮的所有增量到达并 settled
    await waitIdle()
    const after = await metrics()
    expect(after.atBottom).toBe(false)
    expect(after.scrollTop).toBeLessThan(200)

    // 用户上滚 → 「回到底部」出现，且不会自动消失（不强制跳回）
    await page.waitForSelector('[data-testid="scroll-to-bottom"]', { timeout: 10_000 })
    await expect
      .poll(async () => page.isVisible('[data-testid="scroll-to-bottom"]'), { timeout: 5_000 })
      .toBe(true)

    // 点「回到底部」→ 回到最新消息，按钮消失
    await page.click('[data-testid="scroll-to-bottom"]')
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(true)
    await expect
      .poll(async () => page.isVisible('[data-testid="scroll-to-bottom"]'), { timeout: 10_000 })
      .toBe(false)
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 10_000
      })
      .toContain('上滚验证')
  })

  it('发送新消息：强制回到底部（即使之前在历史区域）', async () => {
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="conversation-scroll"]')
      if (container instanceof HTMLElement) container.scrollTop = 0
    })
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(false)

    await sendRound('发送新消息应当自动回底')
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(true)
    await expect
      .poll(async () => page.isVisible('[data-testid="scroll-to-bottom"]'), { timeout: 10_000 })
      .toBe(false)
    expect(await page.textContent('[data-testid="conversation-scroll"]')).toContain(
      '发送新消息应当自动回底'
    )
    expect(await page.locator('.banner--error').count()).toBe(0)
  })

  it('滚动到历史中段后保持稳定（测量修正不得让视口跳动）', async () => {
    await scrollToBottomAndWait()
    // 滚到历史中段（首访：这些轮次的高度还没测过）
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="conversation-scroll"]')
      if (container instanceof HTMLElement) container.scrollTop = container.scrollHeight / 2
    })
    // 等测量修正落定
    await page.waitForTimeout(600)
    const settled = (await metrics()).scrollTop
    expect(settled).toBeGreaterThan(0)
    // 静止期内不应再自发跳动（锚点补偿把估算误差修正完就该稳定）
    await page.waitForTimeout(600)
    const later = (await metrics()).scrollTop
    expect(Math.abs(later - settled)).toBeLessThan(40)
    // 仍是「不跟随底部」状态
    expect((await metrics()).atBottom).toBe(false)
    await page.waitForSelector('[data-testid="scroll-to-bottom"]', { timeout: 10_000 })
  })

  it('会话切换：滚动位置回到最新消息、高度缓存互不串台', async () => {
    const big = await metrics()
    expect(big.totalTurns).toBeGreaterThan(ROUNDS)
    const bigTaskId = await page.getAttribute('.task-item--active', 'data-task-id')
    expect(bigTaskId).toBeTruthy()

    // 新建第二个任务（短会话）
    await page.click('[data-testid="new-task-button"]')
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    await page.click('[data-testid="new-task-pick-directory"]')
    await page.waitForFunction(
      (expected) =>
        document.querySelector<HTMLInputElement>('[data-testid="new-task-cwd"]')?.value ===
        expected,
      workDir,
      { timeout: 20_000 }
    )
    await page.click('[data-testid="new-task-submit"]')
    await page.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })
    await waitIdle()
    await sendRound('第二个任务：请重放一次长回复')
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 10_000 }).toBe(true)

    const items = page.locator('[data-testid="task-item"]')
    expect(await items.count()).toBeGreaterThanOrEqual(2)
    // 列表按最近更新倒序，且两个会话的标题可能相同：用 data-task-id 精确定位
    const bigItem = page.locator(`[data-testid="task-item"][data-task-id="${bigTaskId ?? ''}"]`)
    const shortItem = page.locator(
      `[data-testid="task-item"]:not([data-task-id="${bigTaskId ?? ''}"])`
    )

    // 切走再切回长会话：挂载窗口重建、滚动位置回到最新消息（不回落到历史区）
    await bigItem.first().click()
    await expect
      .poll(async () => (await metrics()).totalTurns, { timeout: 15_000 })
      .toBe(big.totalTurns)
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 15_000 }).toBe(true)
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 15_000
      })
      .toContain(`第 ${ROUNDS} 轮`)

    // 切到短会话：轮数变少（高度缓存按会话隔离，不会串台）
    await shortItem.first().click()
    await expect
      .poll(async () => (await metrics()).totalTurns, { timeout: 15_000 })
      .toBeLessThan(big.totalTurns)
    await expect.poll(async () => (await metrics()).atBottom, { timeout: 15_000 }).toBe(true)
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 15_000
      })
      .toContain('第二个任务')
    expect(await page.locator('.banner--error').count()).toBe(0)
  })
})
