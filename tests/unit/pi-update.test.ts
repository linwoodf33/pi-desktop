import { describe, expect, it, vi } from 'vitest'

import {
  LATEST_VERSION_URL,
  classifyUpdateOutcome,
  createPiUpdateService,
  extractManualCommand,
  isAllowedCheckUrl,
  parseLatestVersionPayload,
  redactLine,
  stripAnsi
} from '../../src/main/services/pi-update'
import type {
  PiUpdateApplyOutcome,
  PiUpdateRejected,
  PiUpdateService,
  PiUpdateServiceDeps,
  RequestJsonOptions,
  SpawnExitInfo,
  SpawnHandle
} from '../../src/main/services/pi-update'
import type { PiLaunchSpec } from '../../src/main/transport/types'
import type {
  PiUpdateApplyInput,
  PiUpdateCheckResult,
  PiUpdateEvent
} from '../../src/shared/contracts/update'

/**
 * pi 更新服务（A34）单测。
 *
 * 全部跑真实的 `createPiUpdateService`，只替换边界依赖：
 * `requestJson`（不联网）/ `spawnPi`（不 spawn 真实进程）/ `readCache` `writeCache`
 * （进程内槽位）/ `now`（固定时钟，断言 `checkedAt` 精确）。
 *
 * 覆盖三组：
 * 1. 纯函数（清洗 / 脱敏 / 终态判定 / URL 白名单 / payload 解析 / 手动命令提取）；
 * 2. 检测 `check()`：available / upToDate / 远端更低 / 失败收敛 unknown / 非法 payload /
 *    无 pi / 失败回落缓存 / env 覆盖被拒；
 * 3. 执行 `apply()`：argv 严格形态 / 会话 gate / dispose 顺序 / 单飞 busy /
 *    不支持自更新时回传 manualCommand / 事件序列。
 */

const FIXED_NOW = '2026-01-02T03:04:05.000Z'

/** 与主进程一致的检测探针预算（`CHECK_TIMEOUT_MS` / `CHECK_MAX_BYTES`） */
const EXPECTED_CHECK_OPTS: RequestJsonOptions = { timeoutMs: 5_000, maxBytes: 8 * 1024 }

const SPEC: PiLaunchSpec = {
  command: 'C:\\fake\\pi.exe',
  prefixArgs: [],
  displayPath: 'C:\\fake\\pi.exe',
  launchKind: 'direct'
}

/* ------------------------------------------------------------------ *
 * 假子进程：测试自己驱动 stdout / stderr / error / exit
 * ------------------------------------------------------------------ */

interface FakeChild {
  readonly handle: SpawnHandle
  readonly kills: NodeJS.Signals[]
  stdout(chunk: string): void
  stderr(chunk: string): void
  exit(code: number | null, signal?: string | null): void
  crash(error: Error): void
}

function createFakeChild(pid: number | undefined): FakeChild {
  const stdoutListeners: ((chunk: string) => void)[] = []
  const stderrListeners: ((chunk: string) => void)[] = []
  const errorListeners: ((error: Error) => void)[] = []
  const exitListeners: ((info: SpawnExitInfo) => void)[] = []
  const kills: NodeJS.Signals[] = []

  const handle: SpawnHandle = {
    pid,
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
    stdout: (chunk) => {
      for (const listener of stdoutListeners) listener(chunk)
    },
    stderr: (chunk) => {
      for (const listener of stderrListeners) listener(chunk)
    },
    exit: (code, signal = null) => {
      for (const listener of exitListeners) listener({ code, signal })
    },
    crash: (error) => {
      for (const listener of errorListeners) listener(error)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 服务组装：真实 service + fake deps
 * ------------------------------------------------------------------ */

interface HarnessOptions {
  /** 本机 pi 版本；字面量 `'missing'` 表示定位不到 pi */
  localVersion?: string
  /** 每次 `locatePi()` 依次返回的版本（用于"执行后版本变了"）；优先于 `localVersion` */
  versions?: readonly string[]
  /** 更新源响应：对象 / Error / 自定义函数（可模拟"第一次成功、第二次失败"） */
  remote?: unknown
  /** 活跃会话 key（非空调 `activeSessionKeys`） */
  sessions?: readonly string[]
  /** 启动描述；`'missing'` 表示拿不到 */
  launch?: PiLaunchSpec | 'missing'
  /** 注入时钟（断言 `checkedAt`） */
  now?: () => Date
  /** `PI_DESKTOP_UPDATE_CHECK_URL` 等环境变量 */
  env?: NodeJS.ProcessEnv
  /** `disposeAllSessions()` 是否抛错 */
  disposeThrows?: boolean
  /**
   * 假子进程 pid。`null` = 不给 pid：`killJob` 在 win32 上会按 pid 补一发
   * `taskkill /T /F`，测试里绝不能把它打到一个真实存在的 pid 上。
   */
  childPid?: number | null
}

interface Harness {
  service: PiUpdateService
  /** `spawnPi` 的入参（严格断言 argv 用） */
  spawnCalls: { spec: PiLaunchSpec; argv: string[] }[]
  /** `requestJson` 的入参（断言目标地址与预算） */
  requestCalls: { url: URL; opts: RequestJsonOptions }[]
  events: PiUpdateEvent[]
  /** 关键副作用顺序：dispose / request / spawn */
  order: string[]
  children: FakeChild[]
  disposeCalls: number
  /** 检测缓存槽位（等价于文件缓存） */
  cache: { value: PiUpdateCheckResult | undefined }
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: PiUpdateEvent[] = []
  const spawnCalls: { spec: PiLaunchSpec; argv: string[] }[] = []
  const requestCalls: { url: URL; opts: RequestJsonOptions }[] = []
  const order: string[] = []
  const children: FakeChild[] = []
  const cache: { value: PiUpdateCheckResult | undefined } = { value: undefined }

  const versions = options.versions ?? [options.localVersion ?? '1.5.2']
  let locateIndex = 0
  let disposeCalls = 0

  const deps: PiUpdateServiceDeps = {
    locatePi: () => {
      const index = Math.min(locateIndex, versions.length - 1)
      locateIndex += 1
      const version = versions[index]
      if (version === undefined || version === 'missing') return Promise.resolve(undefined)
      return Promise.resolve({ command: SPEC.command, version })
    },
    launchPi: () => {
      const launch = options.launch ?? SPEC
      return Promise.resolve(launch === 'missing' ? undefined : launch)
    },
    activeSessionKeys: () => options.sessions ?? [],
    disposeAllSessions: () => {
      disposeCalls += 1
      order.push('dispose')
      if (options.disposeThrows === true) return Promise.reject(new Error('dispose boom'))
      return Promise.resolve()
    },
    emit: (event) => {
      events.push(event)
    },
    requestJson: (url, opts) => {
      requestCalls.push({ url, opts })
      order.push('request')
      const remote = options.remote
      if (remote instanceof Error) return Promise.reject(remote)
      if (typeof remote === 'function') {
        const fn = remote as (u: URL, o: RequestJsonOptions) => Promise<unknown>
        return fn(url, opts)
      }
      return Promise.resolve(remote ?? { version: '1.6.0' })
    },
    spawnPi: (spec, argv) => {
      order.push('spawn')
      const child = createFakeChild(
        options.childPid === null ? undefined : (options.childPid ?? 4242)
      )
      children.push(child)
      spawnCalls.push({ spec, argv: [...argv] })
      return child.handle
    },
    readCache: () => Promise.resolve(cache.value),
    writeCache: (result) => {
      cache.value = result
      return Promise.resolve()
    },
    now: options.now ?? (() => new Date(FIXED_NOW)),
    env: options.env ?? {}
  }

  const service = createPiUpdateService(deps)
  return {
    service,
    spawnCalls,
    requestCalls,
    events,
    order,
    children,
    cache,
    // 用 getter 而不是值：`disposeCalls` 会在 apply 过程中自增，快照会让断言永远看到 0
    get disposeCalls() {
      return disposeCalls
    }
  }
}

/** 让出微任务，直到条件成立（apply 内部有多次 await，不能只 flush 一次） */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
  throw new Error(`等待超时：${label}`)
}

function firstChild(harness: Harness): FakeChild {
  const child = harness.children[0]
  if (child === undefined) throw new Error('尚未 spawn pi update')
  return child
}

function expectRejected(outcome: PiUpdateApplyOutcome): PiUpdateRejected {
  if (outcome.accepted) {
    throw new Error(`期望被拒绝，实际完成：${outcome.result.outcome}`)
  }
  return outcome
}

/** 跑一次 apply：等到 spawn 后用 `drive` 驱动假子进程，最后等结果 */
async function runApply(
  harness: Harness,
  input: PiUpdateApplyInput,
  drive: (child: FakeChild) => void
): Promise<PiUpdateApplyOutcome> {
  const pending = harness.service.apply(input)
  await waitFor(() => harness.children.length > 0, 'spawn pi update')
  drive(firstChild(harness))
  return await pending
}

/* ================================================================== *
 * 纯函数 U8 - U11
 * ================================================================== */

describe('isAllowedCheckUrl：更新源白名单（U8）', () => {
  it('https 更新源放行', () => {
    const decision = isAllowedCheckUrl(LATEST_VERSION_URL)
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.url.toString()).toBe(LATEST_VERSION_URL)
  })

  it('本机 http 仅在显式放行（e2e 开关）时可用', () => {
    const allowed = isAllowedCheckUrl('http://127.0.0.1:1234/x', true)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.url.port).toBe('1234')

    const blocked = isAllowedCheckUrl('http://127.0.0.1:1234/x')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain('https')
  })

  it('非环回 http 一律拒绝（即使开了放行开关）', () => {
    const decision = isAllowedCheckUrl('http://evil.com/x', true)
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toContain('127.0.0.1')
  })

  it('非 http(s) 协议与非法地址都拒绝', () => {
    expect(isAllowedCheckUrl('file:///etc/passwd').ok).toBe(false)
    expect(isAllowedCheckUrl('not a url').ok).toBe(false)
  })
})

describe('stripAnsi（U9）', () => {
  it('剥掉颜色码但保留正文', () => {
    const colored = '\u001b[1m\u001b[32madded 3 packages\u001b[0m in \u001b[33m2s\u001b[0m'
    expect(stripAnsi(colored)).toBe('added 3 packages in 2s')
    expect(stripAnsi('纯文本')).toBe('纯文本')
  })
})

describe('redactLine（U10）', () => {
  it('命中敏感关键字的整行替换为 [redacted]', () => {
    expect(redactLine('token=abc123')).toBe('[redacted]')
    expect(redactLine('deploy with api_key: sk-live-42')).toBe('[redacted]')
    expect(redactLine('Authorization: Bearer abcdefghijkl')).toBe('[redacted]')
  })

  it('凭证 URL 只遮蔽凭据部分', () => {
    expect(redactLine('https://user:pass@registry.example.com/pkg')).toBe(
      'https://***@registry.example.com/pkg'
    )
  })

  it('普通安装日志原样保留', () => {
    expect(redactLine('added 3 packages in 2s')).toBe('added 3 packages in 2s')
  })
})

describe('classifyUpdateOutcome（U11）', () => {
  it('复验版本等于目标版本 → updated', () => {
    const decision = classifyUpdateOutcome({
      exitCode: 0,
      beforeVersion: '1.5.2',
      afterVersion: '1.6.0',
      targetVersion: '1.6.0'
    })
    expect(decision.outcome).toBe('updated')
    expect(decision.message).toContain('1.6.0')
  })

  it('版本确实变化（未及目标）→ updated', () => {
    const decision = classifyUpdateOutcome({
      exitCode: 0,
      beforeVersion: '1.5.2',
      afterVersion: '1.5.9',
      targetVersion: '1.6.0'
    })
    expect(decision.outcome).toBe('updated')
    expect(decision.message).toContain('1.5.2')
    expect(decision.message).toContain('1.5.9')
  })

  it('版本没变 → pendingRestart（正常结局，不是失败）', () => {
    const decision = classifyUpdateOutcome({
      exitCode: 0,
      beforeVersion: '1.5.2',
      afterVersion: '1.5.2',
      targetVersion: '1.6.0'
    })
    expect(decision.outcome).toBe('pendingRestart')
    expect(decision.note).toContain('PATH')
  })

  it('非 0 退出码 → failed（哪怕版本变了）', () => {
    const decision = classifyUpdateOutcome({
      exitCode: 1,
      beforeVersion: '1.5.2',
      afterVersion: '1.6.0',
      targetVersion: '1.6.0'
    })
    expect(decision.outcome).toBe('failed')
    expect(decision.message).toContain('退出码 1')
  })

  it('取消优先于其它判定', () => {
    const decision = classifyUpdateOutcome({
      exitCode: 0,
      canceled: true,
      beforeVersion: '1.5.2',
      afterVersion: '1.6.0',
      targetVersion: '1.6.0'
    })
    expect(decision.outcome).toBe('failed')
    expect(decision.message).toContain('已取消')
  })
})

describe('parseLatestVersionPayload / extractManualCommand', () => {
  it('接受三段式版本（可带 v 前缀与预发布后缀）', () => {
    expect(parseLatestVersionPayload({ version: 'v1.6.0' })?.version).toBe('1.6.0')
    expect(parseLatestVersionPayload({ version: '1.6.0-beta.1' })?.version).toBe('1.6.0-beta.1')
    expect(parseLatestVersionPayload({ version: '1.6.0', packageName: 'p' })).toMatchObject({
      version: '1.6.0',
      packageName: 'p'
    })
  })

  it('拒绝缺失/非 semver 的 version', () => {
    expect(parseLatestVersionPayload({})).toBeUndefined()
    expect(parseLatestVersionPayload({ version: 'latest' })).toBeUndefined()
    expect(parseLatestVersionPayload({ version: 1.6 })).toBeUndefined()
    expect(parseLatestVersionPayload(null)).toBeUndefined()
    expect(parseLatestVersionPayload('1.6.0')).toBeUndefined()
  })

  it('从输出里挖出手动更新命令', () => {
    const output = [
      'pi cannot self-update this installation.',
      'PI_SELF_UPDATE_COMMAND: npm i -g @earendil-works/pi-coding-agent@latest'
    ].join('\n')
    expect(extractManualCommand(output)).toBe('npm i -g @earendil-works/pi-coding-agent@latest')
    expect(extractManualCommand('没有任何指引')).toBeUndefined()
  })
})

/* ================================================================== *
 * 检测 check() U1 - U7
 * ================================================================== */

describe('check：版本检测', () => {
  it('U1 远端 1.6.0 / 本机 1.5.2 → available（source pi.dev，checkedAt 精确）', async () => {
    const harness = createHarness({ localVersion: '1.5.2', remote: { version: '1.6.0' } })
    const result = await harness.service.check()

    expect(result).toMatchObject({
      state: 'available',
      currentVersion: '1.5.2',
      latestVersion: '1.6.0',
      source: 'pi.dev',
      checkedAt: FIXED_NOW
    })
    expect(result.error).toBeUndefined()
    // 只请求固定更新源，且是"小 JSON 探针"预算
    expect(harness.requestCalls).toHaveLength(1)
    expect(harness.requestCalls[0]?.url.toString()).toBe(LATEST_VERSION_URL)
    expect(harness.requestCalls[0]?.opts).toEqual(EXPECTED_CHECK_OPTS)
    // 成功结论必须落缓存
    expect(harness.cache.value?.latestVersion).toBe('1.6.0')
  })

  it('U2 版本相等 → upToDate', async () => {
    const harness = createHarness({ localVersion: '1.5.2', remote: { version: '1.5.2' } })
    const result = await harness.service.check()

    expect(result.state).toBe('upToDate')
    expect(result.latestVersion).toBe('1.5.2')
    expect(result.source).toBe('pi.dev')
  })

  it('U3 远端低于本机 → 不误报 available，并在 note 里说明', async () => {
    const harness = createHarness({ localVersion: '1.5.2', remote: { version: '1.4.0' } })
    const result = await harness.service.check()

    expect(result.state).toBe('upToDate')
    expect(result.latestVersion).toBe('1.4.0')
    expect(result.note).toContain('远端版本低于本机')
  })

  it('U4 requestJson 抛错 → unknown，不抛异常，带 error（小探针会重试一次）', async () => {
    const harness = createHarness({ remote: new Error('offline') })
    const result = await harness.service.check()

    expect(result.state).toBe('unknown')
    expect(result.source).toBe('pi.dev')
    expect(result.checkedAt).toBe(FIXED_NOW)
    expect(result.error).toContain('offline')
    // CHECK_ATTEMPTS = 2：瞬时抖动不该让 UI 直接"查不到"
    expect(harness.requestCalls).toHaveLength(2)
  })

  it('U5 非法 payload（无 version / 非 semver）→ unknown', async () => {
    const emptyPayload = createHarness({ remote: {} })
    const emptyResult = await emptyPayload.service.check()
    expect(emptyResult.state).toBe('unknown')
    expect(emptyResult.error).toContain('响应格式不正确')
    expect(emptyResult.latestVersion).toBeUndefined()

    const badVersion = createHarness({ remote: { version: 'latest' } })
    const badResult = await badVersion.service.check()
    expect(badResult.state).toBe('unknown')
    expect(badResult.error).toContain('响应格式不正确')
  })

  it('U5b 响应超过体积上限（模拟 requestJson 报错）→ unknown', async () => {
    const harness = createHarness({ remote: new Error('响应超过 8192 B') })
    const result = await harness.service.check()

    expect(result.state).toBe('unknown')
    expect(result.error).toContain('8192')
  })

  it('U6 无 pi（locatePi 返回 undefined）→ unknown + note', async () => {
    const harness = createHarness({ localVersion: 'missing', remote: { version: '1.6.0' } })
    const result = await harness.service.check()

    expect(result.state).toBe('unknown')
    expect(result.currentVersion).toBeUndefined()
    expect(result.error).toContain('尚未定位 pi')
    expect(result.note).toContain('尚未定位 pi')
  })

  it('U7 成功写缓存后第二次失败 → source cache，保留缓存里的 checkedAt', async () => {
    let clock = new Date(FIXED_NOW)
    let online = true
    const harness = createHarness({
      localVersion: '1.5.2',
      now: () => clock,
      remote: () =>
        online ? Promise.resolve({ version: '1.6.0' }) : Promise.reject(new Error('offline again'))
    })

    const first = await harness.service.check()
    expect(first).toMatchObject({ state: 'available', checkedAt: FIXED_NOW })
    expect(harness.cache.value?.checkedAt).toBe(FIXED_NOW)

    online = false
    clock = new Date('2026-01-03T00:00:00.000Z')
    const second = await harness.service.check()

    expect(second.source).toBe('cache')
    // 保留"上次成功检测"的时间，UI 才能提示"多久前查的"
    expect(second.checkedAt).toBe(FIXED_NOW)
    expect(second.state).toBe('available')
    expect(second.latestVersion).toBe('1.6.0')
    expect(second.error).toContain('offline again')
    expect(second.note).toContain('本次检测失败')
  })

  it('U8b env 覆盖成非环回 http → 直接拒绝且不发请求', async () => {
    const harness = createHarness({
      env: { PI_DESKTOP_UPDATE_CHECK_URL: 'http://evil.com/latest' }
    })
    const result = await harness.service.check()

    expect(result.state).toBe('unknown')
    expect(result.error).toContain('更新源地址不被允许')
    expect(harness.requestCalls).toHaveLength(0)
  })

  it('U8c env 覆盖成本机 http（e2e 场景）→ 放行', async () => {
    const harness = createHarness({
      env: { PI_DESKTOP_UPDATE_CHECK_URL: 'http://127.0.0.1:4321/latest' },
      remote: { version: '1.6.0' }
    })
    const result = await harness.service.check()

    expect(result.state).toBe('available')
    expect(harness.requestCalls[0]?.url.toString()).toBe('http://127.0.0.1:4321/latest')
  })
})

/* ================================================================== *
 * 执行 apply() U12 - U17
 * ================================================================== */

describe('apply：执行 pi update', () => {
  it('U12 spawnPi 收到的 argv 严格等于 [update]；force 时为 [update, --force]', async () => {
    const plain = createHarness({ versions: ['1.5.2', '1.5.2'] })
    const plainOutcome = await runApply(plain, {}, (child) => {
      child.exit(0)
    })
    expect(plainOutcome.accepted).toBe(true)
    expect(plain.spawnCalls).toHaveLength(1)
    expect(plain.spawnCalls[0]?.argv).toEqual(['update'])
    // 启动描述原样传递（prefixArgs / commandLine 由服务内部处理）
    expect(plain.spawnCalls[0]?.spec).toEqual(SPEC)

    const forced = createHarness({ versions: ['1.5.2', '1.5.2'] })
    await runApply(forced, { force: true }, (child) => {
      child.exit(0)
    })
    expect(forced.spawnCalls).toHaveLength(1)
    expect(forced.spawnCalls[0]?.argv).toEqual(['update', '--force'])
  })

  it('U13 有活跃会话且未传 disposeSessions → session-busy，且不 spawn', async () => {
    const harness = createHarness({ sessions: ['s1', 's2'] })
    const outcome = await harness.service.apply({})

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('session-busy')
    expect(rejected.sessionKeys).toEqual(['s1', 's2'])
    expect(rejected.message).toContain('2 个会话')
    // 关键：一个子进程都不能起
    expect(harness.spawnCalls).toHaveLength(0)
    expect(harness.order).not.toContain('spawn')
    expect(harness.service.isRunning()).toBe(false)
  })

  it('U14 disposeSessions: true → 先 disposeAllSessions() 再 spawn', async () => {
    const harness = createHarness({ sessions: ['s1'], versions: ['1.5.2', '1.6.0'] })
    const outcome = await runApply(harness, { disposeSessions: true }, (child) => {
      child.exit(0)
    })

    expect(outcome.accepted).toBe(true)
    expect(harness.disposeCalls).toBe(1)
    expect(harness.spawnCalls).toHaveLength(1)
    expect(harness.order.indexOf('dispose')).toBeLessThan(harness.order.indexOf('spawn'))
  })

  it('U15 并发：第一次未结束时第二次 apply → busy，spawn 计数仍为 1', async () => {
    const harness = createHarness({ versions: ['1.5.2', '1.5.2'] })
    const first = harness.service.apply({})
    await waitFor(() => harness.children.length === 1, '第一次 apply 启动子进程')
    expect(harness.service.isRunning()).toBe(true)

    const second = await harness.service.apply({})
    const rejected = expectRejected(second)
    expect(rejected.reason).toBe('busy')
    expect(harness.spawnCalls).toHaveLength(1)

    firstChild(harness).exit(0)
    const firstOutcome = await first
    expect(firstOutcome.accepted).toBe(true)
    // 结束后锁释放，可以再次执行
    expect(harness.service.isRunning()).toBe(false)
    expect(harness.service.activeJobId()).toBeUndefined()
  })

  it('U16 输出含 "pi cannot self-update this installation." → unavailable + manualCommand', async () => {
    const harness = createHarness({ versions: ['1.5.2'] })
    const outcome = await runApply(harness, {}, (child) => {
      child.stdout(
        [
          '\u001b[31mpi cannot self-update this installation.\u001b[0m',
          'PI_SELF_UPDATE_COMMAND: npm i -g @earendil-works/pi-coding-agent@latest',
          ''
        ].join('\n')
      )
      child.exit(1)
    })

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('unavailable')
    expect(rejected.message).toContain('不支持自动更新')
    expect(rejected.manualCommand).toBe('npm i -g @earendil-works/pi-coding-agent@latest')
    // 日志尾部已剥 ANSI
    expect(rejected.logTail).toContain('pi cannot self-update this installation.')
    expect(rejected.logTail).not.toContain('\u001b[')
  })

  it('U17 事件序列：首条 started、末条 done，且同一 jobId', async () => {
    const harness = createHarness({ versions: ['1.5.2', '1.6.0'] })
    const conversation = harness.service
    const outcome = await runApply(harness, {}, (child) => {
      child.stdout('npm notice installed\n')
      child.exit(0)
    })

    expect(outcome.accepted).toBe(true)
    const phases = harness.events.map((event) => event.phase)
    expect(phases[0]).toBe('started')
    expect(phases[phases.length - 1]).toBe('done')
    expect(phases).toContain('log')
    expect(harness.events[0]?.message).toContain('pi update')

    const jobId = harness.events[0]?.jobId
    expect(jobId).toBeDefined()
    for (const event of harness.events) expect(event.jobId).toBe(jobId)
    expect(conversation.activeJobId()).toBeUndefined()
  })

  it('U17b 失败终态用 failed 相位；版本未变 → pendingRestart', async () => {
    const pendingHarness = createHarness({ versions: ['1.5.2', '1.5.2'] })
    const pendingOutcome = await runApply(pendingHarness, {}, (child) => {
      child.exit(0)
    })
    expect(pendingOutcome.accepted).toBe(true)
    if (pendingOutcome.accepted) {
      expect(pendingOutcome.result.outcome).toBe('pendingRestart')
      expect(pendingOutcome.result.beforeVersion).toBe('1.5.2')
      expect(pendingOutcome.result.afterVersion).toBe('1.5.2')
      expect(pendingOutcome.result.message).toContain('PATH')
    }
    const pendingPhases = pendingHarness.events.map((event) => event.phase)
    expect(pendingPhases[pendingPhases.length - 1]).toBe('done')

    const failedHarness = createHarness({ versions: ['1.5.2'] })
    const failedOutcome = await runApply(failedHarness, {}, (child) => {
      child.stderr('npm ERR! code EACCES\n')
      child.exit(1)
    })
    expect(failedOutcome.accepted).toBe(true)
    if (failedOutcome.accepted) {
      expect(failedOutcome.result.outcome).toBe('failed')
      expect(failedOutcome.result.logTail).toContain('npm ERR! code EACCES')
    }
    const failedPhases = failedHarness.events.map((event) => event.phase)
    expect(failedPhases[failedPhases.length - 1]).toBe('failed')
    // 失败时不做版本复验（locatePi 只被 gate 用了一次）
    expect(failedOutcome.accepted && failedOutcome.result.afterVersion).toBeFalsy()
  })

  it('U18 spawn 前 gate 失败（未定位 pi）→ not-located，且不 spawn', async () => {
    const harness = createHarness({ launch: 'missing' })
    const outcome = await harness.service.apply({})

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('not-located')
    expect(harness.spawnCalls).toHaveLength(0)
  })

  it('U19a 执行中取消 → SIGTERM，2s 后 SIGKILL；结果 failed 且含「已取消」，锁释放', async () => {
    // 只 fake setTimeout/clearTimeout：waitFor 靠 setImmediate 让出微任务，不能被 fake
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const harness = createHarness({ versions: ['1.5.2'], childPid: null })
      const pending = harness.service.apply({})
      await waitFor(() => harness.children.length === 1, 'spawn pi update')
      const child = firstChild(harness)

      expect(harness.service.isRunning()).toBe(true)
      harness.service.cancel()
      // 宽限期内只发 SIGTERM（给 npm 收尾机会），不立刻 SIGKILL
      expect(child.kills).toEqual(['SIGTERM'])

      vi.advanceTimersByTime(2_000)
      expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])

      // 进程真正退出后 apply 才收敛：取消是「已受理」，但不是「安装成功」
      child.exit(null, 'SIGTERM')
      const outcome = await pending
      expect(outcome.accepted).toBe(true)
      if (!outcome.accepted) throw new Error('取消后应返回 accepted:true 的执行结果')
      expect(outcome.result.outcome).toBe('failed')
      expect(outcome.result.message).toContain('已取消')
      expect(outcome.result.message).toContain('重跑')
      // 终态相位是 canceled（不是 done），UI 不会谎报成功
      expect(harness.events[harness.events.length - 1]?.phase).toBe('canceled')
      expect(harness.service.isRunning()).toBe(false)
      expect(harness.service.activeJobId()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('U19b 无任务时 cancel() 幂等：不抛错、不 spawn、不推事件', () => {
    const harness = createHarness()
    expect(harness.service.isRunning()).toBe(false)
    expect(() => {
      harness.service.cancel()
    }).not.toThrow()
    harness.service.cancel()
    expect(harness.service.isRunning()).toBe(false)
    expect(harness.spawnCalls).toHaveLength(0)
    expect(harness.events).toHaveLength(0)
  })
})
