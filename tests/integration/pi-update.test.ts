import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPiUpdateService } from '../../src/main/services/pi-update'
import type {
  PiUpdateApplyOutcome,
  PiUpdateCompleted,
  PiUpdateRejected,
  PiUpdateService,
  PiUpdateServiceDeps,
  RequestJsonOptions,
  SpawnExitInfo,
  SpawnHandle
} from '../../src/main/services/pi-update'
import type { PiLaunchSpec } from '../../src/main/transport/types'
import type { PiUpdateEvent } from '../../src/shared/contracts/update'

/**
 * A34 集成：`pi update` 全链路（真实 `createPiUpdateService` + 真实 spawn mock-pi）。
 *
 * 真实要素：
 * - 服务本体（单飞锁 / 会话 gate / 流式日志 / 终态判定）全跑真实实现；
 * - `pi update` 与 `pi --version` 都是**真实子进程**（`process.execPath` 跑
 *   `tests/integration/fixtures/mock-pi.mjs`），不经过 shell、不依赖 PATH（Windows 可跑）；
 * - 「更新后版本变了」由 `MOCK_PI_VERSION_FILE` 真实落盘 + 真实 `--version` 复验观测，
 *   所以 `afterVersion` 不是测试自己编的。
 *
 * 只 fake 两处边界：`requestJson`（更新源，绝不联网）与 `emit`（收集事件）。
 * 唯一注入 spawn 的是并发用例（需要一个「永不退出」的可控子进程）。
 */

const mockPiPath = fileURLToPath(new URL('./fixtures/mock-pi.mjs', import.meta.url))

/** mock 直接用 node 跑（与 rpc-chain.test.ts 同一写法）：零 shell、跨平台 */
const SPEC: PiLaunchSpec = {
  command: process.execPath,
  prefixArgs: [mockPiPath],
  displayPath: mockPiPath,
  launchKind: 'node-shim'
}

const BASE_VERSION = '1.5.2'
const NEXT_VERSION = '1.6.0'
/** 每个用例自带上限（防「任务卡死」把整个 integration 拖到全局超时） */
const TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ *
 * mock 夹具的 env 管理
 * ------------------------------------------------------------------ */

let tempDir = ''
let versionFile = ''
const savedEnv = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** 每个用例前把「本机版本」和「update 模式」复位（I1 会把版本文件改成 1.6.0） */
async function resetMock(options: { mode?: string; version?: string } = {}): Promise<void> {
  await writeFile(versionFile, options.version ?? BASE_VERSION, 'utf8')
  setEnv('MOCK_PI_UPDATE_MODE', options.mode ?? 'in-sync')
}

/**
 * 真实执行 `node mock-pi.mjs --version`（服务里的 `locatePi` 在主进程就是这层适配）。
 * 这是「更新后版本真的变了」的唯一证据来源。
 */
function runMockVersion(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [mockPiPath, '--version'],
      { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS },
      (error, stdout) => {
        if (error !== null) {
          // execFile 的 error 类型是 ExecFileException，eslint 要求 reject 的必须是 Error
          reject(error instanceof Error ? error : new Error('mock-pi --version 执行失败'))
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

/* ------------------------------------------------------------------ *
 * 服务组装：真实 service，只 fake requestJson / emit
 * ------------------------------------------------------------------ */

interface HarnessOptions {
  /** `activeSessionKeys()` 的返回值（非空 → 默认拒绝执行） */
  sessions?: readonly string[]
  /** 更新源响应（默认 `{ version: '1.6.0' }`；传 Error 可测失败） */
  remote?: unknown
  /** 注入可控子进程（并发用例）；省略则走服务默认 `defaultSpawnPi` 真 spawn mock */
  spawnPi?: (spec: PiLaunchSpec, argv: string[]) => SpawnHandle
  /** `disposeAllSessions()` 是否抛错 */
  disposeThrows?: boolean
}

interface Harness {
  service: PiUpdateService
  events: PiUpdateEvent[]
  requestCalls: { url: URL; opts: RequestJsonOptions }[]
  /** `locatePi()` 调用次数（gate 顺序的证据） */
  readonly locateCalls: number
  /** 用 getter：`disposeAllSessions` 会在 apply 过程中自增，快照会让断言永远看到 0 */
  readonly disposeCalls: number
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: PiUpdateEvent[] = []
  const requestCalls: { url: URL; opts: RequestJsonOptions }[] = []
  const injectedSpawn = options.spawnPi
  let locateCalls = 0
  let disposeCalls = 0

  const deps: PiUpdateServiceDeps = {
    locatePi: async () => {
      locateCalls += 1
      const version = await runMockVersion()
      return version.length === 0 ? { command: SPEC.command } : { command: SPEC.command, version }
    },
    launchPi: () => Promise.resolve(SPEC),
    activeSessionKeys: () => options.sessions ?? [],
    disposeAllSessions: () => {
      disposeCalls += 1
      if (options.disposeThrows === true) return Promise.reject(new Error('dispose boom'))
      return Promise.resolve()
    },
    emit: (event) => {
      events.push(event)
    },
    requestJson: (url, opts) => {
      requestCalls.push({ url, opts })
      const remote = options.remote
      if (remote instanceof Error) return Promise.reject(remote)
      return Promise.resolve(remote ?? { version: NEXT_VERSION })
    },
    ...(injectedSpawn === undefined ? {} : { spawnPi: injectedSpawn })
  }

  const service = createPiUpdateService(deps)
  return {
    service,
    events,
    requestCalls,
    get locateCalls() {
      return locateCalls
    },
    get disposeCalls() {
      return disposeCalls
    }
  }
}

/* ------------------------------------------------------------------ *
 * 断言 / 等待小工具
 * ------------------------------------------------------------------ */

/** `apply` 返回 `{accepted:true, result}` 才算「跑完了」；失败进程也是 completed（outcome:'failed'） */
function expectAccepted(outcome: PiUpdateApplyOutcome): PiUpdateCompleted {
  if (!outcome.accepted) {
    throw new Error(`期望执行完成，实际被拒绝：${outcome.reason}（${outcome.message}）`)
  }
  return outcome
}

/** gate 拒绝（busy / session-busy / unavailable / not-located / failed） */
function expectRejected(outcome: PiUpdateApplyOutcome): PiUpdateRejected {
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

/**
 * 「永不退出」的假子进程（只给并发用例）：
 * 真实 npm 安装可能要几十秒，要稳定测「单飞」，必须能自己决定它什么时候结束。
 */
interface HangingChild {
  handle: SpawnHandle
  kills: NodeJS.Signals[]
  exit(code: number | null): void
}

function createHangingChild(): HangingChild {
  const stdoutListeners: ((chunk: string) => void)[] = []
  const stderrListeners: ((chunk: string) => void)[] = []
  const errorListeners: ((error: Error) => void)[] = []
  const exitListeners: ((info: SpawnExitInfo) => void)[] = []
  const kills: NodeJS.Signals[] = []

  const handle: SpawnHandle = {
    pid: 90_001,
    onStdout: (listener) => {
      stdoutListeners.push(listener)
    },
    onStderr: (listener) => {
      stderrListeners.push(listener)
    },
    onError: (listener) => {
      errorListeners.push(listener)
    },
    onExit: (listener) => {
      exitListeners.push(listener)
    },
    kill: (signal) => {
      kills.push(signal)
    }
  }

  return {
    handle,
    kills,
    exit: (code) => {
      for (const listener of exitListeners) listener({ code, signal: null })
    }
  }
}

/* ================================================================== *
 * 用例
 * ================================================================== */

describe('A34 集成：pi update 全链路（真实 spawn mock-pi）', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-desktop-a34-'))
    versionFile = join(tempDir, 'version.txt')
    await writeFile(versionFile, BASE_VERSION, 'utf8')
    // 全部通过 process.env 传给真实子进程（defaultSpawnPi 不额外拼 env）
    setEnv('MOCK_PI_VERSION', BASE_VERSION)
    setEnv('MOCK_PI_VERSION_FILE', versionFile)
    setEnv('MOCK_PI_UPDATE_TO', NEXT_VERSION)
    // 更新源地址：requestJson 已 fake，这里只是避免依赖宿主的 PI_DESKTOP_UPDATE_CHECK_URL
    setEnv('PI_DESKTOP_UPDATE_CHECK_URL', undefined)
  })

  beforeEach(async () => {
    await resetMock()
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
    'I1 available：真装上新版本 → afterVersion 由真实 `pi --version` 复验为 1.6.0',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'available' })

      const check = await harness.service.check()
      expect(check.state).toBe('available')
      expect(check.currentVersion).toBe(BASE_VERSION)
      expect(check.latestVersion).toBe(NEXT_VERSION)

      const outcome = expectAccepted(await harness.service.apply({}))
      expect(outcome.result.outcome).toBe('updated')
      expect(outcome.result.beforeVersion).toBe(BASE_VERSION)
      expect(outcome.result.targetVersion).toBe(NEXT_VERSION)
      expect(outcome.result.afterVersion).toBe(NEXT_VERSION)

      // 不是「只信 stdout」：版本文件确实被 mock 写成了目标版本
      expect((await readFile(versionFile, 'utf8')).trim()).toBe(NEXT_VERSION)
      expect(harness.service.isRunning()).toBe(false)
      expect(harness.service.activeJobId()).toBeUndefined()
    },
    TIMEOUT_MS
  )

  it(
    'I2 in-sync：命令成功但版本没变 → pendingRestart（不是 updated，也不报失败）',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'in-sync' })

      // 远端有新版，但本机这份 pi 不认（或已是最新）：执行后版本不动
      const check = await harness.service.check()
      expect(check.state).toBe('available')

      const outcome = expectAccepted(await harness.service.apply({}))
      // classifyUpdateOutcome：exit 0 且 afterVersion === beforeVersion → pendingRestart
      expect(outcome.result.outcome).toBe('pendingRestart')
      expect(outcome.result.afterVersion).toBe(BASE_VERSION)
      expect(outcome.result.afterVersion).toBe(outcome.result.beforeVersion)
      expect(outcome.result.message).toContain('PATH')

      expect((await readFile(versionFile, 'utf8')).trim()).toBe(BASE_VERSION)
    },
    TIMEOUT_MS
  )

  it(
    'I3 fail：npm 权限错误 → outcome failed，logTail 含 EACCES',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'fail' })

      const outcome = expectAccepted(await harness.service.apply({}))
      expect(outcome.result.outcome).toBe('failed')
      expect(outcome.result.message).toContain('退出码 1')
      expect(outcome.result.logTail).toContain('EACCES')
      // 非 0 退出不复查版本
      expect(outcome.result.afterVersion).toBeUndefined()

      const logText = harness.events
        .filter((event) => event.phase === 'log')
        .map((event) => event.line ?? '')
        .join('\n')
      expect(logText).toContain('npm ERR! code EACCES')
      // 终态事件同步收敛为 failed
      expect(harness.events.at(-1)?.phase).toBe('failed')
    },
    TIMEOUT_MS
  )

  it(
    'I4 no-self：不支持自更新 → accepted:false + reason unavailable + manualCommand',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'no-self' })

      const outcome = expectRejected(await harness.service.apply({}))
      expect(outcome.reason).toBe('unavailable')
      expect(outcome.message).toBe('当前安装不支持自动更新')
      // manualCommand 由 extractManualCommand 从 PI_SELF_UPDATE_COMMAND 行提取
      expect(outcome.manualCommand).toBeDefined()
      expect(outcome.manualCommand ?? '').toContain('customize how pi is updated')
      expect(outcome.logTail).toContain('cannot self-update')
      // 拒绝路径不产生 completed result，但任务已释放在跑标记
      expect(harness.service.isRunning()).toBe(false)
    },
    TIMEOUT_MS
  )

  it(
    'I5a 有活跃会话 → session-busy，且完全没启动子进程',
    async () => {
      const harness = createHarness({ sessions: ['s1'] })
      await resetMock({ mode: 'available' })

      const outcome = expectRejected(await harness.service.apply({}))
      expect(outcome.reason).toBe('session-busy')
      expect(outcome.sessionKeys).toEqual(['s1'])
      expect(outcome.message).toContain('1 个会话')
      // gate 在 launchPi / spawn 之前：既没定位也没 emit（一次 started 都没有）
      expect(harness.locateCalls).toBe(0)
      expect(harness.events).toHaveLength(0)
    },
    TIMEOUT_MS
  )

  it(
    'I5b disposeSessions:true → 先 disposeAllSessions 再真装成功',
    async () => {
      const harness = createHarness({ sessions: ['s1', 's2'] })
      await resetMock({ mode: 'available' })

      const outcome = expectAccepted(await harness.service.apply({ disposeSessions: true }))
      expect(harness.disposeCalls).toBe(1)
      expect(outcome.result.outcome).toBe('updated')
      expect(outcome.result.afterVersion).toBe(NEXT_VERSION)

      // 反证：dispose 抛错时必须在 spawn 之前失败，且原因归到 failed
      const failing = createHarness({ sessions: ['s1'], disposeThrows: true })
      await resetMock({ mode: 'available' })
      const rejected = expectRejected(await failing.service.apply({ disposeSessions: true }))
      expect(rejected.reason).toBe('failed')
      expect(rejected.message).toContain('结束现有会话失败')
      expect(failing.events).toHaveLength(0)
    },
    TIMEOUT_MS
  )

  it(
    'I6 并发：第一个任务未结束时第二次 apply 直接 busy（单飞，不排队）',
    async () => {
      const child = createHangingChild()
      const harness = createHarness({ spawnPi: () => child.handle })

      const first = harness.service.apply({})
      await waitFor(
        () => harness.events.some((event) => event.phase === 'started'),
        '第一次 started'
      )
      expect(harness.service.isRunning()).toBe(true)

      const second = expectRejected(await harness.service.apply({}))
      expect(second.reason).toBe('busy')
      expect(second.message).toContain('已有更新任务在执行')

      // 收尾：让它真的结束（exit 0 → 服务会用真实 `--version` 复验，版本未变 → pendingRestart）
      child.exit(0)
      const firstOutcome = expectAccepted(await first)
      expect(firstOutcome.result.outcome).toBe('pendingRestart')
      expect(firstOutcome.result.afterVersion).toBe(BASE_VERSION)
      expect(harness.service.isRunning()).toBe(false)
    },
    TIMEOUT_MS
  )

  it(
    'I7 force：`pi update --force` 参数真的传下去了（mock 回 `Forcing reinstall of pi`）',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'in-sync' })

      const outcome = expectAccepted(await harness.service.apply({ force: true }))
      // in-sync + --force：mock 按 available 处理 → 版本文件被写成目标版本
      expect(outcome.result.outcome).toBe('updated')
      expect(outcome.result.afterVersion).toBe(NEXT_VERSION)

      const logText = harness.events
        .filter((event) => event.phase === 'log')
        .map((event) => event.line ?? '')
        .join('\n')
      expect(logText).toContain('Forcing reinstall of pi')
    },
    TIMEOUT_MS
  )

  it(
    '事件：started 开头、终态结尾、jobId 全程一致，日志来自真实子进程',
    async () => {
      const harness = createHarness()
      await resetMock({ mode: 'available' })

      const outcome = expectAccepted(await harness.service.apply({}))
      expect(outcome.result.outcome).toBe('updated')

      const first = harness.events[0]
      expect(first?.phase).toBe('started')
      expect(first?.message).toContain('update')

      const last = harness.events.at(-1)
      expect(last?.phase).toBe('done')
      expect(last?.message).toContain('已更新')

      // 同一次任务的 jobId 全程一致（renderer 靠它归属日志）
      expect(new Set(harness.events.map((event) => event.jobId)).size).toBe(1)
      expect(last?.jobId).toBe(first?.jobId)

      const logText = harness.events
        .filter((event) => event.phase === 'log')
        .map((event) => event.line ?? '')
        .join('\n')
      expect(logText).toContain(`Updating pi from ${BASE_VERSION} to ${NEXT_VERSION}`)
      expect(logText).toContain(`Updated pi from ${BASE_VERSION} to ${NEXT_VERSION}`)
      // mock 的 RPC 横幅只进 RPC 模式：`update` 分支必须已提前退出
      expect(logText).not.toContain('mock-pi rpc ready')
    },
    TIMEOUT_MS
  )
})
