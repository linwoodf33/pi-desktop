import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { IpcError } from '../../shared/contracts/result'
import { IpcFailure } from '../../shared/contracts/result'

import { JsonlReader } from './jsonl-reader'
import type {
  ConnectionState,
  LinkKind,
  OpenChannelOptions,
  PiConnection,
  PiLaunchSpec,
  PiTransport,
  RpcCommand,
  RpcRecord,
  TransportExitInfo,
  TransportStartOptions
} from './types'

/**
 * LocalConnection / LocalTransport（架构文档 §5.3、§7 约束 2/6/11）。
 *
 * 一个通道 = 一个 pi 子进程（§D3）；stdout 只承载协议记录（JsonlReader 分帧），
 * stderr 单独进环形缓冲（末 200 行 / 64KB，§7 约束 17 同源要求）。
 *
 * 本文件不 import electron，可在 vitest 中直接构造；`spawnImpl` 可注入 mock。
 */

/** 优雅退出等待时长：先关 stdin 等有序退出，超时才 kill（§7 约束 6） */
export const GRACEFUL_EXIT_TIMEOUT_MS = 5000
/** kill 之后再等这么久才升级为 SIGKILL */
export const KILL_ESCALATION_TIMEOUT_MS = 2000
/** 子进程就绪（spawn 事件）超时，§7 约束 13：pi 启动 10s */
export const START_TIMEOUT_MS = 10_000
/** stderr 环形缓冲约束（§7 约束 14 / 17） */
export const STDERR_MAX_LINES = 200
export const STDERR_MAX_BYTES = 64 * 1024

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>
) => ChildProcessWithoutNullStreams

/* ------------------------------------------------------------------ *
 * 参数构造
 * ------------------------------------------------------------------ */

/**
 * 把 `TransportStartOptions` 翻译成 pi 的真实 CLI 参数（docs/cli.md）。
 *
 * 已核对的参数名：
 * - `--mode rpc`：RPC 长连模式（docs/rpc.md）
 * - `--model <pattern>`：支持 `provider/id` 与 `:<thinking>` 后缀
 * - `--thinking <level>`：off/minimal/low/medium/high/xhigh/max
 * - `--session <path|id>`：按文件路径恢复既有会话
 * - `--session-dir <dir>`：覆盖会话目录
 * - `--name <name>`：会话显示名
 * - `--exclude-tools <list>` / `--no-tools`：起始模式（工具白名单，见 `SESSION_TOOL_MODE_META`）
 */
/** 只读模式禁用的工具（写文件与执行命令） */
export const READONLY_EXCLUDED_TOOLS = 'write,edit,bash,powershell'

export function buildPiArgs(opts: TransportStartOptions): string[] {
  const args: string[] = ['--mode', 'rpc']

  if (opts.model !== undefined && opts.model.length > 0) args.push('--model', opts.model)
  if (opts.thinkingLevel !== undefined && opts.thinkingLevel.length > 0) {
    args.push('--thinking', opts.thinkingLevel)
  }
  // 会话身份 agent：`--agent` 由 pi-open-agents 扩展注册；未安装时 pi 会直接报 Unknown option，
  // 所以「能不能传」由 main 侧能力探测（agents:list）决定，这里只负责拼装。
  if (opts.agent !== undefined && opts.agent.length > 0) args.push('--agent', opts.agent)
  if (opts.sessionFile !== undefined && opts.sessionFile.length > 0) {
    args.push('--session', opts.sessionFile)
  }
  if (opts.sessionDir !== undefined && opts.sessionDir.length > 0) {
    args.push('--session-dir', opts.sessionDir)
  }
  if (opts.sessionName !== undefined && opts.sessionName.length > 0) {
    args.push('--name', opts.sessionName)
  }
  // 起始模式：用 denylist 关掉「会改文件 / 会执行命令」的工具，
  // 而不是 allowlist —— allowlist 会把用户装的扩展工具一并关掉。
  if (opts.toolMode === 'readonly') args.push('--exclude-tools', READONLY_EXCLUDED_TOOLS)
  else if (opts.toolMode === 'no-tools') args.push('--no-tools')

  if (opts.extraArgs !== undefined) args.push(...opts.extraArgs)

  return args
}

/** cmd.exe 命令行里需要加引号的字符（保守集合） */
const CMD_NEEDS_QUOTE = /[\s"&|<>^()%!]/

/**
 * cmd.exe 命令行里**无法安全表达**的实参特征（M5 `pi.cmd` 加固）。
 *
 * 实测风险（cmd.exe 的真实解析行为）：
 * - `"`：cmd 的引号是**开关语义**，没有 `\"` 反转义；一个实参含 `"` 就能闭合引号，
 *   让后面的 `& calc` 变成新命令（命令注入）；
 * - `%`：引号内**照旧**做变量展开（`%PATH%` / `%1` / `%*`），参数会被静默替换；
 * - CR / LF / NUL：会把一条命令行拆成两条或截断。
 *
 * 这类实参一律拒绝（fail-closed），而不是「想办法转义」——cmd 没有可靠的转义通道。
 */
const CMD_UNSAFE = /["%\r\n\0]/

/**
 * 校验一个实参能否安全出现在 cmd.exe 命令行里；不能则抛 `VALIDATION`。
 * 抛错发生在 `LocalTransport.start()`，表现为通道级验证错误（不会静默降级）。
 */
export function assertCmdSafeArg(token: string, source: string): void {
  const match = CMD_UNSAFE.exec(token)
  if (match === null) return
  const which =
    match[0] === '"'
      ? '双引号 `"`'
      : match[0] === '%'
        ? '百分号 `%`（cmd 会做变量展开）'
        : 'CR/LF/NUL 等控制字符'
  throw new IpcFailure(
    'VALIDATION',
    `无法安全地通过 cmd.exe 传递参数（${source}）：参数含${which}。请改用 .exe 形式的 pi，或避免在参数里使用这些字符`,
    `arg=${tokensPreview(token)}`
  )
}

function tokensPreview(token: string): string {
  const escaped = token.replace(
    /[\r\n\0]/g,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
  )
  return escaped.length > 80 ? `${escaped.slice(0, 80)}…` : escaped
}

/**
 * 给 cmd.exe 命令行 token 加引号（仅在 cmd-shim 分支使用）。
 *
 * 前置条件：调用方已用 {@link assertCmdSafeArg} 拒绝含 `"` / `%` / 换行的实参，
 * 因此这里只需整体包一层引号：引号内 `& | < > ^ ( ) !` 都是字面量。
 */
export function quoteForCmdLine(token: string): string {
  if (token.length === 0) return '""'
  if (!CMD_NEEDS_QUOTE.test(token)) return token
  return `"${token}"`
}

/**
 * 构造 `cmd.exe /d /s /c` 的完整命令行（`/s` 只剥掉最外层一对引号）。
 *
 * 生成形状：`"<exe> <arg> ..."`（外层引号 + 每个 token 分别加引号）。
 * 任何不安全实参 → 抛 VALIDATION，不拼接。
 */
export function buildCmdCommandLine(exePath: string, args: readonly string[]): string {
  assertCmdSafeArg(exePath, '可执行文件路径')
  const quoted = args.map((arg) => {
    assertCmdSafeArg(arg, 'pi 参数')
    return quoteForCmdLine(arg)
  })
  return `"${[quoteForCmdLine(exePath), ...quoted].join(' ')}"`
}

/**
 * 子进程环境：剥掉“我们自己所在的 pi 会话”派生出来的环境变量，
 * 避免把父会话的身份传给孩子进程（父会话的 session 文件绝不能被复用）。
 *
 * M5：在基座之上追加 `extraEnv`（客户端下发的审批策略 `PI_DESKTOP_PERMISSION`）。
 */
export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    if (key === 'PI_CODING_AGENT' || key === 'PI_SESSION_FILE' || key === 'PI_SESSION_ID') continue
    if (key.startsWith('PI_OPEN_AGENTS_')) continue
    env[key] = value
  }
  if (extraEnv !== undefined) {
    for (const [key, value] of Object.entries(extraEnv)) env[key] = value
  }
  return env
}

/* ------------------------------------------------------------------ *
 * 连接状态机（§9.1 U11：非法迁移必须被拒绝并记录）
 * ------------------------------------------------------------------ */

/**
 * 连接级状态语义（与通道级生命周期解耦，§D3「一会话一子进程」）：
 *
 * - `disconnected`：尚未开过通道，或已 `dispose()`（终端态，仅可回到 `connecting`）
 * - `connecting`：正在解析启动命令 / 正在起第一个通道
 * - `ready`：**至少一个通道活跃且可继续 openChannel**（不是终止态：多会话必须能继续开）
 * - `degraded`：通道已全部退出，但连接仍可用（可再开通道）
 * - `failed`：一次解析/启动失败且此时没有活跃通道。**不是终态**：用户修正 pi 路径后
 *   再次 openChannel 会迁移 `failed → connecting` 重试（§3.3 / §10 A12：3 步内解除阻塞，免重启）
 *
 * 注意 `failed → ready` 仍然非法（U11）：失败必须经过一次 `connecting` 重试才算恢复。
 * 通道级失败不会把已有活跃通道的连接打成 `failed`（§5.3）。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  disconnected: ['connecting'],
  connecting: ['ready', 'degraded', 'failed', 'disconnected'],
  ready: ['connecting', 'degraded', 'failed', 'disconnected'],
  degraded: ['connecting', 'ready', 'failed', 'disconnected'],
  failed: ['connecting', 'disconnected']
}

export class ConnectionStateMachine {
  private current: ConnectionState = 'disconnected'
  private readonly onIllegal: (from: ConnectionState, to: ConnectionState) => void

  constructor(onIllegal?: (from: ConnectionState, to: ConnectionState) => void) {
    this.onIllegal = onIllegal ?? (() => {})
  }

  state(): ConnectionState {
    return this.current
  }

  /** 返回 false 表示非法迁移（状态保持不变） */
  transition(to: ConnectionState): boolean {
    if (to === this.current) return true
    if (!ALLOWED_TRANSITIONS[this.current].includes(to)) {
      this.onIllegal(this.current, to)
      return false
    }
    this.current = to
    return true
  }
}

/* ------------------------------------------------------------------ *
 * stderr 环形缓冲（末 200 行 / 64KB）
 * ------------------------------------------------------------------ */

/**
 * stderr 环形缓冲（末 200 行 / 64KB，§7 约束 14）。
 *
 * 关键约束：
 * - **未闭合的 partial 也计入字节预算**：没有 LF 的超长行不会无限增长（超过上限时只留尾部）；
 * - **不静默截断**：发生过丢行 / 裁行时，`tail()` 首行会显式标注已截断（约束 14）。
 */
export class StderrRingBuffer {
  private readonly lines: string[] = []
  private readonly maxLines: number
  private readonly maxBytes: number
  /** 尚未遇到 LF 的尾巴（也计入字节预算） */
  private partial = ''
  /** 已丢弃的行数（trim 造成），>0 时 tail() 带截断标记 */
  private droppedLines = 0
  /** 未闭合的超长行被裁剪过 */
  private partialTrimmed = false

  constructor(maxLines = STDERR_MAX_LINES, maxBytes = STDERR_MAX_BYTES) {
    this.maxLines = maxLines
    this.maxBytes = maxBytes
  }

  push(chunk: string): void {
    let text = chunk
    let lf = text.indexOf('\n')
    while (lf !== -1) {
      this.appendLine(this.partial + text.slice(0, lf))
      this.partial = ''
      text = text.slice(lf + 1)
      lf = text.indexOf('\n')
    }
    if (text.length > 0) this.appendPartial(text)
    this.trim()
  }

  /** 进程结束时把未闭合的尾巴也计入 */
  finish(): void {
    if (this.partial.length > 0) {
      this.appendLine(this.partial)
      this.partial = ''
      this.trim()
    }
  }

  /**
   * 尾部文本（含未闭合的尾巴）。发生过丢弃时首行是明确的截断标记，
   * 让上层诊断不会误以为「stderr 就只有这些」（约束 14：不静默截断）。
   */
  tail(): string {
    const body = this.partial.length > 0 ? [...this.lines, this.partial] : [...this.lines]
    const marker = this.truncationMarker()
    return marker === undefined ? body.join('\n') : [marker, ...body].join('\n')
  }

  /** 已保存的完整行数（不含未闭合的尾巴） */
  size(): number {
    return this.lines.length
  }

  /** 是否发生过丢弃/裁剪 */
  truncated(): boolean {
    return this.droppedLines > 0 || this.partialTrimmed
  }

  private truncationMarker(): string | undefined {
    if (!this.truncated()) return undefined
    const reasons: string[] = []
    if (this.droppedLines > 0) reasons.push(`已丢弃最早的 ${this.droppedLines} 行`)
    if (this.partialTrimmed) reasons.push('未闭合的超长行已只保留尾部')
    return `[stderr 已截断：${reasons.join('，')}（上限 ${this.maxLines} 行 / ${this.maxBytes} 字节）]`
  }

  private appendLine(rawLine: string): void {
    // 只剥离行尾一个可选 CR（CRLF 输入）
    this.lines.push(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
    this.trim()
  }

  /**
   * 累积未闭合的行。它同样占用字节预算：超过 `maxBytes` 时只保留尾部，
   * 否则一条没有 LF 的超长 stderr 会把内存吃满。
   */
  private appendPartial(text: string): void {
    this.partial += text
    if (this.byteLength(this.partial) > this.maxBytes) {
      this.partialTrimmed = true
      this.partial = tailBytes(this.partial, Math.max(1, Math.floor(this.maxBytes / 2)))
    }
  }

  /** 行数 / 字节数双上限：都从最旧的行开始丢，保证末尾仍在 */
  private trim(): void {
    while (this.lines.length > this.maxLines) {
      this.lines.shift()
      this.droppedLines += 1
    }
    while (this.lines.length > 1 && this.byteCount() > this.maxBytes) {
      this.lines.shift()
      this.droppedLines += 1
    }
  }

  private byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8')
  }

  /** 当前占用字节：完整行（含换行）+ 未闭合的尾巴 */
  private byteCount(): number {
    let total = this.byteLength(this.partial)
    for (const line of this.lines) total += this.byteLength(line) + 1
    return total
  }
}

/** 取字符串的尾部 `maxBytes` 字节（跳过 UTF-8 续字节，避免切出半个码点） */
function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let start = buffer.length - maxBytes
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/* ------------------------------------------------------------------ *
 * LocalTransport：一个 pi 子进程 + 一条协议通道
 * ------------------------------------------------------------------ */

export interface LocalTransportOptions {
  channelId: string
  launch: PiLaunchSpec
  spawnImpl?: SpawnFn
  gracefulExitTimeoutMs?: number
  killEscalationTimeoutMs?: number
  startTimeoutMs?: number
  stderrMaxLines?: number
  stderrMaxBytes?: number
  /** 环境变量基座（默认 process.env；测试可注入） */
  baseEnv?: NodeJS.ProcessEnv
}

export class LocalTransport implements PiTransport {
  readonly channelId: string
  readonly link: LinkKind = 'local'

  private readonly launch: PiLaunchSpec
  private readonly spawnImpl: SpawnFn
  private readonly gracefulExitTimeoutMs: number
  private readonly killEscalationTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly stderrBuffer: StderrRingBuffer

  private child: ChildProcessWithoutNullStreams | null = null
  private reader: JsonlReader | null = null
  private readonly recordListeners = new Set<(record: RpcRecord) => void>()
  private readonly exitListeners = new Set<(info: TransportExitInfo) => void>()

  /** 待写队列：write 返回 false 时暂存，等 drain 再泵出（§7 约束 2） */
  private writeQueue: string[] = []
  private waitingDrain = false

  private exited = false
  private exitInfo: TransportExitInfo | null = null
  private stopPromise: Promise<void> | null = null
  private exitWaiters: Array<(info: TransportExitInfo) => void> = []
  private invalidLineCount = 0

  constructor(options: LocalTransportOptions) {
    this.channelId = options.channelId
    this.launch = options.launch
    this.spawnImpl = options.spawnImpl ?? spawn
    this.gracefulExitTimeoutMs = options.gracefulExitTimeoutMs ?? GRACEFUL_EXIT_TIMEOUT_MS
    this.killEscalationTimeoutMs = options.killEscalationTimeoutMs ?? KILL_ESCALATION_TIMEOUT_MS
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
    this.baseEnv = options.baseEnv ?? process.env
    this.stderrBuffer = new StderrRingBuffer(
      options.stderrMaxLines ?? STDERR_MAX_LINES,
      options.stderrMaxBytes ?? STDERR_MAX_BYTES
    )
  }

  async start(opts: TransportStartOptions): Promise<void> {
    if (this.child) throw new IpcFailure('INTERNAL', '通道已启动，不能重复 start')
    if (!opts.cwd) throw new IpcFailure('VALIDATION', 'cwd 不能为空')

    const prefix = this.launch.prefixArgs ?? []
    const piArgs = buildPiArgs(opts)
    // 三种启动形态：
    // 1) commandLine：由 launch spec 把全部参数拼成一条 cmd.exe 命令行（/s 语义）
    // 2) windowsVerbatimArguments：prefixArgs 已是 cmd 片段，参数自行加引号
    // 3) 普通可执行文件：prefixArgs + 参数数组，交给 Node 处理引号
    let spawnArgs: string[]
    if (this.launch.commandLine) {
      spawnArgs = [...prefix, this.launch.commandLine(piArgs)]
    } else if (this.launch.windowsVerbatimArguments) {
      spawnArgs = [...prefix, ...piArgs.map(quoteForCmdLine)]
    } else {
      spawnArgs = [...prefix, ...piArgs]
    }

    const spawnOptions: Record<string, unknown> = {
      cwd: opts.cwd,
      // §7 约束 11：shell:false + 数组参数
      shell: false,
      windowsHide: true,
      env: buildChildEnv(this.baseEnv, opts.env),
      stdio: ['pipe', 'pipe', 'pipe']
    }
    if (this.launch.windowsVerbatimArguments) spawnOptions['windowsVerbatimArguments'] = true

    const child = this.spawnImpl(this.launch.command, spawnArgs, spawnOptions)
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    this.reader = new JsonlReader({
      onRecord: (record) => this.emitRecord(record),
      onInvalid: (line, error) => {
        this.invalidLineCount += 1
        // 非法行不崩溃：作为一条协议诊断记录交给上层（§9.1 U4）
        this.emitRecord({
          type: 'parse_error',
          error: error.message,
          linePreview: line.slice(0, 200)
        })
      }
    })

    child.stdout.on('data', (chunk: string) => {
      // §7 约束 2：持续读取，绝不暂停
      this.reader?.push(chunk)
    })
    child.stdout.on('end', () => {
      this.reader?.flush()
    })

    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer.push(chunk)
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(
          new IpcFailure(
            'PI_EXITED',
            `pi 未在 ${this.startTimeoutMs}ms 内就绪`,
            this.stderrBuffer.tail()
          )
        )
      }, this.startTimeoutMs)
      timer.unref?.()

      child.once('spawn', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })

      child.once('error', (error: Error) => {
        this.handleExit(null, null)
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new IpcFailure('PI_NOT_FOUND', `无法启动 pi：${error.message}`, this.launch.displayPath)
        )
      })
    })

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(code, signal)
    })

    // close 之前 stdin 也可能先报错（EPIPE），统一走退出路径
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return
      this.emitRecord({ type: 'stderr_note', message: `stdin: ${error.code ?? error.message}` })
    })
  }

  /** 只保证写入；接受与否看匹配 id 的 response.success（§5.3） */
  send(cmd: RpcCommand, id?: string): void {
    const child = this.child
    if (!child || this.exited) {
      throw new IpcFailure('PI_EXITED', '通道已关闭，无法发送命令', this.channelId)
    }
    const payload = id === undefined ? cmd : { ...cmd, id }
    this.writeQueue.push(`${JSON.stringify(payload)}\n`)
    this.pumpStdin()
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  onExit(listener: (info: TransportExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    if (this.exitInfo) {
      const info = this.exitInfo
      queueMicrotask(() => listener(info))
    }
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  /** stderr 尾部（末 200 行 / 64KB），供 evt:diagnostic 使用 */
  stderrTail(): string {
    return this.stderrBuffer.tail()
  }

  /** 已丢弃的非法协议行数量（诊断用） */
  invalidRecords(): number {
    return this.invalidLineCount
  }

  /**
   * 关停顺序（§7 约束 6）：关 stdin → 等有序退出 → 超时才 kill → 再超时 SIGKILL。
   * 禁止立即 kill：会把会话 JSONL 截断。
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.performStop()
    return this.stopPromise
  }

  private async performStop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) {
      this.child = null
      return
    }

    const exitPromise = this.waitForExit()

    try {
      child.stdin.end()
    } catch {
      // stdin 可能已关闭，忽略
    }

    const graceful = await Promise.race([
      exitPromise.then(() => 'exited' as const),
      delay(this.gracefulExitTimeoutMs).then(() => 'timeout' as const)
    ])
    if (graceful === 'exited') return

    child.kill()

    const killed = await Promise.race([
      exitPromise.then(() => 'exited' as const),
      delay(this.killEscalationTimeoutMs).then(() => 'timeout' as const)
    ])
    if (killed === 'exited') return

    child.kill('SIGKILL')
    await exitPromise
  }

  private waitForExit(): Promise<TransportExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve)
    })
  }

  private pumpStdin(): void {
    const child = this.child
    if (!child || this.exited) return
    if (this.waitingDrain) return
    const stdin = child.stdin
    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift()
      if (line === undefined) break
      const accepted = stdin.write(line)
      if (!accepted) {
        // 背压：等 drain 再继续泵
        this.waitingDrain = true
        stdin.once('drain', () => {
          this.waitingDrain = false
          this.pumpStdin()
        })
        return
      }
    }
  }

  private emitRecord(record: unknown): void {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      this.invalidLineCount += 1
      this.emitRecord({ type: 'parse_error', error: '协议记录不是 JSON 对象' })
      return
    }
    const typed = record as RpcRecord
    for (const listener of this.recordListeners) {
      try {
        listener(typed)
      } catch (error) {
        console.error('[transport] onRecord 监听器抛错', describe(error))
      }
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.stderrBuffer.finish()
    const info: TransportExitInfo = {
      code,
      signal,
      stderrTail: this.stderrBuffer.tail()
    }
    this.exitInfo = info
    this.writeQueue = []
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const waiter of waiters) waiter(info)
    for (const listener of this.exitListeners) {
      try {
        listener(info)
      } catch (error) {
        console.error('[transport] onExit 监听器抛错', describe(error))
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * LocalConnection：连接级状态机 + 通道集合
 * ------------------------------------------------------------------ */

export interface LocalConnectionOptions {
  /** 解析出的 pi 启动命令（pi-locator 产出） */
  resolveLaunch: () => Promise<PiLaunchSpec>
  spawnImpl?: SpawnFn
  /** 状态非法迁移/变化的上报（默认 silent） */
  onStateChange?: (state: ConnectionState, info?: unknown) => void
  onIllegalTransition?: (info: IpcError) => void
  gracefulExitTimeoutMs?: number
  startTimeoutMs?: number
  baseEnv?: NodeJS.ProcessEnv
  /**
   * 每次开通道时追加的环境变量（M5：审批策略 `PI_DESKTOP_PERMISSION`）。
   * 用回调而不是快照：策略在设置页改动后，下一次 spawn 就生效。
   */
  extraEnv?: () => Record<string, string>
}

export class LocalConnection implements PiConnection {
  readonly id = 'local'

  private readonly resolveLaunch: () => Promise<PiLaunchSpec>
  private readonly machine: ConnectionStateMachine
  private readonly listeners = new Set<(state: ConnectionState, info?: unknown) => void>()
  private readonly onStateChangeHook: (state: ConnectionState, info?: unknown) => void
  private readonly transports = new Set<LocalTransport>()
  private readonly options: LocalConnectionOptions
  private channelSeq = 0
  /** 正在启动中的通道数（并发 openChannel 时用于决定失败后的连接状态） */
  private startingChannels = 0

  constructor(options: LocalConnectionOptions) {
    this.options = options
    this.resolveLaunch = options.resolveLaunch
    this.onStateChangeHook = options.onStateChange ?? (() => {})
    this.machine = new ConnectionStateMachine((from, to) => {
      const info: IpcError = {
        code: 'PROTOCOL',
        message: `连接状态非法迁移：${from} → ${to}`,
        detail: 'transition rejected'
      }
      options.onIllegalTransition?.(info)
      console.error(`[transport] 拒绝连接状态非法迁移 ${from} → ${to}`)
    })
  }

  state(): ConnectionState {
    return this.machine.state()
  }

  onStateChange(cb: (state: ConnectionState, info?: unknown) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  async openChannel(opts: OpenChannelOptions): Promise<PiTransport> {
    const previous = this.machine.state()
    // `ready` = 已可用且可继续开通道（多会话）：此时不经 `connecting`，
    // 既不抖状态也不重复通知；其它状态（disconnected/connecting/degraded/failed）
    // 都按「一次新的尝试」处理，`failed` 由此获得重试路径（§10 A12）。
    if (previous !== 'ready') {
      if (!this.machine.transition('connecting')) {
        throw new IpcFailure('PROTOCOL', `连接状态 ${previous} 不允许新建通道`)
      }
      // 并发首次开通道时状态已是 connecting，不重复通知
      if (previous !== 'connecting') this.notify('connecting')
    }
    this.startingChannels += 1

    let transport: LocalTransport | null = null
    try {
      const launch = await this.resolveLaunch()
      transport = new LocalTransport({
        channelId: `local#${++this.channelSeq}`,
        launch,
        ...(this.options.spawnImpl === undefined ? {} : { spawnImpl: this.options.spawnImpl }),
        ...(this.options.gracefulExitTimeoutMs === undefined
          ? {}
          : { gracefulExitTimeoutMs: this.options.gracefulExitTimeoutMs }),
        ...(this.options.startTimeoutMs === undefined
          ? {}
          : { startTimeoutMs: this.options.startTimeoutMs }),
        ...(this.options.baseEnv === undefined ? {} : { baseEnv: this.options.baseEnv })
      })

      const startOpts: TransportStartOptions = {
        cwd: opts.cwd,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.thinkingLevel === undefined ? {} : { thinkingLevel: opts.thinkingLevel }),
        ...(opts.toolMode === undefined ? {} : { toolMode: opts.toolMode }),
        ...(opts.agent === undefined ? {} : { agent: opts.agent }),
        ...(opts.sessionFile === undefined ? {} : { sessionFile: opts.sessionFile }),
        ...(opts.sessionDir === undefined ? {} : { sessionDir: opts.sessionDir }),
        ...(opts.sessionName === undefined ? {} : { sessionName: opts.sessionName }),
        ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
        ...(opts.env === undefined && this.options.extraEnv === undefined
          ? {}
          : { env: { ...(opts.env ?? {}), ...(this.options.extraEnv?.() ?? {}) } })
      }

      await transport.start(startOpts)
      const started: LocalTransport = transport
      this.transports.add(started)

      // 通道级退出：连接降级，但不影响其他通道（Phase 2 复用同一语义）
      started.onExit(() => {
        this.transports.delete(started)
        if (this.transports.size > 0) return
        if (this.machine.state() === 'disconnected') return
        if (this.machine.transition('degraded')) this.notify('degraded')
      })

      return started
    } catch (error) {
      // §5.3：openChannel 失败落到通道级错误，不把仍有活跃通道的连接标记 failed
      if (transport) void transport.stop()
      throw error
    } finally {
      this.startingChannels -= 1
      this.syncStateWithChannels()
    }
  }

  /**
   * 把连接级状态落到与「当前通道集合」一致的位置：
   * - 有活跃通道 → `ready`
   * - 无活跃通道但还有启动中的通道 → `degraded`（连接仍可用）
   * - 都没有 → `failed`（可通过再次 openChannel 重试）
   *
   * `disconnected`（`dispose()` 之后）是终端态，不再改动。
   */
  private syncStateWithChannels(): void {
    if (this.machine.state() === 'disconnected') return
    const target: ConnectionState =
      this.transports.size > 0 ? 'ready' : this.startingChannels > 0 ? 'degraded' : 'failed'
    // 已经是目标状态时不重复通知（多会话开通道不应抖状态）
    if (this.machine.state() === target) return
    if (this.machine.transition(target)) this.notify(target)
  }

  async dispose(): Promise<void> {
    const transports = [...this.transports]
    this.transports.clear()
    await Promise.allSettled(transports.map((transport) => transport.stop()))
    if (this.machine.transition('disconnected')) this.notify('disconnected')
  }

  private notify(state: ConnectionState, info?: unknown): void {
    this.onStateChangeHook(state, info)
    for (const listener of this.listeners) {
      try {
        if (info === undefined) listener(state)
        else listener(state, info)
      } catch (error) {
        console.error('[transport] onStateChange 监听器抛错', describe(error))
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
