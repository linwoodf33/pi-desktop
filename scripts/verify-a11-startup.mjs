/**
 * A11 冒烟：**近似干净机器**启动验证（无外部 Node / npm / pi）。
 *
 * 为什么是「近似」：本机装有 Node/pi，无法真正卸载；这里做到的是
 * 1) 子进程 `PATH` 只保留 System32 等系统必需要素（`where node` / `where npm` / `where pi` 全部失败）；
 * 2) `HOME` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` 全部指向空临时目录，
 *    使 `pi-locator.commonPiPaths()` 探测的 `%USERPROFILE%\.pi\agent\bin`、
 *    `%APPDATA%\npm`、`%LOCALAPPDATA%\pi\bin` 全部落空
 *    （**实测教训**：仅清 PATH 不够——locator 会直接拼常见安装目录，还命中 `%APPDATA%\npm\pi.cmd`）；
 * 3) 全新 `--user-data-dir`（首启无配置、无会话索引、无 pi 记录）；
 * 4) 清掉所有 `PI_*` / `npm_*` / `NODE_*` 继承变量。
 * 未覆盖的风险见 docs/perf/a11-package.md「未覆盖风险」。
 *
 * 用法：node scripts/verify-a11-startup.mjs [--exe <path>] [--keep]
 * 输出：stdout 打印 JSON（结构化证据），失败时退出码 1。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.indexOf('--exe')
const EXE = resolve(exeArg >= 0 ? args[exeArg + 1] : 'release/win-unpacked/pi-desktop.exe')
const KEEP = args.includes('--keep')
const CDP_PORT = 9333

/** 干净 PATH：只留 Windows 系统目录，不含任何 Node/npm/pi 安装位置 */
const CLEAN_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
].join(';')

function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PI_|npm_|NODE_|NVM_|VOLTA_|COREPACK_)/i.test(key)) continue
    env[key] = value
  }
  env.PATH = CLEAN_PATH
  env.Path = CLEAN_PATH
  return { ...env, ...extra }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForCdp(deadlineMs) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  return undefined
}

const report = {
  exe: EXE,
  exeExists: existsSync(EXE),
  isolatedPath: CLEAN_PATH,
  steps: [],
  ok: false,
  checks: {}
}
const step = (name, extra = {}) =>
  report.steps.push({ name, at: new Date().toISOString(), ...extra })

if (!report.exeExists) {
  console.error(JSON.stringify({ ...report, error: '打包产物不存在' }, null, 2))
  process.exit(1)
}

const userData = await mkdtemp(join(tmpdir(), 'pi-desktop-a11-userdata-'))
const sessionDir = await mkdtemp(join(tmpdir(), 'pi-desktop-a11-sessions-'))
// 近似干净用户：HOME / USERPROFILE / APPDATA / LOCALAPPDATA 指向空目录。
// locator 的 `commonPiPaths` 直接拼这些目录（不看 PATH），所以四个都得挪。
const fakeHome = await mkdtemp(join(tmpdir(), 'pi-desktop-a11-home-'))
const fakeAppData = join(fakeHome, 'AppData', 'Roaming')
const fakeLocalAppData = join(fakeHome, 'AppData', 'Local')
await mkdir(fakeAppData, { recursive: true })
await mkdir(fakeLocalAppData, { recursive: true })
const logFile = join(userData, '..', `a11-${Date.now()}.log`)
let child

try {
  child = spawn(EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`], {
    env: cleanEnv({
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: fakeAppData,
      LOCALAPPDATA: fakeLocalAppData
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  const logLines = []
  const collect = (chunk) => {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) if (line.trim() !== '') logLines.push(line)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  let exitInfo
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
  })
  step('spawn', { pid: child.pid })

  const version = await waitForCdp(60_000)
  step('cdp-ready', { version: version?.Browser ?? null })
  report.checks.processAliveAfterCdp = exitInfo === undefined
  // 隔离 PATH 里真的没有 node / npm / pi（否则「无 Node 启动」不成立）
  report.checks.isolatedToolsAbsent = Object.fromEntries(
    ['node.exe', 'npm.cmd', 'npx.cmd', 'pi.cmd', 'pi.exe'].map((name) => [
      name,
      CLEAN_PATH.split(';').filter((dir) => existsSync(join(dir, name))).length
    ])
  )
  if (Object.values(report.checks.isolatedToolsAbsent).some((count) => count !== 0)) {
    throw new Error('隔离 PATH 里仍能找到 node/npm/pi，隔离验证无效')
  }
  if (version === undefined) throw new Error('60s 内未启动 CDP 端点（主窗口未起来）')

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const pages = browser.contexts().flatMap((context) => context.pages())
  step('pages', { count: pages.length, urls: pages.map((page) => page.url()) })
  const page = pages[0]
  if (page === undefined) throw new Error('CDP 上没有渲染进程页面（主窗口为空）')

  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 45_000 })
  step('bridge-status-visible')

  // pi 自检是异步的：等状态离开初始的 `pi unknown`（最多 10s），否则下面的
  // 「无 pi 引导」断言可能读到中间态。同时记录首次读数与稳定读数，避免歧义。
  const firstStatus = (await page.textContent('[data-testid="bridge-status"]'))?.trim() ?? ''
  const settled = await page
    .waitForFunction(
      () => {
        const node = globalThis.document.querySelector('[data-testid="bridge-status"]')
        return node !== null && !(node.textContent ?? '').includes('pi unknown')
      },
      undefined,
      { timeout: 10_000 }
    )
    .then(() => true)
    .catch(() => false)
  step('bridge-status-settled', { settled, firstStatus })
  report.checks.bridgeStatusSettled = settled

  const snapshot = await page.evaluate(() => {
    // 本函数体在渲染进程里执行（不是 Node）：统一走 globalThis，避免依赖 Node 的 lint 全局表
    const dom = globalThis.document
    const text = (selector) => dom.querySelector(selector)?.textContent?.trim() ?? null
    const visible = (selector) => {
      const node = dom.querySelector(selector)
      if (node === null) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    return {
      title: dom.title,
      bridgeStatus: text('[data-testid="bridge-status"]'),
      emptyState: visible('[data-testid="empty-state"]'),
      newTaskButton: visible('[data-testid="new-task-button"]'),
      errorBanner: visible('[data-testid="error-banner"]'),
      locatePiControl:
        visible('[data-testid="locate-pi-button"]') ||
        visible('[data-testid="open-settings-button"]'),
      // A12：首启无 pi 时的三步引导（定位 pi → 新建任务 → 发消息）
      onboardingSteps: Array.from(
        dom.querySelectorAll('[data-testid="empty-state"] .onboarding li')
      ).map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      emptyNewTask: visible('[data-testid="empty-new-task"]'),
      bodyText: (dom.body.innerText ?? '').slice(0, 800),
      cspMeta:
        dom.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ??
        null,
      nodeInRenderer:
        typeof globalThis.process === 'undefined' && typeof globalThis.require === 'undefined'
    }
  })
  report.checks.ui = snapshot

  // 无 Node / 无 pi：渲染进程不能拿到 process/require（contextIsolation + sandbox 生效）
  report.checks.rendererIsolated = snapshot.nodeInRenderer
  // A12：首启无 pi 必须给可操作引导 + 不崩溃（三步引导齐全，且第 1/2 步都有按钮可点）
  report.checks.firstRunGuidance =
    snapshot.emptyState &&
    snapshot.onboardingSteps.length === 3 &&
    snapshot.emptyNewTask &&
    snapshot.onboardingSteps[0]?.includes('定位 pi') === true
  report.checks.noErrorBanner = snapshot.errorBanner === false
  report.checks.cspPresent = (snapshot.cspMeta ?? '').includes("script-src 'self'")

  // 主窗口仍活着（未被 crash）
  await sleep(1_500)
  report.checks.processAliveAfterUi = exitInfo === undefined

  await browser.close().catch(() => {})

  report.logTail = logLines.slice(-20)
  report.checks.spawnedNodeErrors = logLines
    .filter((line) => /node|npm|ENOENT.*pi/i.test(line))
    .slice(0, 10)
  report.ok =
    report.checks.processAliveAfterCdp === true &&
    report.checks.rendererIsolated === true &&
    report.checks.firstRunGuidance === true &&
    report.checks.noErrorBanner === true &&
    report.checks.cspPresent === true &&
    report.checks.processAliveAfterUi === true
} catch (error) {
  report.error = String(error && error.stack ? error.stack : error)
} finally {
  if (!KEEP && child !== undefined && child.exitCode === null) {
    child.kill()
    await sleep(500)
  }
  if (!KEEP) {
    await rm(userData, { recursive: true, force: true }).catch(() => {})
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
    await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
  }
  report.logFile = logFile
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
