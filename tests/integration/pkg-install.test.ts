import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPiPackageCatalog } from '../../src/main/services/pi-package-catalog'
import { createPiPackageInstaller } from '../../src/main/services/pi-package-installer'
import type {
  PiPackageInstallOutcome,
  PiPackageInstaller,
  PiPackageInstallerDeps
} from '../../src/main/services/pi-package-installer'
import type { PiLaunchSpec } from '../../src/main/transport/types'
import type {
  PkgCatalogView,
  PkgInstallEvent,
  PkgInstallResult
} from '../../src/shared/contracts/packages'

/**
 * A37 集成：`pi install` 全链路（真实 `createPiPackageInstaller` + 真实 `createPiPackageCatalog`
 * + 真实 spawn 的 mock-pi）。
 *
 * 真实要素：
 * - 安装器本体（source 校验 / 单飞 / 流式日志 / 取消 / exit 0 后复验 settings.json）全跑真实现；
 * - `pi install <source>` 是**真实子进程**（`process.execPath` 跑
 *   `tests/integration/fixtures/mock-pi.mjs`），不经 shell、不依赖 PATH（Windows 可跑）；
 * - 「装上了」由 mock **真实写盘**（`<agentDir>/settings.json#packages` +
 *   `<agentDir>/npm/node_modules/<pkg>/package.json`）承载，再由真实 catalog 读回来 →
 *   `installedPath` / `version` / `description` 不是测试自己编的。
 *
 * 只 fake 两处边界：`requestJson`（registry 元数据，绝不联网）与 `emit`（收集事件）。
 */

const mockPiPath = fileURLToPath(new URL('./fixtures/mock-pi.mjs', import.meta.url))

/** mock 直接用 node 跑：零 shell、跨平台（与 pi-update.test.ts 同一写法） */
const SPEC: PiLaunchSpec = {
  command: process.execPath,
  prefixArgs: [mockPiPath],
  displayPath: mockPiPath,
  launchKind: 'node-shim'
}

const SOURCE = 'npm:pi-mock'
/** 每个用例自带上限（防「任务卡死」把整个 integration 拖到全局超时） */
const TIMEOUT_MS = 30_000
/** slow 模式的等待时长：必须明显长于 cancel 的响应时间，但远小于用例超时 */
const SLOW_DELAY_MS = 4_000

/* ------------------------------------------------------------------ *
 * mock 夹具的临时目录与 env 管理
 * ------------------------------------------------------------------ */

let tempDir = ''
let agentDir = ''
let settingsPath = ''
let argvFile = ''

const savedEnv = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** 每个用例前：settings 复位为最小清单、argv 记录清掉、安装模式复位 */
async function resetMockAgent(options: { mode?: string; delayMs?: number } = {}): Promise<void> {
  // 先建目录——mkdtemp 只保证 tempDir 存在，agent/ 还不存在
  await mkdir(agentDir, { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify({ packages: [] }, null, 2)}\n`, 'utf8')
  await rm(argvFile, { force: true })
  setEnv('MOCK_PI_INSTALL_MODE', options.mode ?? 'ok')
  setEnv(
    'MOCK_PI_INSTALL_DELAY_MS',
    options.delayMs === undefined ? undefined : String(options.delayMs)
  )
}

/** 读 mock 真实收到的 argv（`MOCK_PI_INSTALL_ARGV_FILE` 由子进程落盘） */
async function readInstallArgv(): Promise<string[]> {
  const text = await readFile(argvFile, 'utf8')
  return JSON.parse(text) as string[]
}

/** 读 agentDir 的 settings.json（断言「登记是否真的落盘」的唯一证据） */
async function readSettings(): Promise<Record<string, unknown>> {
  const text = await readFile(settingsPath, 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

function settingsPackages(settings: Record<string, unknown>): unknown[] {
  const packages = settings['packages']
  return Array.isArray(packages) ? packages : []
}

/* ------------------------------------------------------------------ *
 * 服务组装：真实 installer + 真实 catalog，只 fake requestJson / emit
 * ------------------------------------------------------------------ */

interface Harness {
  installer: PiPackageInstaller
  catalog: ReturnType<typeof createPiPackageCatalog>
  events: PkgInstallEvent[]
}

function createHarness(): Harness {
  const events: PkgInstallEvent[] = []

  const deps: PiPackageInstallerDeps = {
    locatePi: () => Promise.resolve({ command: SPEC.command }),
    launchPi: () => Promise.resolve(SPEC),
    agentDir: () => agentDir,
    emit: (event) => {
      events.push(event)
    },
    // registry 元数据：固定形状，绝不联网（预览路径不参与本次断言，但装的是同一服务）
    requestJson: () => Promise.resolve({ 'dist-tags': { latest: '1.0.0' }, description: 'x' })
  }

  return {
    installer: createPiPackageInstaller(deps),
    // 真实 catalog：同一 agentDir，读真实落盘的 settings.json / package.json
    catalog: createPiPackageCatalog({ agentDir }),
    events
  }
}

/* ------------------------------------------------------------------ *
 * 断言 / 等待小工具
 * ------------------------------------------------------------------ */

/** `accepted:true` 才算「跑完了」（失败进程也是 accepted:true，见 outcome） */
function expectAccepted(outcome: PiPackageInstallOutcome): PkgInstallResult {
  if (!outcome.accepted) {
    throw new Error(`期望执行完成，实际被拒绝：${outcome.reason}（${outcome.message}）`)
  }
  return outcome.result
}

/** gate 拒绝（busy / updating / not-located / invalid） */
function expectRejected(
  outcome: PiPackageInstallOutcome
): Extract<PiPackageInstallOutcome, { accepted: false }> {
  if (outcome.accepted) {
    throw new Error(`期望被拒绝，实际执行完成：${outcome.result.outcome}`)
  }
  return outcome
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error(`等待超时：${label}`)
}

/* ================================================================== *
 * 用例
 * ================================================================== */

describe('A37 集成：pi install 全链路（真实 spawn mock-pi + 真实复验）', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-desktop-a37-'))
    agentDir = join(tempDir, 'agent')
    settingsPath = join(agentDir, 'settings.json')
    argvFile = join(tempDir, 'install-argv.json')

    // 真实子进程通过 process.env 继承这些开关（defaultSpawnPi 不额外拼 env）
    setEnv('MOCK_PI_AGENT_DIR', agentDir)
    setEnv('MOCK_PI_INSTALL_ARGV_FILE', argvFile)

    // 最小 settings.json：mock 的写入逻辑会在其上追加 packages
    await mkdir(agentDir, { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify({ packages: [] }, null, 2)}\n`, 'utf8')
  })

  beforeEach(async () => {
    await resetMockAgent()
  })

  afterAll(async () => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    savedEnv.clear()
    if (tempDir.length > 0) await rm(tempDir, { recursive: true, force: true })
  })

  it(
    'I1 成功安装 npm 源：argv 严格等于 [install, source]，settings 登记 + catalog 读回版本与目录',
    async () => {
      const harness = createHarness()

      const result = expectAccepted(await harness.installer.install(SOURCE))
      expect(result.outcome).toBe('installed')
      expect(result.source).toBe(SOURCE)
      expect(result.kind).toBe('npm')
      expect(result.version).toBe('9.9.9')
      expect(result.installedPath).toBe(join(agentDir, 'npm', 'node_modules', 'pi-mock'))

      // 真实子进程确实按「两个元素、不拼字符串」的形态被调用
      expect(await readInstallArgv()).toEqual(['install', SOURCE])

      // 落盘事实：settings.json 里真的出现了这条声明
      expect(settingsPackages(await readSettings())).toContain(SOURCE)

      // 真实 catalog 读回同一份磁盘事实
      const view: PkgCatalogView = await harness.catalog.list()
      expect(view.agentDir).toBe(agentDir)
      const entry = view.packages.find((pkg) => pkg.source === SOURCE)
      expect(entry).toBeDefined()
      if (entry === undefined) throw new Error('catalog 未返回刚安装的条目')
      expect(entry.scope).toBe('global')
      expect(entry.kind).toBe('npm')
      expect(entry.name).toBe('pi-mock')
      expect(entry.version).toBe('9.9.9')
      expect(entry.description).toBe('mock package')
      expect(entry.installedPath).toBe(join(agentDir, 'npm', 'node_modules', 'pi-mock'))

      expect(harness.installer.isRunning()).toBe(false)
    },
    TIMEOUT_MS
  )

  it(
    'I2 exit 0 但未登记（noop）：不算装好 → outcome failed，message 指向 settings.json',
    async () => {
      await resetMockAgent({ mode: 'noop' })
      const harness = createHarness()

      const result = expectAccepted(await harness.installer.install(SOURCE))
      expect(result.outcome).toBe('failed')
      expect(result.message).toContain('settings.json')
      // exit 0 但没登记：不谎报 installedPath / version
      expect(result.installedPath).toBeUndefined()
      expect(result.version).toBeUndefined()

      // 反证：磁盘上确实没有这条声明
      expect(settingsPackages(await readSettings())).not.toContain(SOURCE)
      expect(harness.events.at(-1)?.phase).toBe('failed')
      expect(harness.installer.isRunning()).toBe(false)
    },
    TIMEOUT_MS
  )

  it(
    'I3 失败（fail）：outcome failed，logTail 含 EACCES，manualCommand 是等价的 pi install',
    async () => {
      await resetMockAgent({ mode: 'fail' })
      const harness = createHarness()

      const result = expectAccepted(await harness.installer.install(SOURCE))
      expect(result.outcome).toBe('failed')
      expect(result.message).toContain('退出码 1')
      expect(result.logTail).toContain('EACCES')
      expect(result.manualCommand).toBe(`pi install ${SOURCE}`)
      expect(result.manualCommand?.startsWith('pi install ')).toBe(true)

      // 失败路径不产生登记
      expect(settingsPackages(await readSettings())).not.toContain(SOURCE)
      // 终态事件同步收敛为 failed，且日志来自真实子进程 stderr
      expect(harness.events.at(-1)?.phase).toBe('failed')
      const logText = harness.events
        .filter((event) => event.phase === 'log')
        .map((event) => event.line ?? '')
        .join('\n')
      expect(logText).toContain('npm ERR! code EACCES')
    },
    TIMEOUT_MS
  )

  it(
    'I4 取消（slow）：install 进行中 cancel → outcome canceled，且没有新增登记',
    async () => {
      await resetMockAgent({ mode: 'slow', delayMs: SLOW_DELAY_MS })
      const harness = createHarness()

      const pending = harness.installer.install(SOURCE)

      // 等到真实子进程的 stdout 出现（证明已经 spawn，而不是只走过 gate）
      await waitFor(
        () =>
          harness.events.some(
            (event) => event.phase === 'log' && (event.line ?? '').includes('Installing')
          ),
        '第一次 Installing 日志'
      )
      expect(harness.installer.isRunning()).toBe(true)

      harness.installer.cancel()
      const result = expectAccepted(await pending)
      expect(result.outcome).toBe('canceled')

      expect(harness.installer.isRunning()).toBe(false)
      expect(harness.installer.activeJobId()).toBeUndefined()
      // 被取消的安装没有写 settings：不能因为「目录恰好存在」就报成功
      expect(settingsPackages(await readSettings())).not.toContain(SOURCE)
    },
    TIMEOUT_MS
  )

  it(
    'I5 事件：phase 首条 started、末条 done、jobId 全程一致',
    async () => {
      const harness = createHarness()

      const result = expectAccepted(await harness.installer.install(SOURCE))
      expect(result.outcome).toBe('installed')

      const first = harness.events[0]
      expect(first?.phase).toBe('started')
      expect(first?.message).toContain(SOURCE)

      const last = harness.events.at(-1)
      expect(last?.phase).toBe('done')
      expect(last?.message).toContain(SOURCE)

      // 同一次任务的 jobId 全程一致（renderer 靠它归属日志）
      expect(new Set(harness.events.map((event) => event.jobId)).size).toBe(1)
      expect(last?.jobId).toBe(first?.jobId)

      const logText = harness.events
        .filter((event) => event.phase === 'log')
        .map((event) => event.line ?? '')
        .join('\n')
      expect(logText).toContain(`Installed ${SOURCE}`)
    },
    TIMEOUT_MS
  )

  it(
    'I6 并发：第一次未结束时第二次 install 直接 busy（单飞，不排队）',
    async () => {
      await resetMockAgent({ mode: 'slow', delayMs: SLOW_DELAY_MS })
      const harness = createHarness()

      const first = harness.installer.install(SOURCE)
      await waitFor(
        () => harness.events.some((event) => event.phase === 'started'),
        '第一次 started'
      )
      expect(harness.installer.isRunning()).toBe(true)

      const second = expectRejected(await harness.installer.install(SOURCE))
      expect(second.accepted).toBe(false)
      if (second.accepted) throw new Error('unreachable')
      expect(second.reason).toBe('busy')
      expect(second.message).toContain('已有插件安装任务在执行')

      // 收尾：取消第一次并等它真的结束
      harness.installer.cancel()
      const firstResult = expectAccepted(await first)
      expect(firstResult.outcome).toBe('canceled')
      expect(harness.installer.isRunning()).toBe(false)
    },
    TIMEOUT_MS
  )
})
