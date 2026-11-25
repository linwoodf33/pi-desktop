import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname } from 'node:path'

import { piUpdateCheckResultSchema } from '../../shared/contracts/update'
import type {
  PiUpdateApplyInput,
  PiUpdateApplyResult,
  PiUpdateCheckResult,
  PiUpdateEvent
} from '../../shared/contracts/update'
import type { PiLaunchSpec } from '../transport/types'

import { compareVersions } from './pi-locator'

/**
 * pi 更新服务（A34）：`check`（只读检测）+ `apply`（执行 `pi update`）+ `cancel`。
 *
 * 为什么「检测」和「执行」必须是两件事（也见 `shared/contracts/update.ts` 的头注释）：
 * - `pi update` **没有 dry-run**，只要远端有新版就直接下载安装。想回答「有没有新版」
 *   只能自己去请求更新源；因此 `check()` 完全独立于 `apply()`，只读、不发任何子进程。
 * - 检测结论反过来**不能**当作「已装好」的证据：安装是否落地只能靠执行后重新读
 *   `pi --version`（`afterVersion`）复验，于是执行结果区分
 *   `updated` / `pendingRestart` / `failed`。
 *
 * 为什么必须「零活跃会话」才允许更新：更新过程会替换磁盘上的 pi 二进制/入口脚本，
 * 而活跃会话正持有那个子进程（Windows 上文件被占用时替换会失败或装出半个新版本）。
 * 所以默认要求先关会话；调用方显式传 `disposeSessions: true` 时由本服务负责先 dispose。
 *
 * 本文件的分层：
 * 1. 纯函数（可单测、无副作用）：`stripAnsi` / `redactLine` / `classifyUpdateOutcome` /
 *    `isAllowedCheckUrl` / `parseLatestVersionPayload` / 三处行清洗；
 * 2. 默认实现（可注入替换）：`defaultRequestJson`（node:https）、`defaultSpawnPi`、
 *    `createFileUpdateCache`；
 * 3. 服务本体：`createPiUpdateService`（单飞锁、gate、流式日志、超时/取消、终态判定）。
 */

/** 更新源（固定端点；renderer 不能指定，避免把主进程变成 SSRF 代理） */
export const LATEST_VERSION_URL = 'https://pi.dev/api/latest-version'

/** 单次检测的超时与体积上限：这是个"小 JSON 探针"，不是下载 */
const CHECK_TIMEOUT_MS = 5_000
const CHECK_MAX_BYTES = 8 * 1024
/** 检测失败时的总尝试次数（1 次重试） */
const CHECK_ATTEMPTS = 2

/** 整个 `pi update` 的总预算：再慢就该让用户自己开终端了 */
const APPLY_TIMEOUT_MS = 10 * 60 * 1000
/** 取消时的宽限期（SIGTERM → 2s → SIGKILL） */
const CANCEL_GRACE_MS = 2_000

/** 单行日志上限（IPC 里塞超长行没有意义） */
const MAX_LOG_LINE = 2_000
/** 安装日志只保留尾部，避免把整段 npm 输出搬进 IPC / 内存 */
const LOG_TAIL_LIMIT = 32 * 1024
/** `note` 字段的契约上限（`piUpdateCheckResultSchema`） */
const MAX_NOTE = 4_000

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/
/** 命中即整行脱敏：安装日志里偶尔会打印 registry token / 代理凭据 */
const SENSITIVE_LINE_RE = /api[_-]?key|token|secret|bearer\s+[A-Za-z0-9._-]{8,}/i
/** 凭证 URL：`https://user:pass@host/...` → `https://***@host/...` */
const CREDENTIAL_URL_RE = /(\/\/)[^\s/@:]+:[^\s/@]+@/g
/** pi 明确表示「这个安装不支持自更新」 */
const SELF_UPDATE_UNAVAILABLE_RE = /pi cannot self-update this installation/i

/* ------------------------------------------------------------------ *
 * 纯函数：清洗 / 脱敏 / 判定（单测直接吃这些）
 * ------------------------------------------------------------------ */

/**
 * 去掉 ANSI 控制符。
 *
 * 为什么必须做：更新过程走 `npm i -g`，其输出在有 TTY 暗示时带颜色码；这些字符
 * 进了 renderer 的纯文本日志会变成乱码，也会污染 `logTail` 里的关键字匹配。
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- 匹配 ANSI 转义符（U+001B）是这里的唯一目的
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * 单行脱敏。
 *
 * 策略是"宁可错杀"：命中敏感关键字就整行替换成 `[redacted]`，而不是只遮值 ——
 * 安装日志的格式不归我们控制，局部替换很容易漏掉（比如 `token: abc` 与 `token=abc`）。
 */
export function redactLine(line: string): string {
  const withoutCredentials = line.replace(CREDENTIAL_URL_RE, '$1***@')
  return SENSITIVE_LINE_RE.test(withoutCredentials) ? '[redacted]' : withoutCredentials
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** `http` 只在测试用的本机地址上放行（更新源本身必须是 https） */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

export type CheckUrlDecision = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * 校验更新源地址。
 *
 * 为什么单独成函数并允许 `allowLocalHttp`：e2e 需要一个本地 http 服务器喂假响应，
 * 但这条路只能通过 `PI_DESKTOP_UPDATE_CHECK_URL` 打开，且 **host 必须是 127.0.0.1 /
 * localhost**；其它任何 http 一律拒绝，且是"拒绝 + 不请求"，不是"请求后判断"。
 */
export function isAllowedCheckUrl(raw: string, allowLocalHttp = false): CheckUrlDecision {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: '地址格式不正确' }
  }
  if (url.protocol === 'https:') return { ok: true, url }
  if (url.protocol === 'http:') {
    if (!allowLocalHttp) return { ok: false, reason: '只允许 https 更新源' }
    if (!isLoopbackHost(url.hostname)) {
      return { ok: false, reason: 'http 仅允许 127.0.0.1 / localhost（测试用）' }
    }
    return { ok: true, url }
  }
  return { ok: false, reason: `不支持的协议：${url.protocol}` }
}

export interface LatestVersionPayload {
  version: string
  packageName?: string
  note?: string
}

/**
 * 解析更新源响应。
 *
 * `version` 必须严格是三段式（可带预发布/构建后缀），否则视为不可用 ——
 * 宁可 `unknown`，也不要把 `null` / `"latest"` 这种东西当版本号去比较。
 */
export function parseLatestVersionPayload(payload: unknown): LatestVersionPayload | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>

  const rawVersion = record['version']
  if (typeof rawVersion !== 'string') return undefined
  const version = rawVersion.trim().replace(/^v/i, '')
  if (!VERSION_RE.test(version)) return undefined

  const rawPackageName = record['packageName']
  const packageName =
    typeof rawPackageName === 'string' && rawPackageName.trim().length > 0
      ? rawPackageName.trim()
      : undefined

  const rawNote = record['note']
  const note =
    typeof rawNote === 'string' && rawNote.trim().length > 0
      ? truncateText(rawNote.trim(), MAX_NOTE)
      : undefined

  return {
    version,
    ...(packageName === undefined ? {} : { packageName }),
    ...(note === undefined ? {} : { note })
  }
}

export interface UpdateOutcomeInput {
  exitCode: number | null
  canceled?: boolean
  beforeVersion?: string
  afterVersion?: string
  targetVersion?: string
}

export interface UpdateOutcomeDecision {
  outcome: PiUpdateApplyResult['outcome']
  message: string
  /** 面向用户的补充说明（契约里没有独立字段，调用方需拼进 `message`） */
  note?: string
}

/**
 * 终态判定（纯函数，便于把「什么算更新成功」钉在测试里）。
 *
 * 判定顺序有讲究：
 * 1. 取消优先——被取消的安装可能只装了一半，不能因为版本恰好变了就报成功；
 * 2. 非 0 退出码即失败（哪怕版本变了也只当"部分生效"，交给用户重跑）；
 * 3. 只有"复验版本 == 目标版本"或"版本确实变了"才算 `updated`；
 * 4. 否则是 `pendingRestart` —— 这在 Windows 上极常见（PATH 里另一份 pi 抢先命中，
 *    或需要重开终端刷新 PATH），不是错误，所以不归入 `failed`。
 */
export function classifyUpdateOutcome(input: UpdateOutcomeInput): UpdateOutcomeDecision {
  if (input.canceled === true) {
    return { outcome: 'failed', message: '已取消；安装可能不完整，建议重跑一次' }
  }
  if (input.exitCode !== 0) {
    return {
      outcome: 'failed',
      message: `pi update 执行失败（退出码 ${String(input.exitCode)}）`
    }
  }

  const { beforeVersion, afterVersion, targetVersion } = input
  if (targetVersion !== undefined && afterVersion === targetVersion) {
    return { outcome: 'updated', message: `已更新到 ${targetVersion}` }
  }
  if (afterVersion !== undefined && afterVersion !== beforeVersion) {
    return {
      outcome: 'updated',
      message: `已更新：${beforeVersion ?? '未知版本'} → ${afterVersion}`
    }
  }

  return {
    outcome: 'pendingRestart',
    message: `已执行更新，但 pi --version 仍报告 ${afterVersion ?? '未知版本'}（期望 ${
      targetVersion ?? '更新源给出的版本'
    }）`,
    note: 'PATH 里可能有多份 pi 或需要重启终端'
  }
}

/** 从输出里挖出「请手动执行」的指引（pi 会在同一段输出里给 `PI_SELF_UPDATE_COMMAND`） */
export function extractManualCommand(output: string): string | undefined {
  const match = /PI_SELF_UPDATE_COMMAND\s*[:=]?\s*(.+)/i.exec(output)
  const command = match?.[1]?.trim()
  if (command === undefined || command.length === 0) return undefined
  return truncateText(command, 200)
}

/* ------------------------------------------------------------------ *
 * 依赖契约
 * ------------------------------------------------------------------ */

export interface SpawnExitInfo {
  code: number | null
  signal: string | null
}

/** 子进程句柄抽象（默认 `defaultSpawnPi`；单测注入 fake） */
export interface SpawnHandle {
  readonly pid: number | undefined
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  onError(listener: (error: Error) => void): void
  onExit(listener: (info: SpawnExitInfo) => void): void
  kill(signal: NodeJS.Signals): void
}

export interface RequestJsonOptions {
  timeoutMs: number
  maxBytes: number
}

export interface PiUpdateServiceDeps {
  /** 定位 pi 并取当前版本（默认用 pi-locator 的 `locate()` 适配） */
  locatePi(): Promise<{ command: string; version?: string } | undefined>
  /** 拿启动描述（pi-locator `launch()`）；拿不到说明 pi 未定位成功 */
  launchPi(): Promise<PiLaunchSpec | undefined>
  /** 活跃会话 key（非空则默认拒绝执行） */
  activeSessionKeys(): readonly string[]
  disposeAllSessions(): Promise<void>
  /** 推送事件（编排者接到 `evt:piUpdate`） */
  emit(event: PiUpdateEvent): void
  /**
   * HTTP GET JSON；省略则用 `defaultRequestJson`（node:https）。
   *
   * 写成属性箭头签名（而非方法简写）是刻意的：注入物会被取出再调用，
   * 方法简写会被 `@typescript-eslint/unbound-method` 判为「可能丢失 this」。
   */
  requestJson?: (url: URL, opts: RequestJsonOptions) => Promise<unknown>
  /** spawn；省略则用 `defaultSpawnPi`（node:child_process） */
  spawnPi?: (spec: PiLaunchSpec, argv: string[]) => SpawnHandle
  /** 检测缓存读取；省略则用进程内内存缓存 */
  readCache?: () => Promise<PiUpdateCheckResult | undefined>
  /** 检测缓存写入；省略则用进程内内存缓存 */
  writeCache?: (result: PiUpdateCheckResult) => Promise<void>
  /** 时间源（单测注入，便于断言 `checkedAt`） */
  now?: () => Date
  env?: NodeJS.ProcessEnv
}

export type PiUpdateRejectReason =
  'busy' | 'session-busy' | 'not-located' | 'unavailable' | 'failed'

export interface PiUpdateRejected {
  accepted: false
  reason: PiUpdateRejectReason
  message: string
  /** `session-busy` 时给出具体会话，便于 UI 提示"要关哪几个" */
  sessionKeys?: readonly string[]
  /** `unavailable` 时用户可手动执行的命令 */
  manualCommand?: string
  /** `unavailable` 时的日志尾部（诊断用） */
  logTail?: string
}

export interface PiUpdateCompleted {
  accepted: true
  result: PiUpdateApplyResult
}

/**
 * `apply` 的返回形态：**不用 `Result<T>`**，因为错误码属于 IPC 层。
 * 这里只给"可判信号"，由 handler 映射：
 * `busy → PI_UPDATE_BUSY`、`unavailable → PI_UPDATE_UNAVAILABLE`、
 * `not-located → PI_NOT_FOUND`、`session-busy → SESSION_BUSY`、`failed → INTERNAL`。
 */
export type PiUpdateApplyOutcome = PiUpdateCompleted | PiUpdateRejected

export interface PiUpdateService {
  /** 只读检测，永不抛错（任何失败都折成 `state: 'unknown'` + `error`） */
  check(): Promise<PiUpdateCheckResult>
  /** 执行更新；gates 通过后返回本次任务的结果 */
  apply(input: PiUpdateApplyInput): Promise<PiUpdateApplyOutcome>
  /** 取消（幂等；SIGTERM → 2s → SIGKILL，Windows 追加 taskkill /T /F） */
  cancel(): void
  isRunning(): boolean
  activeJobId(): string | undefined
}

/* ------------------------------------------------------------------ *
 * 默认实现：HTTP / spawn / 文件缓存
 * ------------------------------------------------------------------ */

/**
 * 默认 HTTP 实现：`node:https`（**不是** `fetch`）。
 *
 * 两个原因：静态安全规则会把"动态 URL 的 fetch"判为 SSRF sink；且 `fetch` 的 body
 * 大小不可中断，而这里必须能在超过 8KB 时立刻掐断。重定向最多 1 跳，且**每一跳**
 * 重新校验协议与 host（防 `https` 跳到内网或降级成 http）。
 */
export function defaultRequestJson(url: URL, opts: RequestJsonOptions): Promise<unknown> {
  const once = (target: URL, redirectLeft: number): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const transport = isAllowedCheckUrl(target.toString(), true)
      if (!transport.ok) {
        reject(new Error(`拒绝请求：${transport.reason}`))
        return
      }

      const client = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = client(
        target,
        { method: 'GET', headers: { accept: 'application/json' } },
        (response) => {
          const status = response.statusCode ?? 0

          if (status >= 300 && status < 400 && response.headers.location !== undefined) {
            response.resume()
            if (redirectLeft <= 0) {
              reject(new Error('重定向次数过多'))
              return
            }
            let next: URL
            try {
              next = new URL(response.headers.location, target)
            } catch {
              reject(new Error('重定向地址无效'))
              return
            }
            // 每一跳都重新过安全校验
            const check = isAllowedCheckUrl(next.toString(), true)
            if (!check.ok) {
              reject(new Error(`重定向被拒绝：${check.reason}`))
              return
            }
            once(next, redirectLeft - 1).then(resolve, reject)
            return
          }

          if (status < 200 || status >= 300) {
            response.resume()
            reject(new Error(`HTTP ${status}`))
            return
          }

          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > opts.maxBytes) {
              req.destroy()
              reject(new Error(`响应超过 ${opts.maxBytes} B`))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
            } catch {
              reject(new Error('响应不是合法 JSON'))
            }
          })
          response.on('error', (error: Error) => {
            reject(error)
          })
        }
      )

      req.setTimeout(Math.max(1_000, opts.timeoutMs), () => {
        req.destroy()
        reject(new Error(`请求超时（${opts.timeoutMs}ms）`))
      })
      req.on('error', (error: Error) => {
        reject(error)
      })
      req.end()
    })

  return once(url, 1)
}

/**
 * 默认 spawn：`shell: false` + 参数数组（零 shell 解析面）。
 *
 * 关于 `PiLaunchSpec`：它可能带 `prefixArgs`（如 `.cmd` 解析出的 node shim：
 * `command = node.exe`、`prefixArgs = [入口脚本]`），也可能带 `commandLine(args)`（只能
 * 经 `cmd.exe /d /s /c` 的兜底形态）。因此 `update` 必须追加在 **prefixArgs 之后**，
 * 并且在有 `commandLine` 时由它负责拼装 —— 与 `pi-locator.defaultRunCapture` 完全同构。
 */
export function defaultSpawnPi(spec: PiLaunchSpec, argv: string[]): SpawnHandle {
  const prefix = spec.prefixArgs ?? []
  const fullArgv =
    spec.commandLine !== undefined ? [...prefix, spec.commandLine(argv)] : [...prefix, ...argv]

  const child = spawn(spec.command, fullArgv, {
    shell: false,
    windowsHide: true,
    ...(spec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  return {
    pid: child.pid,
    onStdout: (listener) => {
      child.stdout?.on('data', (chunk: string) => {
        listener(chunk)
      })
    },
    onStderr: (listener) => {
      child.stderr?.on('data', (chunk: string) => {
        listener(chunk)
      })
    },
    onError: (listener) => {
      child.once('error', listener)
    },
    onExit: (listener) => {
      child.once('close', (code, signal) => {
        listener({ code, signal })
      })
    },
    kill: (signal) => {
      try {
        child.kill(signal)
      } catch {
        /* 进程可能已退出：忽略 */
      }
    }
  }
}

export interface UpdateCacheStore {
  read(): Promise<PiUpdateCheckResult | undefined>
  write(result: PiUpdateCheckResult): Promise<void>
}

/**
 * 文件缓存（默认路径由编排者传入 `<userData>/pi-update-check.json`）。
 *
 * 只在"本次检测失败"时才被读：它的作用是"离线时也能告诉用户上次查到什么"，
 * 而不是缓存结论来省请求。写入失败一律吞掉（缓存坏了不该让检测失败）。
 */
export function createFileUpdateCache(filePath: string): UpdateCacheStore {
  return {
    async read() {
      try {
        const text = await readFile(filePath, 'utf8')
        const parsed = piUpdateCheckResultSchema.safeParse(JSON.parse(text) as unknown)
        return parsed.success ? parsed.data : undefined
      } catch {
        /* 文件不存在 / 内容损坏：当作没有缓存 */
        return undefined
      }
    },
    async write(result) {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(result), 'utf8')
    }
  }
}

/* ------------------------------------------------------------------ *
 * 服务本体
 * ------------------------------------------------------------------ */

interface ActiveJob {
  readonly id: string
  canceled: boolean
  settled: boolean
  child?: SpawnHandle
  /** 已脱敏的行日志尾部（最多 32KB），终态时作为 `logTail` 交回 */
  tailBuffer: string
  timeoutTimer?: ReturnType<typeof setTimeout> | undefined
  killTimer?: ReturnType<typeof setTimeout> | undefined
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return {
    promise,
    resolve: (value: T) => {
      resolveFn(value)
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPiUpdateService(deps: PiUpdateServiceDeps): PiUpdateService {
  const env = deps.env ?? process.env
  const nowDate = deps.now ?? ((): Date => new Date())
  const requestJson = (url: URL, opts: RequestJsonOptions): Promise<unknown> =>
    deps.requestJson !== undefined ? deps.requestJson(url, opts) : defaultRequestJson(url, opts)
  const spawnPi = (spec: PiLaunchSpec, argv: string[]): SpawnHandle =>
    deps.spawnPi !== undefined ? deps.spawnPi(spec, argv) : defaultSpawnPi(spec, argv)

  // 缓存默认落在进程内（编排者通常会传 createFileUpdateCache(...) 持久化）
  let memoryCache: PiUpdateCheckResult | undefined
  const readCache = (): Promise<PiUpdateCheckResult | undefined> =>
    deps.readCache !== undefined ? deps.readCache() : Promise.resolve(memoryCache)
  const writeCache = (result: PiUpdateCheckResult): Promise<void> => {
    if (deps.writeCache !== undefined) return deps.writeCache(result)
    memoryCache = result
    return Promise.resolve()
  }

  /** 单飞：同一时刻只允许一个更新任务（不排队，直接拒绝） */
  let active: ActiveJob | undefined
  /** 上次检测到的最新版本：执行后复验用它当 `targetVersion` */
  let lastLatestVersion: string | undefined
  let jobSeq = 0

  function nextJobId(): string {
    jobSeq += 1
    return `update-${String(jobSeq)}-${String(Date.now())}`
  }

  function emitSafe(event: PiUpdateEvent): void {
    try {
      deps.emit(event)
    } catch {
      /* renderer 可能已销毁：事件丢失不影响任务本身 */
    }
  }

  async function locateSafe(): Promise<{ command: string; version?: string } | undefined> {
    try {
      return await deps.locatePi()
    } catch {
      /* 定位失败按"没有 pi"处理，由调用方决定怎么表达 */
      return undefined
    }
  }

  async function readCacheSafe(): Promise<PiUpdateCheckResult | undefined> {
    try {
      return await readCache()
    } catch {
      /* 缓存读不出来不算错误 */
      return undefined
    }
  }

  async function writeCacheSafe(result: PiUpdateCheckResult): Promise<void> {
    try {
      await writeCache(result)
    } catch {
      /* 缓存写失败不影响本次结论 */
    }
  }

  /** 检测请求：一次重试（瞬时网络抖动不该让 UI 直接变"查不到"） */
  async function requestWithRetry(url: URL): Promise<unknown> {
    const opts: RequestJsonOptions = { timeoutMs: CHECK_TIMEOUT_MS, maxBytes: CHECK_MAX_BYTES }
    let lastError: unknown
    for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt += 1) {
      try {
        return await requestJson(url, opts)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /* ---------------------------------------------------------------- *
   * 日志流
   * ---------------------------------------------------------------- */

  function emitLogLine(job: ActiveJob, raw: string): void {
    const cleaned = stripAnsi(raw).replace(/\r+$/, '')
    const redacted = redactLine(cleaned)
    const line = truncateText(redacted, MAX_LOG_LINE)
    // 空行不推给 renderer（npm 输出里大量空行只会把日志撑长）
    if (line.trim().length === 0) return

    job.tailBuffer += `${line}\n`
    if (job.tailBuffer.length > LOG_TAIL_LIMIT) {
      job.tailBuffer = job.tailBuffer.slice(-LOG_TAIL_LIMIT)
    }
    emitSafe({ jobId: job.id, phase: 'log', line })
  }

  /** 按行切分流式输出（chunk 边界可能落在一行中间，必须留 buffer） */
  function attachStream(
    job: ActiveJob,
    subscribe: (listener: (chunk: string) => void) => void
  ): void {
    let buffer = ''
    subscribe((chunk) => {
      buffer += chunk
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) emitLogLine(job, part)
    })
  }

  function tailOf(job: ActiveJob): string | undefined {
    const tail = job.tailBuffer.trimEnd()
    return tail.length === 0 ? undefined : truncateText(tail, LOG_TAIL_LIMIT)
  }

  function clearTimers(job: ActiveJob): void {
    if (job.timeoutTimer !== undefined) {
      clearTimeout(job.timeoutTimer)
      job.timeoutTimer = undefined
    }
    if (job.killTimer !== undefined) {
      clearTimeout(job.killTimer)
      job.killTimer = undefined
    }
  }

  /** 结束进程：先给 SIGTERM；Windows 上再补一刀 taskkill /T（杀掉 node shim 的子进程树） */
  function killJob(job: ActiveJob, signal: NodeJS.Signals): void {
    const child = job.child
    if (child === undefined) return
    try {
      child.kill(signal)
    } catch {
      /* 已退出 */
    }
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      try {
        // pid 只来自 spawn 句柄的数字；参数走数组、shell:false，不拼命令行
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        /* taskkill 不可用：SIGKILL 已经发了 */
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * check
   * ---------------------------------------------------------------- */

  async function check(): Promise<PiUpdateCheckResult> {
    const checkedAt = nowDate().toISOString()

    /**
     * 失败收敛：优先回落到缓存（`source: 'cache'`，`checkedAt` 保留缓存里的原值），
     * 没有缓存才给 `unknown`。这样 UI 既能显示"多久前查的"，也不会把
     * "查不到"误读成"有新版本"。
     */
    const failure = async (error: string, note?: string): Promise<PiUpdateCheckResult> => {
      const cached = await readCacheSafe()
      if (cached !== undefined) {
        const merged =
          cached.note === undefined
            ? `本次检测失败，展示上次检测结果：${error}`
            : `${cached.note}；本次检测失败：${error}`
        return {
          ...cached,
          source: 'cache',
          note: truncateText(merged, MAX_NOTE),
          error
        }
      }
      const located = await locateSafe()
      return {
        state: 'unknown',
        source: 'pi.dev',
        checkedAt,
        ...(located?.version === undefined ? {} : { currentVersion: located.version }),
        ...(note === undefined ? {} : { note: truncateText(note, MAX_NOTE) }),
        error
      }
    }

    try {
      const overrideRaw = (env['PI_DESKTOP_UPDATE_CHECK_URL'] ?? '').trim()
      const fromOverride = overrideRaw.length > 0
      // 测试开关：只有显式给了 env 覆盖时才可能放行本机 http
      const decision = isAllowedCheckUrl(
        fromOverride ? overrideRaw : LATEST_VERSION_URL,
        fromOverride
      )
      if (!decision.ok) return await failure(`更新源地址不被允许：${decision.reason}`)

      let payload: unknown
      try {
        payload = await requestWithRetry(decision.url)
      } catch (error) {
        return await failure(`检测更新失败：${describeError(error)}`)
      }

      const latest = parseLatestVersionPayload(payload)
      if (latest === undefined) {
        return await failure('更新源响应格式不正确（缺少合法的 version 字段）')
      }

      const located = await locateSafe()
      if (located === undefined || located.version === undefined) {
        return await failure(
          '尚未定位 pi',
          '尚未定位 pi：请先完成自检，或在设置里指定可执行文件路径'
        )
      }

      const currentVersion = located.version
      const comparison = compareVersions(latest.version, currentVersion)
      // 远端更旧（预发布/自建构建）也按"已是最新"处理，但要在 note 里说清楚
      const notes: string[] = []
      if (comparison < 0) notes.push('远端版本低于本机（预发布/自建构建），按已是最新处理')
      if (latest.note !== undefined) notes.push(latest.note)

      const state: PiUpdateCheckResult['state'] = comparison > 0 ? 'available' : 'upToDate'
      const result: PiUpdateCheckResult = {
        state,
        currentVersion,
        latestVersion: latest.version,
        source: 'pi.dev',
        checkedAt,
        ...(notes.length === 0 ? {} : { note: truncateText(notes.join('；'), MAX_NOTE) }),
        ...(latest.packageName === undefined ? {} : { packageName: latest.packageName })
      }

      if (state === 'available') lastLatestVersion = latest.version
      await writeCacheSafe(result)
      return result
    } catch (error) {
      // check 永不抛错：任何漏网异常都折成 unknown
      return await failure(`检测更新时发生异常：${describeError(error)}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * apply
   * ---------------------------------------------------------------- */

  async function apply(input: PiUpdateApplyInput): Promise<PiUpdateApplyOutcome> {
    // ① 单飞锁：先同步占位，避免"两次点击都过了 gate 再各自 spawn"
    if (active !== undefined) {
      return { accepted: false, reason: 'busy', message: '已有更新任务在执行' }
    }
    const job: ActiveJob = {
      id: nextJobId(),
      canceled: false,
      settled: false,
      tailBuffer: ''
    }
    active = job

    const release = (): void => {
      clearTimers(job)
      job.settled = true
      if (active === job) active = undefined
    }

    // ② gate：活跃会话。二进制可能正被占用，替换会失败或装出半个版本
    if (input.disposeSessions === true) {
      try {
        await deps.disposeAllSessions()
      } catch (error) {
        release()
        return {
          accepted: false,
          reason: 'failed',
          message: `结束现有会话失败，未执行更新：${describeError(error)}`
        }
      }
    } else {
      let keys: readonly string[]
      try {
        keys = deps.activeSessionKeys()
      } catch {
        keys = []
      }
      if (keys.length > 0) {
        release()
        return {
          accepted: false,
          reason: 'session-busy',
          message: `还有 ${String(keys.length)} 个会话在运行：请先结束会话，或允许自动结束后再更新`,
          sessionKeys: [...keys]
        }
      }
    }

    // ③ gate：定位 pi（拿启动描述 + beforeVersion）
    let spec: PiLaunchSpec | undefined
    let beforeVersion: string | undefined
    try {
      spec = await deps.launchPi()
      beforeVersion = (await locateSafe())?.version
    } catch (error) {
      release()
      return {
        accepted: false,
        reason: 'failed',
        message: `定位 pi 失败，未执行更新：${describeError(error)}`
      }
    }
    if (spec === undefined) {
      release()
      return {
        accepted: false,
        reason: 'not-located',
        message: '尚未定位 pi，无法执行更新（可先做一次自检，或在设置里指定可执行文件路径）'
      }
    }

    // 取消请求可能落在 gate 的 await 期间
    if (job.canceled) {
      release()
      return {
        accepted: false,
        reason: 'failed',
        message: '已取消；更新尚未开始'
      }
    }

    const targetVersion = lastLatestVersion
    // 参数只允许这两种形态：用布尔选数组，绝不字符串拼接（零注入面）
    const argv = input.force === true ? ['update', '--force'] : ['update']

    emitSafe({
      jobId: job.id,
      phase: 'started',
      message: `开始执行 pi ${argv.join(' ')}`
    })

    let handle: SpawnHandle
    try {
      handle = spawnPi(spec, argv)
    } catch (error) {
      release()
      const message = `无法启动 pi update：${describeError(error)}`
      emitSafe({ jobId: job.id, phase: 'failed', message })
      return { accepted: false, reason: 'failed', message }
    }
    job.child = handle

    const deferred = createDeferred<PiUpdateApplyOutcome>()
    const finish = (outcome: PiUpdateApplyOutcome): void => {
      if (job.settled) return
      release()
      deferred.resolve(outcome)
    }

    /** 统一收尾：把 beforeVersion / targetVersion / 日志尾部一起填进结果 */
    const buildResult = (
      outcome: PiUpdateApplyResult['outcome'],
      message: string,
      afterVersion: string | undefined
    ): PiUpdateApplyResult => {
      const logTail = tailOf(job)
      return {
        ...(beforeVersion === undefined ? {} : { beforeVersion }),
        ...(targetVersion === undefined ? {} : { targetVersion }),
        ...(afterVersion === undefined ? {} : { afterVersion }),
        outcome,
        message,
        ...(logTail === undefined ? {} : { logTail })
      }
    }

    // ④ 流式日志（stdout / stderr 同格式清洗后都推给 renderer）
    attachStream(job, (listener) => {
      handle.onStdout(listener)
    })
    attachStream(job, (listener) => {
      handle.onStderr(listener)
    })

    // ⑤ 总超时：卡死的 npm 不该把任务一直挂着
    job.timeoutTimer = setTimeout(() => {
      if (job.settled) return
      killJob(job, 'SIGKILL')
      const message = '更新超时（超过 10 分钟），已结束进程'
      emitSafe({ jobId: job.id, phase: 'failed', message })
      finish({ accepted: true, result: buildResult('failed', message, undefined) })
    }, APPLY_TIMEOUT_MS)
    job.timeoutTimer.unref?.()

    // ⑥ spawn 层错误（可执行文件不存在等）：不会再有 exit
    handle.onError((error) => {
      if (job.settled) return
      const message = `pi update 启动失败：${describeError(error)}`
      emitSafe({ jobId: job.id, phase: 'failed', message })
      finish({ accepted: false, reason: 'failed', message })
    })

    // ⑦ 终态
    handle.onExit((info) => {
      if (job.settled) return
      clearTimers(job)

      if (job.canceled) {
        const message = '已取消；安装可能不完整，建议重跑一次'
        emitSafe({ jobId: job.id, phase: 'canceled', message })
        finish({ accepted: true, result: buildResult('failed', message, undefined) })
        return
      }

      // 不支持自更新：要把手动命令原样交回用户（handler 映射 PI_UPDATE_UNAVAILABLE）
      if (SELF_UPDATE_UNAVAILABLE_RE.test(job.tailBuffer)) {
        const message = '当前安装不支持自动更新'
        const manualCommand = extractManualCommand(job.tailBuffer) ?? 'pi update'
        const logTail = tailOf(job)
        emitSafe({ jobId: job.id, phase: 'failed', message })
        finish({
          accepted: false,
          reason: 'unavailable',
          message,
          manualCommand,
          ...(logTail === undefined ? {} : { logTail })
        })
        return
      }

      const settle = async (): Promise<void> => {
        // 只有成功退出才值得复验；失败时读版本没有意义
        let afterVersion: string | undefined
        if (info.code === 0) {
          afterVersion = (await locateSafe())?.version
        }
        const decision = classifyUpdateOutcome({
          exitCode: info.code,
          canceled: false,
          ...(beforeVersion === undefined ? {} : { beforeVersion }),
          ...(afterVersion === undefined ? {} : { afterVersion }),
          ...(targetVersion === undefined ? {} : { targetVersion })
        })
        const message =
          decision.note === undefined ? decision.message : `${decision.message}（${decision.note}）`
        const result = buildResult(decision.outcome, message, afterVersion)
        emitSafe({
          jobId: job.id,
          phase: decision.outcome === 'failed' ? 'failed' : 'done',
          message
        })
        finish({ accepted: true, result })
      }

      void settle().catch((error: unknown) => {
        const message = `更新已结束，但复验版本时出错：${describeError(error)}`
        emitSafe({ jobId: job.id, phase: 'failed', message })
        finish({ accepted: true, result: buildResult('pendingRestart', message, undefined) })
      })
    })

    return await deferred.promise
  }

  /* ---------------------------------------------------------------- *
   * cancel
   * ---------------------------------------------------------------- */

  function cancel(): void {
    const job = active
    // 幂等：没有任务 / 已取消 / 已结束都直接返回
    if (job === undefined || job.settled || job.canceled) return
    job.canceled = true
    if (job.child === undefined) return

    emitSafe({ jobId: job.id, phase: 'log', line: '收到取消请求，正在结束 pi update 进程…' })
    killJob(job, 'SIGTERM')
    job.killTimer = setTimeout(() => {
      if (job.settled) return
      killJob(job, 'SIGKILL')
    }, CANCEL_GRACE_MS)
    job.killTimer.unref?.()
  }

  return {
    check,
    apply,
    cancel,
    isRunning: () => active !== undefined,
    activeJobId: () => active?.id
  }
}
