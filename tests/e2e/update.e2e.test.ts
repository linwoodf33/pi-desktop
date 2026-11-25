import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A34：pi 更新面板 E2E（检测 → 更新 → 版本确实变了 / 更新失败）。
 *
 * 独立性（三件必须做的事，缺一件就会污染开发机或别的用例）：
 * 1. `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--user-data-dir` 全部指到
 *    本文件自己的临时目录 —— 绝不碰 `~/.pi/agent`；
 * 2. `PI_DESKTOP_PI_COMMAND` 指向一个临时 `.cmd`（`node mock-pi.mjs %*`），
 *    `MOCK_PI_VERSION_FILE` 承载「当前版本」，这样 `pi update` 之后 `pi --version`
 *    真的会变 —— 「更新成功」是可观测的事实，而不是测试自己假装；
 * 3. 更新源用 `PI_DESKTOP_UPDATE_CHECK_URL` 指到本地 `node:http` 服务
 *    （`isAllowedCheckUrl` 只对 `https` 或 127.0.0.1/localhost 的 http 放行，
 *    且必须显式给了这个 env 才允许本机 http）。
 *
 * 状态隔离：`MOCK_PI_UPDATE_MODE=fail` 的那组用例单独起一个 Electron 实例、单独一份
 * 临时目录。顶层 `beforeAll` 只起一个只读的 http 服务器（无状态），两组 app 各用自己的
 * beforeAll/afterAll —— 绝不让「已经更新到 1.6.0 的 app」被 fail 用例复用。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 临时 pi 的「当前版本」与回放的「最新版」；两者必须和 `MOCK_PI_UPDATE_TO` 对得上 */
const CURRENT = '1.5.2'
const LATEST = '1.6.0'

let server: Server
let checkUrl: string

/**
 * 读文本时必须容忍「元素还没渲染」：面板是按状态条件渲染的（例如 `update-result`
 * 在拿到 apply 结果前根本不存在），直接 `textContent` 会抛「element not found」，
 * 在 `expect.poll` 里就变成一次硬失败而不是重试。
 */
async function textOf(target: Page, selector: string): Promise<string> {
  const locator = target.locator(selector).first()
  if ((await locator.count()) === 0) return ''
  return (await locator.textContent()) ?? ''
}

interface LaunchedApp {
  app: ElectronApplication
  page: Page
  tempRoot: string
  versionFile: string
}

/**
 * 起一个完全隔离的实例。两条用例组各自调用一次。
 */
async function launchApp(tag: string, extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  const tempRoot = await mkdtemp(join(tmpdir(), `pi-desktop-e2e-update-${tag}-`))
  const agentDir = join(tempRoot, 'agent')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  // 「本机安装的 pi 版本」的唯一真相：`pi update` 会改写它，`pi --version` 会读它
  const versionFile = join(tempRoot, 'mock-pi-version.txt')
  await writeFile(versionFile, CURRENT, 'utf8')

  // Windows 友好：pi 是个 `.cmd` 入口，内部把参数原样转给 mock-pi.mjs
  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_VERSION_FILE: versionFile,
      MOCK_PI_UPDATE_TO: LATEST,
      // 只对「本机 http + 显式 env 覆盖」放行（见 services/pi-update.ts#isAllowedCheckUrl）
      PI_DESKTOP_UPDATE_CHECK_URL: checkUrl,
      ...extraEnv
    }
  })
  const page = await app.firstWindow()
  // 启动即有一次 pi 自检；等到徽标出现，才保证 `piLocator.launch()` 已就绪（apply 的 gate 依赖它）
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  return { app, page, tempRoot, versionFile }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/latest-version') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          version: LATEST,
          packageName: '@earendil-works/pi-coding-agent'
        })
      )
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })

  // `listen(0)` 由系统分配空闲端口：并行/重复跑时不会撞端口
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('本地更新源没能拿到端口')
  }
  checkUrl = `http://127.0.0.1:${String(address.port)}/latest-version`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) rejectClose(error)
      else resolveClose()
    })
  })
})

describe('A34：更新面板 —— 检测到新版并真的更新到 1.6.0', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let versionFile: string

  beforeAll(async () => {
    // 第一组必须显式声明 available：不传的话 mock 默认 in-sync（只打印已是最新、不改版本）
    const launched = await launchApp('available', { MOCK_PI_UPDATE_MODE: 'available' })
    app = launched.app
    page = launched.page
    tempRoot = launched.tempRoot
    versionFile = launched.versionFile
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('E34-1 打开面板：明确警告会真正执行 pi update，未检测时不冒充结论', async () => {
    await page.click('[data-testid="open-update"]')
    await page.waitForSelector('[data-testid="update-panel"]', { timeout: 20_000 })

    // 警告文案是组件里写死的原文（不是测试文案）：用户必须事先知道「更新」会改本机安装
    const panelText = await textOf(page, '[data-testid="update-panel"]')
    expect(panelText).toContain('真正执行')
    expect(panelText).toContain('不只是检查')

    // 未点「检查更新」前面板只有本地初值：最新版本/检测时间/来源/结论全是「尚未检查」，
    // 当前版本是「未知」（组件 `check?.currentVersion ?? '未知'`，不会凭空报版本号）
    expect(await textOf(page, '[data-testid="update-latest-version"]')).toBe('尚未检查')
    expect(await textOf(page, '[data-testid="update-checked-at"]')).toBe('尚未检查')
    expect(await textOf(page, '[data-testid="update-source"]')).toBe('尚未检查')
    expect(await textOf(page, '[data-testid="update-state"]')).toBe('尚未检查')
    expect(await textOf(page, '[data-testid="update-current-version"]')).toBe('未知')
  }, 120_000)

  it('E34-2 点「检查更新」：最新版本 1.6.0、来源刚刚查询、时间可读、结论有新版', async () => {
    await page.click('[data-testid="update-check-button"]')

    // 这次点击要走一次本地 HTTP 往返 + 一次 `pi --version`，结果异步到达；
    // 「点完就读」必然读到旧的「尚未检查」，所以必须 poll 到结论落定。
    // 五个字段来自同一个 setCheck（一次原子更新），因此只需等 update-state。
    await expect
      .poll(async () => textOf(page, '[data-testid="update-state"]'), { timeout: 60_000 })
      .toContain('有新版')

    expect(await textOf(page, '[data-testid="update-latest-version"]')).toContain(LATEST)
    // sourceLabel：`pi.dev` → 「刚刚查询」（不是「上次缓存」——缓存只在本次检测失败时才读）
    expect(await textOf(page, '[data-testid="update-source"]')).toContain('刚刚')
    // formatCheckedAt：zh-CN 本地时间，形如 `2026/11/25 11:20:31`
    expect(await textOf(page, '[data-testid="update-checked-at"]')).toMatch(
      /^\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}/
    )
    // 当前版本来自真实的 `pi --version`（此时 mock 版本文件还是 1.5.2）
    expect(await textOf(page, '[data-testid="update-current-version"]')).toContain(CURRENT)
  }, 120_000)

  it('E34-3 顶栏按钮出现 update-dot 且文案变「有新版」', async () => {
    // 顶栏状态由 App 自己持有（挂载后延迟一次自动检测，与面板内部状态互不相通），
    // 到达时机不受本用例控制 → poll，而不是「面板已经有结论了顶栏就该立刻有」。
    await expect
      .poll(async () => page.locator('[data-testid="update-dot"]').count(), { timeout: 40_000 })
      .toBe(1)
    await expect
      .poll(async () => textOf(page, '[data-testid="open-update"]'), { timeout: 20_000 })
      .toContain('有新版')
  }, 120_000)

  it('E34-4 点「更新 pi」：日志出现版本迁移，结论与实际安装都收敛到 1.6.0', async () => {
    // apply 用「上次检测到的最新版本」当 targetVersion；本用例不依赖上一条的执行顺序，
    // 自己先检测一次（重复检测只是多一次只读请求）。
    await page.click('[data-testid="update-check-button"]')
    await expect
      .poll(async () => textOf(page, '[data-testid="update-state"]'), { timeout: 60_000 })
      .toContain('有新版')

    await page.click('[data-testid="update-apply-button"]')

    // 日志是流式事件（started/log/done），且终态前还要再复验一次 `pi --version`：
    // 任何「点完就断言」都会在子进程还没退出时失败，必须 poll 到 mock 打印的更新行。
    await expect
      .poll(async () => textOf(page, '[data-testid="update-log"]'), { timeout: 90_000 })
      .toContain(`Updated pi from ${CURRENT} to ${LATEST}`)

    // outcome === 'updated' 的结论（afterVersion === targetVersion → 「已更新到 1.6.0」）。
    // 注意：面板的 update-current-version 不会自动重查，这里只有 update-result 会变。
    await expect
      .poll(async () => textOf(page, '[data-testid="update-result"]'), { timeout: 60_000 })
      .toContain(`已更新到 ${LATEST}`)

    // 「真的装了」的独立证据：mock 把新版本写进版本文件，后续 `pi --version` 会读到它
    await expect
      .poll(
        async () => {
          const raw = await readFile(versionFile, 'utf8').catch(() => '')
          return raw.trim()
        },
        { timeout: 20_000 }
      )
      .toBe(LATEST)

    // 版本刷新走 onApplied → probeBridge（异步），且自检结果在主进程里被 apply 的
    // locate() 更新过；诊断面板读的就是那份缓存，所以打开后必须 poll 才可能看到新版本。
    await page.click('[data-testid="update-close"]')
    await expect
      .poll(async () => page.locator('[data-testid="update-panel"]').count(), { timeout: 10_000 })
      .toBe(0)
    await page.click('[data-testid="open-diagnostics"]')
    await expect
      .poll(async () => textOf(page, '[data-testid="diagnostics-piVersion"]'), { timeout: 30_000 })
      .toContain(LATEST)
  }, 180_000)
})

describe('A34：更新失败 —— pi update 非 0 退出必须如实报告', () => {
  let app: ElectronApplication
  let page: Page
  let tempRoot: string
  let versionFile: string

  beforeAll(async () => {
    // 独立实例：失败用例会把面板留在失败态，不能和「已更新成功」的实例共享
    const launched = await launchApp('fail', { MOCK_PI_UPDATE_MODE: 'fail' })
    app = launched.app
    page = launched.page
    tempRoot = launched.tempRoot
    versionFile = launched.versionFile
  }, 180_000)

  afterAll(async () => {
    await app.close()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('E34-5 更新失败：日志有输出、结论是「执行失败（退出码 1）」，版本仍为 1.5.2', async () => {
    await page.click('[data-testid="open-update"]')
    await page.waitForSelector('[data-testid="update-panel"]', { timeout: 20_000 })

    await page.click('[data-testid="update-apply-button"]')

    // 失败信息来自 stderr 的流式行 + 子进程退出码（1），两者都晚于点击：必须 poll
    await expect
      .poll(async () => (await textOf(page, '[data-testid="update-log"]')).length, {
        timeout: 90_000
      })
      .toBeGreaterThan(0)

    // 注意：outcome:'failed' 落在 update-result（update-error 只用于 accepted:false 的
    // gate 拒绝，例如 SESSION_BUSY / PI_UPDATE_UNAVAILABLE），这里按真实实现断言。
    await expect
      .poll(async () => textOf(page, '[data-testid="update-result"]'), { timeout: 60_000 })
      .toContain('执行失败')
    expect(await textOf(page, '[data-testid="update-result"]')).toContain('退出码 1')

    // 失败不该动到「本机安装」：版本文件没被改写
    expect((await readFile(versionFile, 'utf8')).trim()).toBe(CURRENT)

    // 「手动执行命令」那一块是 no-self 分支专属，失败分支不该出现
    expect(await page.locator('[data-testid="update-manual-command"]').count()).toBe(0)
  }, 180_000)
})
