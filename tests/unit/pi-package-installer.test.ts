import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPiPackageInstaller,
  validatePackageSource
} from '../../src/main/services/pi-package-installer'
import type {
  PackageSourceDecision,
  PiPackageInstaller,
  PiPackageInstallerDeps,
  PiPackageInstallOutcome
} from '../../src/main/services/pi-package-installer'
import type {
  RequestJsonOptions,
  SpawnExitInfo,
  SpawnHandle
} from '../../src/main/services/pi-update'
import type { PiLaunchSpec } from '../../src/main/transport/types'
import type {
  PkgInstallEvent,
  PkgInstallResult,
  PkgPreview
} from '../../src/shared/contracts/packages'

/**
 * 插件安装器（A37 阶段 2b）单测。
 *
 * 全部跑真实的 `createPiPackageInstaller`，只替换边界依赖：
 * `requestJson`（不联网）/ `spawnPi`（不 spawn 真实进程）/ `readTextFile`（不读真实磁盘）/
 * `locatePi` `launchPi` `isUpdating` `emit` `now` `env`。
 *
 * 覆盖四组：
 * 1. `validatePackageSource`：合法形态、注入/越权拒绝、路径与 host 边界；
 * 2. `preview`：registry 命中 / 钉版本 / 网络失败不抛 / payload 缺字段的真实降级 / git 不可预读 / 非法输入抛错；
 * 3. `install`：argv 严格形态、exit 0 复验、失败带 logTail + manualCommand、各类拒绝零 spawn、
 *    单飞 busy、取消信号序列；
 * 4. 事件序列（started → log* → 终态，jobId 全程一致）。
 */

const FIXED_NOW = '2026-02-03T04:05:06.000Z'

/** 与主进程一致的预览探针预算（`PREVIEW_TIMEOUT_MS` / `PREVIEW_MAX_BYTES`） */
const EXPECTED_PREVIEW_OPTS: RequestJsonOptions = { timeoutMs: 8_000, maxBytes: 1024 * 1024 }

const SPEC: PiLaunchSpec = {
  command: 'C:\\fake\\pi.exe',
  prefixArgs: [],
  displayPath: 'C:\\fake\\pi.exe',
  launchKind: 'direct'
}

/** 假 agentDir（用 join 拼，跨平台与实现里的 join 保持一致） */
const AGENT_DIR = join('fake', 'agent')
const SETTINGS_PATH = join(AGENT_DIR, 'settings.json')
const PKG_DIR = join(AGENT_DIR, 'npm', 'node_modules', 'foo')
const PKG_MANIFEST_PATH = join(PKG_DIR, 'package.json')

type RemoteFn = (url: URL, opts: RequestJsonOptions) => Promise<unknown>

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

/**
 * `pid` 恒为 `undefined`：`killJob` 在 win32 上会按数字 pid 补一发
 * `taskkill /T /F`，测试里绝不能把它打到一个真实存在的进程上。
 */
function createFakeChild(): FakeChild {
  const stdoutListeners: ((chunk: string) => void)[] = []
  const stderrListeners: ((chunk: string) => void)[] = []
  const errorListeners: ((error: Error) => void)[] = []
  const exitListeners: ((info: SpawnExitInfo) => void)[] = []
  const kills: NodeJS.Signals[] = []

  const handle: SpawnHandle = {
    pid: undefined,
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
  /** `'missing'` = 定位不到 pi */
  locate?: 'ok' | 'missing'
  /** 启动描述；`'missing'` = 拿不到 */
  launch?: PiLaunchSpec | 'missing'
  /** `isUpdating()` 的返回值 */
  updating?: boolean
  /** registry 响应：对象 / Error / 自定义函数 */
  remote?: unknown
  /** 假磁盘内容（路径 → 文本）；读不到一律 ENOENT */
  files?: readonly (readonly [string, string])[]
}

interface Harness {
  service: PiPackageInstaller
  /** `spawnPi` 的入参（严格断言 argv 用） */
  spawnCalls: { spec: PiLaunchSpec; argv: string[] }[]
  /** `requestJson` 的入参 */
  requestCalls: { url: URL; opts: RequestJsonOptions }[]
  events: PkgInstallEvent[]
  children: FakeChild[]
  files: Map<string, string>
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: PkgInstallEvent[] = []
  const spawnCalls: { spec: PiLaunchSpec; argv: string[] }[] = []
  const requestCalls: { url: URL; opts: RequestJsonOptions }[] = []
  const children: FakeChild[] = []
  const files = new Map<string, string>(options.files ?? [])

  const deps: PiPackageInstallerDeps = {
    locatePi: () =>
      options.locate === 'missing'
        ? Promise.resolve(undefined)
        : Promise.resolve({ command: SPEC.command, version: '1.6.0' }),
    launchPi: () =>
      Promise.resolve(options.launch === 'missing' ? undefined : (options.launch ?? SPEC)),
    spawnPi: (spec, argv) => {
      const child = createFakeChild()
      children.push(child)
      spawnCalls.push({ spec, argv: [...argv] })
      return child.handle
    },
    readTextFile: (path) => {
      const content = files.get(path)
      if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
      return Promise.resolve(content)
    },
    agentDir: () => AGENT_DIR,
    emit: (event) => {
      events.push(event)
    },
    isUpdating: () => options.updating === true,
    requestJson: (url, opts) => {
      requestCalls.push({ url, opts })
      const remote = options.remote
      if (remote instanceof Error) return Promise.reject(remote)
      if (typeof remote === 'function') return (remote as RemoteFn)(url, opts)
      return Promise.resolve(remote ?? {})
    },
    env: {},
    now: () => new Date(FIXED_NOW)
  }

  return {
    service: createPiPackageInstaller(deps),
    spawnCalls,
    requestCalls,
    events,
    children,
    files
  }
}

/** 让出微任务，直到条件成立（install 内部有多次 await，不能只 flush 一次） */
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
  if (child === undefined) throw new Error('尚未 spawn pi install')
  return child
}

function expectAccepted(outcome: PiPackageInstallOutcome): PkgInstallResult {
  if (!outcome.accepted) {
    throw new Error(`期望被受理，实际被拒绝：${outcome.reason} / ${outcome.message}`)
  }
  return outcome.result
}

function expectRejected(
  outcome: PiPackageInstallOutcome
): Extract<PiPackageInstallOutcome, { accepted: false }> {
  if (outcome.accepted) {
    throw new Error(`期望被拒绝，实际完成：${outcome.result.outcome}`)
  }
  return outcome
}

/** 跑一次 install：等到 spawn 后用 `drive` 驱动假子进程，最后等结果 */
async function runInstall(
  harness: Harness,
  source: string,
  drive: (child: FakeChild) => void
): Promise<PiPackageInstallOutcome> {
  const pending = harness.service.install(source)
  await waitFor(() => harness.children.length > 0, 'spawn pi install')
  drive(firstChild(harness))
  return await pending
}

/** 一个"已登记 + 有清单"的成功场景磁盘内容 */
function successFiles(source = 'npm:foo', version = '1.2.3'): (readonly [string, string])[] {
  return [
    [SETTINGS_PATH, JSON.stringify({ packages: [{ source }] })],
    [PKG_MANIFEST_PATH, JSON.stringify({ name: 'foo', version })]
  ]
}

function acceptedSource(raw: string): Extract<PackageSourceDecision, { ok: true }> {
  const decision = validatePackageSource(raw)
  if (!decision.ok) throw new Error(`期望合法：${raw} → ${decision.reason}`)
  return decision
}

afterEach(() => {
  vi.useRealTimers()
})

/* ================================================================== *
 * A. validatePackageSource（纯函数）
 * ================================================================== */

describe('validatePackageSource：合法源（A1）', () => {
  it('npm 三种形态放行，并给出 npmName / npmVersion', () => {
    const plain = acceptedSource('npm:pi-web-access')
    expect(plain.kind).toBe('npm')
    expect(plain.npmName).toBe('pi-web-access')
    expect(plain.npmVersion).toBeUndefined()

    const scoped = acceptedSource('npm:@scope/pkg')
    expect(scoped.kind).toBe('npm')
    // `@scope/` 的 `@` 不是版本分隔符（lastIndexOf('@') === 0）
    expect(scoped.npmName).toBe('@scope/pkg')
    expect(scoped.npmVersion).toBeUndefined()

    const pinned = acceptedSource('npm:@scope/pkg@1.2.3')
    expect(pinned.npmName).toBe('@scope/pkg')
    expect(pinned.npmVersion).toBe('1.2.3')
  })

  it('git 简写与 https 源都归类为 git，且 source 与输入逐字符相同', () => {
    for (const raw of [
      'git:github.com/user/repo',
      'git:github.com/user/repo@v1.0.0',
      'https://github.com/user/repo',
      'https://github.com/user/repo.git#main'
    ]) {
      const decision = acceptedSource(raw)
      expect(decision.kind).toBe('git')
      // 下游只允许用返回值里的 source 去 spawn
      expect(decision.source).toBe(raw)
    }
  })
})

describe('validatePackageSource：拒绝注入与越权（A2）', () => {
  it('shell 元字符 / 展开 / 控制字符一律拒绝', () => {
    const cases = [
      'npm:foo; rm -rf /',
      'npm:foo | cat',
      'npm:foo\necho',
      'npm:$(whoami)',
      'npm:|foo',
      'npm:`id`',
      'npm:foo bar',
      'npm:foo&bar',
      'npm:foo>out'
    ]
    for (const raw of cases) {
      const decision = validatePackageSource(raw)
      expect(decision.ok, `应拒绝：${JSON.stringify(raw)}`).toBe(false)
    }
  })

  it('以 - 开头（伪装 CLI 开关）与路径段穿越一律拒绝', () => {
    for (const raw of ['--force', '-l', 'npm:../../etc/passwd', '../x']) {
      const decision = validatePackageSource(raw)
      expect(decision.ok, `应拒绝：${jsonOrRaw(raw)}`).toBe(false)
    }
  })

  it('长度上限与首尾空白（校验与执行必须是同一个字符串）', () => {
    const tooLong = validatePackageSource('a'.repeat(513))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toContain('512')

    const leadingSpace = validatePackageSource(' npm:foo')
    expect(leadingSpace.ok).toBe(false)
    if (!leadingSpace.ok) expect(leadingSpace.reason).toContain('空白')

    const trailing = validatePackageSource('npm:foo ')
    expect(trailing.ok).toBe(false)

    const empty = validatePackageSource('   ')
    expect(empty.ok).toBe(false)
  })

  it('未知 host / 非 https / 带凭据端口查询 / 非法路径一律拒绝', () => {
    for (const raw of [
      'git:evil.com/u/r',
      'https://evil.com/u/r',
      'https://github.com',
      'https://github.com/u',
      'https://github.com/u/r/extra/path',
      'https://user:pass@github.com/u/r',
      'https://github.com:8443/u/r',
      'https://github.com/u/r?x=1',
      'https://127.0.0.1/u/r'
    ]) {
      const decision = validatePackageSource(raw)
      expect(decision.ok, `应拒绝：${raw}`).toBe(false)
    }
  })

  it('本地路径 / ssh / file / 盘符 / ~ 形式一律拒绝（依赖运行上下文，无法可靠校验）', () => {
    for (const raw of [
      'ssh://git@github.com/u/r',
      'git@github.com:u/r',
      './local',
      'C:\\x',
      '~/x',
      'file:///etc/passwd'
    ]) {
      const decision = validatePackageSource(raw)
      expect(decision.ok, `应拒绝：${raw}`).toBe(false)
    }
  })
})

/** 控制字符/换行在报错里不好看，统一转义一下；普通字符串原样返回 */
function jsonOrRaw(raw: string): string {
  return JSON.stringify(raw)
}

describe('validatePackageSource：git ref 的真实行为（A3）', () => {
  it('git 简写的 @ref 允许斜杠（真实实现放行，见备注）', () => {
    const decision = acceptedSource('git:github.com/user/repo@ref/with/slash')
    expect(decision.kind).toBe('git')
    expect(decision.source).toBe('git:github.com/user/repo@ref/with/slash')
  })

  it('https 的 #ref 允许斜杠', () => {
    const decision = acceptedSource('https://github.com/user/repo#feature/foo')
    expect(decision.kind).toBe('git')
  })

  it('ref 含非法字符（如空白）时被前置换行/空白规则拒掉', () => {
    expect(validatePackageSource('git:github.com/user/repo@ref with space').ok).toBe(false)
  })
})

/* ================================================================== *
 * B. preview
 * ================================================================== */

describe('preview（B）', () => {
  it('B1 npm 源成功：origin npm-registry，repository 去掉 git+ 与 .git', async () => {
    const harness = createHarness({
      remote: {
        'dist-tags': { latest: '1.2.3' },
        description: 'desc',
        repository: { url: 'git+https://github.com/a/b.git' }
      }
    })

    const preview: PkgPreview = await harness.service.preview('npm:foo')

    expect(preview.origin).toBe('npm-registry')
    expect(preview.kind).toBe('npm')
    expect(preview.source).toBe('npm:foo')
    // payload 里没有 name → 回落成包名
    expect(preview.name).toBe('foo')
    expect(preview.version).toBe('1.2.3')
    expect(preview.description).toBe('desc')
    expect(preview.repository).toBe('https://github.com/a/b')
    expect(preview.error).toBeUndefined()

    expect(harness.requestCalls).toHaveLength(1)
    expect(harness.requestCalls[0]?.url.toString()).toBe('https://registry.npmjs.org/foo')
    expect(harness.requestCalls[0]?.opts).toEqual(EXPECTED_PREVIEW_OPTS)
  })

  it('B2 用户钉版本：带 requestedVersion，且请求地址不含版本', async () => {
    const harness = createHarness({
      remote: { 'dist-tags': { latest: '1.2.3' }, description: 'desc' }
    })

    const preview = await harness.service.preview('npm:foo@2.0.0')

    expect(preview.requestedVersion).toBe('2.0.0')
    expect(preview.version).toBe('1.2.3')
    expect(harness.requestCalls[0]?.url.toString()).toBe('https://registry.npmjs.org/foo')
  })

  it('B3 网络失败：origin none + error，且不抛错', async () => {
    const harness = createHarness({ remote: new Error('ECONNREFUSED') })

    const preview = await harness.service.preview('npm:foo')

    expect(preview.origin).toBe('none')
    expect(preview.error).toContain('ECONNREFUSED')
    expect(preview.version).toBeUndefined()
  })

  it('B4 响应缺 dist-tags：真实实现不报错，只是没有 version（不猜文案）', async () => {
    const harness = createHarness({ remote: { description: 'no tags here' } })

    const preview = await harness.service.preview('npm:foo')

    // 真实行为：parseNpmMetadata 返回空对象而不是 undefined，因此不算失败
    expect(preview.origin).toBe('npm-registry')
    expect(preview.version).toBeUndefined()
    expect(preview.error).toBeUndefined()
    expect(preview.name).toBe('foo')
  })

  it('B4b payload 不是 JSON 对象：origin none + 格式错误', async () => {
    const harness = createHarness({ remote: 'not-an-object' })

    const preview = await harness.service.preview('npm:foo')

    expect(preview.origin).toBe('none')
    expect(preview.error).toBeDefined()
    expect(preview.error ?? '').not.toBe('')
  })

  it('B5 git 源：origin none + 无法预读提示，不请求 registry', async () => {
    const harness = createHarness({ remote: { 'dist-tags': { latest: '1.2.3' } } })

    const preview = await harness.service.preview('git:github.com/u/r')

    expect(preview.origin).toBe('none')
    expect(preview.kind).toBe('git')
    expect(preview.error).toContain('git')
    expect(harness.requestCalls).toHaveLength(0)
  })

  it('B6 非法 source：preview 抛错（由 handler 映射成 VALIDATION）', async () => {
    const harness = createHarness()
    await expect(harness.service.preview('git:evil.com/u/r')).rejects.toThrow(/git/)
    await expect(harness.service.preview('--force')).rejects.toThrow(/-/)
    expect(harness.requestCalls).toHaveLength(0)
  })
})

/* ================================================================== *
 * C. install
 * ================================================================== */

describe('install：成功路径（C1）', () => {
  it('argv 严格为 [install, source]，复验 settings 后回传 installedPath / version', async () => {
    const harness = createHarness({ files: successFiles() })

    const outcome = await runInstall(harness, 'npm:foo', (child) => {
      child.stdout('added 1 package in 2s\n')
      child.exit(0)
    })

    const result = expectAccepted(outcome)
    expect(result.outcome).toBe('installed')
    expect(result.source).toBe('npm:foo')
    expect(result.kind).toBe('npm')
    expect(result.version).toBe('1.2.3')
    expect(result.installedPath).toBe(PKG_DIR)
    expect(result.message).toContain('已安装')

    // 绝不拼接、绝不追加 -l / -a / --force
    expect(harness.spawnCalls).toHaveLength(1)
    expect(harness.spawnCalls[0]?.argv).toEqual(['install', 'npm:foo'])
    expect(harness.spawnCalls[0]?.spec).toEqual(SPEC)
  })

  it('settings 里登记的是 https 形态时，npm/git 身份归一各自生效', async () => {
    const harness = createHarness({
      files: [
        [SETTINGS_PATH, JSON.stringify({ packages: ['https://github.com/u/r.git'] })],
        [
          join(AGENT_DIR, 'git', 'github.com', 'u', 'r', 'package.json'),
          JSON.stringify({ version: '0.1.0' })
        ]
      ]
    })

    const outcome = await runInstall(harness, 'https://github.com/u/r', (child) => {
      child.exit(0)
    })

    const result = expectAccepted(outcome)
    expect(result.outcome).toBe('installed')
    expect(result.kind).toBe('git')
    expect(result.version).toBe('0.1.0')
    expect(harness.spawnCalls[0]?.argv).toEqual(['install', 'https://github.com/u/r'])
  })
})

describe('install：失败路径（C2 / C3）', () => {
  it('C2 exit 0 但 settings 未出现该声明 → failed，message 提到 settings.json', async () => {
    const harness = createHarness({
      files: [[SETTINGS_PATH, JSON.stringify({ packages: [{ source: 'npm:other' }] })]]
    })

    const outcome = await runInstall(harness, 'npm:foo', (child) => {
      child.exit(0)
    })

    const result = expectAccepted(outcome)
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('settings.json')
    // 这个分支不带 logTail / manualCommand
    expect(result.logTail).toBeUndefined()
    expect(result.manualCommand).toBeUndefined()
  })

  it('C3 exit 1 + stderr → failed，logTail 含 stderr，manualCommand 以 pi install 开头', async () => {
    const harness = createHarness()

    const outcome = await runInstall(harness, 'npm:foo', (child) => {
      child.stderr('npm ERR! 404 Not Found\n')
      child.exit(1)
    })

    const result = expectAccepted(outcome)
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('1')
    expect(result.logTail).toContain('npm ERR! 404 Not Found')
    expect(result.manualCommand).toBe('pi install npm:foo')
    expect(result.manualCommand?.startsWith('pi install ')).toBe(true)
  })
})

describe('install：各类拒绝都零 spawn（C4 - C7）', () => {
  it('C4 locatePi 拿不到 → not-located', async () => {
    const harness = createHarness({ locate: 'missing' })
    const outcome = await harness.service.install('npm:foo')

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('not-located')
    expect(harness.spawnCalls).toHaveLength(0)
    expect(harness.events).toHaveLength(0)
    expect(harness.service.isRunning()).toBe(false)
  })

  it('C5 launchPi 拿不到 → not-located', async () => {
    const harness = createHarness({ launch: 'missing' })
    const outcome = await harness.service.install('npm:foo')

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('not-located')
    expect(harness.spawnCalls).toHaveLength(0)
    expect(harness.service.isRunning()).toBe(false)
  })

  it('C6 非法 source → invalid，零 spawn', async () => {
    const harness = createHarness()
    const outcome = await harness.service.install('npm:foo; rm -rf /')

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('invalid')
    expect(rejected.message).not.toBe('')
    expect(harness.spawnCalls).toHaveLength(0)
    expect(harness.spawnCalls).toHaveLength(0)
  })

  it('C7 pi 正在更新 → updating，零 spawn', async () => {
    const harness = createHarness({ updating: true })
    const outcome = await harness.service.install('npm:foo')

    const rejected = expectRejected(outcome)
    expect(rejected.reason).toBe('updating')
    expect(harness.spawnCalls).toHaveLength(0)
  })
})

describe('install：单飞与取消（C8 / C9）', () => {
  it('C8 并发：第一次未结束时第二次直接 busy，spawn 仍只有一次', async () => {
    const harness = createHarness({ files: successFiles() })

    const pending = harness.service.install('npm:foo')
    await waitFor(() => harness.children.length === 1, 'spawn pi install')
    expect(harness.service.isRunning()).toBe(true)

    const second = await harness.service.install('npm:foo')
    const rejected = expectRejected(second)
    expect(rejected.reason).toBe('busy')
    expect(harness.spawnCalls).toHaveLength(1)

    firstChild(harness).exit(0)
    const first = expectAccepted(await pending)
    expect(first.outcome).toBe('installed')
    expect(harness.service.isRunning()).toBe(false)
  })

  it('C9 取消：SIGTERM → 2s → SIGKILL，终态 canceled，锁释放', async () => {
    // 只 fake setTimeout/clearTimeout：waitFor 靠 setImmediate 让出微任务，不能被 fake
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const harness = createHarness()
      const pending = harness.service.install('npm:foo')
      await waitFor(() => harness.children.length === 1, 'spawn pi install')
      const child = firstChild(harness)

      expect(harness.service.isRunning()).toBe(true)
      harness.service.cancel()
      // 宽限期内只发 SIGTERM（给 npm 收尾机会），不立刻 SIGKILL
      expect(child.kills).toEqual(['SIGTERM'])

      vi.advanceTimersByTime(2_000)
      expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])

      // 进程真正退出后 install 才收敛
      child.exit(null, 'SIGTERM')
      const outcome = await pending
      const result = expectAccepted(outcome)
      expect(result.outcome).toBe('canceled')
      expect(result.message).toContain('已取消')
      expect(harness.events[harness.events.length - 1]?.phase).toBe('canceled')
      expect(harness.service.isRunning()).toBe(false)
      expect(harness.service.activeJobId()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('C9b 无任务时 cancel() 幂等：不抛错、不推事件、不 spawn', () => {
    const harness = createHarness()
    expect(harness.service.isRunning()).toBe(false)
    expect(() => {
      harness.service.cancel()
    }).not.toThrow()
    harness.service.cancel()
    expect(harness.events).toHaveLength(0)
    expect(harness.spawnCalls).toHaveLength(0)
  })
})

describe('install：事件序列（C10）', () => {
  it('首条 started、末条 done，jobId 全程一致，日志行来自 stdout/stderr', async () => {
    const harness = createHarness({ files: successFiles() })

    const pending = harness.service.install('npm:foo')
    await waitFor(() => harness.children.length === 1, 'spawn pi install')

    const jobId = harness.service.activeJobId()
    expect(jobId).toBeDefined()

    const child = firstChild(harness)
    child.stdout('cloning into npm:foo\n')
    child.stderr('warn: peer deps\n')
    child.exit(0)
    await pending

    const phases = harness.events.map((event) => event.phase)
    expect(phases[0]).toBe('started')
    expect(phases[phases.length - 1]).toBe('done')
    expect(phases).toContain('log')
    // 所有事件的 jobId 必须属于同一个任务
    expect(harness.events.every((event) => event.jobId === jobId)).toBe(true)

    const logLines = harness.events
      .filter((event) => event.phase === 'log')
      .map((event) => event.line ?? '')
    expect(logLines).toContain('cloning into npm:foo')
    expect(logLines).toContain('warn: peer deps')
  })
})
