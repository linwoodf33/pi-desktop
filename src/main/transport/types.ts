/**
 * PiConnection / PiTransport 契约（架构文档 §5.3）。
 *
 * M1 只定义了类型；M2 由 `LocalConnection` / `LocalTransport` 实现（link = 'local'）。
 * Phase 2 的 `GatewayConnection` 复用同一套契约（附录 A.4）。
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'degraded' | 'failed'

export type LinkKind = 'local' | 'gateway'

export interface RpcCommand {
  type: string
  [key: string]: unknown
}

/** 协议记录（stdout 的一行 JSON），具体形状由 pi RPC 文档定义 */
export interface RpcRecord {
  type: string
  [key: string]: unknown
}

export interface OpenChannelOptions {
  cwd: string
  model?: string
  thinkingLevel?: string
  /** 起始模式 → pi 的工具选择参数（`full` 不加参数） */
  toolMode?: 'full' | 'readonly' | 'no-tools'
  /** 会话身份 agent（`--agent`，由 pi-open-agents 扩展注册；名字需客户端自己校验） */
  agent?: string
  sessionFile?: string
  /** 覆盖 pi 会话目录（`--session-dir`，docs/cli.md） */
  sessionDir?: string
  /** 会话显示名（`--name`） */
  sessionName?: string
  extraArgs?: string[]
  /** 追加到子进程环境（M5：下发审批策略 `PI_DESKTOP_PERMISSION`） */
  env?: Record<string, string>
}

export interface TransportStartOptions {
  cwd: string
  model?: string
  thinkingLevel?: string
  /** 起始模式 → pi 的工具选择参数（`full` 不加参数） */
  toolMode?: 'full' | 'readonly' | 'no-tools'
  /** 会话身份 agent（`--agent`） */
  agent?: string
  sessionFile?: string
  sessionDir?: string
  sessionName?: string
  extraArgs?: string[]
  env?: Record<string, string>
}

export interface TransportExitInfo {
  code: number | null
  signal: string | null
  stderrTail: string
}

export interface PiTransport {
  readonly channelId: string
  readonly link: LinkKind
  start(opts: TransportStartOptions): Promise<void>
  /** 只保证写入；接受与否看匹配 id 的 response.success */
  send(cmd: RpcCommand, id?: string): void
  onRecord(listener: (record: RpcRecord) => void): () => void
  onExit(listener: (info: TransportExitInfo) => void): () => void
  stop(): Promise<void>
}

export interface PiConnection {
  readonly id: string
  state(): ConnectionState
  onStateChange(cb: (state: ConnectionState, info?: unknown) => void): () => void
  openChannel(opts: OpenChannelOptions): Promise<PiTransport>
  dispose(): Promise<void>
}

/**
 * 启动 pi 的实际命令（由 pi-locator 产出，pi-locator/测试/mock 共用）。
 *
 * 三种形态（按优先级，见 `pi-locator.buildLaunchSpec`）：
 * 1. `.exe` / 无扩展名 → 直接 `shell:false` + 参数数组（最安全，零转义）；
 * 2. `.cmd` 且能解析出 node 入口（如官方 `pi.cmd` → `%~dp0pi-launcher.js`、npm shim →
 *    `node_modules/.../cli.js`）→ `node <入口脚本>` + 参数数组，**完全绕过 cmd.exe**；
 * 3. 无法解析的 `.cmd` → `cmd.exe /d /s /c`，但参数必须通过 `assertCmdSafeArg`
 *    （含 `"`/`%`/换行 的实参直接报 VALIDATION，绝不拼接进命令行）。
 */
export interface PiLaunchSpec {
  command: string
  prefixArgs?: readonly string[]
  windowsVerbatimArguments?: boolean
  /**
   * 把 pi 参数拼成**一条**命令行字符串（用于 `cmd.exe /d /s /c ""<exe>" args..."` 这种
   * `/s` 语义：外层引号由这里负责）。存在时 `prefixArgs` 只是前导开关，参数不再单独传。
   * 不安全参数会直接抛 `IpcFailure('VALIDATION')`（fail-closed，不拼接）。
   */
  commandLine?: (args: string[]) => string
  /** 诊断用：人类可读的“实际可执行文件” */
  displayPath?: string
  /** 说明启动形态（诊断/报告用）：direct | node-shim | cmd-shim */
  launchKind?: 'direct' | 'node-shim' | 'cmd-shim'
}
