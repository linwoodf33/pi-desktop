import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { spawn } from 'node:child_process'

import type { PiSelfCheckStatus, PiSelfCheckStep } from '../../shared/contracts/types'
import { IpcFailure } from '../../shared/contracts/result'

import { LocalTransport, buildCmdCommandLine } from '../transport/local-connection'
import type { PiLaunchSpec } from '../transport/types'

/**
 * PiLocator（架构文档 §3.3、§5.2）：定位 pi 可执行文件并做本地三步自检。
 *
 * 1. 定位：显式配置 > PATH > 常见安装路径；Windows 上用 PATHEXT 展开 `.cmd/.exe`，
 *    避免 §7 约束 11 的字符串拼接（真正启动由 `PiLaunchSpec` 描述，LocalTransport 执行）
 * 2. 版本：`pi --version`
 * 3. RPC 连通性：`pi --mode rpc --no-session` 发 `get_state`，首条记录必须是合法 JSON 响应；
 *    首条非 JSON 判定协议污染（§9.2 I10、§10 A12）
 *
 * 所有失败路径都返回 `PiSelfCheckStatus`（state=missing/failed）+ 可操作提示，
 * 同时保留 `launch()` 供 SessionService 使用。
 */
export interface PiLocator {
  status(): PiSelfCheckStatus
  /** 定位 + 自检；任何失败都通过 PiSelfCheckStatus 上报，不抛异常 */
  locate(explicitPath?: string): Promise<PiSelfCheckStatus>
  /** 已解析出的启动命令；未成功定位时为 undefined */
  launch(): PiLaunchSpec | undefined
}

export interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface PiLocatorDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** 文件存在性判断（测试可注入） */
  fileExists?: (path: string) => boolean
  /** 目录列表（测试可注入，用于 PATHEXT 展开） */
  listDir?: (path: string) => string[]
  /** 短命令捕获执行（`--version`） */
  runCapture?: (spec: PiLaunchSpec, args: string[], timeoutMs: number) => Promise<CaptureResult>
  /** RPC 连通性探测（默认用 LocalTransport） */
  probeRpc?: (spec: PiLaunchSpec, timeoutMs: number) => Promise<PiSelfCheckStatus>
  /** 版本捕获超时（§7 约束 13 的启动预算） */
  captureTimeoutMs?: number
  /** 支持的最低版本 */
  minVersion?: string
  comspec?: string
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000
/** M2 基线版本：RPC 模式与 agent_settled 语义在 1.x 稳定 */
const DEFAULT_MIN_VERSION = '1.0.0'
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

/** 常见安装路径（按平台；路径拼接跟随目标平台而非宿主平台） */
export function commonPiPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const p = platform === 'win32' ? win32 : posix
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir()
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? p.join(home, 'AppData', 'Roaming')
    const localAppData = env['LOCALAPPDATA'] ?? p.join(home, 'AppData', 'Local')
    return [
      p.join(home, '.pi', 'agent', 'bin', 'pi.cmd'),
      p.join(appData, 'npm', 'pi.cmd'),
      p.join(localAppData, 'pi', 'bin', 'pi.cmd')
    ]
  }
  return [
    '/usr/local/bin/pi',
    '/opt/homebrew/bin/pi',
    p.join(home, '.pi', 'agent', 'bin', 'pi'),
    p.join(home, '.local', 'bin', 'pi')
  ]
}

/**
 * 把解析到的 pi 路径翻译成真正可 spawn 的命令（§7 约束 11，M5 `pi.cmd` 加固）。
 *
 * Windows 上的风险（M5 评估结论）：旧实现一律走 `cmd.exe /d /s /c "..."` 单行命令行，
 * 而 `--name` / `--model` / `--session` 等实参来自 renderer（用户输入），因此存在注入面：
 * - `"`：cmd 的引号是**开关语义**，没有 `\"` 反转义 → 可用一个引号关闭外层引号注入 `& ...`；
 * - `%`：引号内**照旧**展开 `%PATH%` / `%1` / `%*` → 参数被静默替换；
 * - CR/LF：把一条命令行拆成多条。
 *
 * 因此分三层处理：
 * 1. `.cmd`/`.bat` 能解析出 Node 入口（官方 `pi.cmd` → `%~dp0pi-launcher.js`，
 *    npm shim → `node_modules/.../cli.js`）**且** 能找到 node 可执行文件
 *    → 直接 `node <入口>` + 参数数组（`shell:false`），**完全绕过 cmd.exe**，零转义需求；
 * 2. 解析不到 → 仍用 `cmd.exe /d /s /c`，但每个实参都过 `assertCmdSafeArg`
 *    （含 `"`/`%`/换行 直接 FAIL 为 VALIDATION，绝不拼接）；
 * 3. 其余（`.exe` / `.ps1` / POSIX 脚本）→ 直接执行。
 */
export interface LaunchSpecDeps {
  fileExists?: (path: string) => boolean
  /** 读取文本文件（.cmd 内容）；默认 fs.readFileSync，测试可注入 */
  readText?: (path: string) => string | undefined
  listDir?: (path: string) => string[]
  env?: NodeJS.ProcessEnv
  /** 已解析的 node 可执行文件（省略则自行解析 PATH） */
  nodePath?: string
}

/** 从 .cmd/.bat 内容里抽出被 node 执行的入口脚本（相对 .cmd 所在目录） */
export function extractNodeShimScript(cmdText: string): string | undefined {
  // 已知形态（pi 官方安装器 / npm 生成的 shim）：
  //   "%node%" "%~dp0pi-launcher.js" %*
  //   "%_prog%"  "%dp0%\node_modules\@scope\pkg\dist\bundle\cli.js" %*
  const patterns = [
    /"%~dp0([^"\r\n]+\.(?:js|mjs|cjs))"/i,
    /"%~dp0[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"/i,
    /"%dp0%([^"\r\n]+\.(?:js|mjs|cjs))"/i,
    /"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(cmdText)
    // 去掉可能的盘符相对前缀分隔符（`%dp0%\\x` 与 `%~dp0x` 两种写法都要兼容）
    const rel = match?.[1]?.trim().replace(/^[/\\]+/, '')
    if (rel !== undefined && rel.length > 0) return rel
  }
  return undefined
}

/** 在 PATH（及常见安装目录）里找 node 可执行文件 */
export function resolveNodeExecutable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
  listDir: (path: string) => string[]
): string | undefined {
  const p = platform === 'win32' ? win32 : posix
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const dirs = pathValue.split(pathDelimiter).filter((entry) => entry.length > 0)

  if (platform === 'win32') {
    const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0)
    const candidates: string[] = []
    for (const dir of dirs) {
      candidates.push(p.join(dir, 'node.exe'))
    }
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const localAppData = env['LOCALAPPDATA']
    candidates.push(p.join(programFiles, 'nodejs', 'node.exe'))
    if (localAppData !== undefined) {
      candidates.push(p.join(localAppData, 'Programs', 'nodejs', 'node.exe'))
    }
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate
    }
    // 目录内容兜底（大小写不敏感 + PATHEXT 变体）
    for (const dir of dirs) {
      const wanted = new Set(['node.exe', ...exts.map((ext) => `node${ext}`)])
      const hit = listDir(dir).find((entry) => wanted.has(entry.toLowerCase()))
      if (hit !== undefined) return p.join(dir, hit)
    }
    return undefined
  }

  for (const dir of dirs) {
    const candidate = p.join(dir, 'node')
    if (fileExists(candidate)) return candidate
  }
  return undefined
}

export function buildLaunchSpec(
  piPath: string,
  platform: NodeJS.Platform,
  comspec?: string,
  deps: LaunchSpecDeps = {}
): PiLaunchSpec {
  const lower = piPath.toLowerCase()
  const p = platform === 'win32' ? win32 : posix
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path))
  const listDir = deps.listDir ?? ((): string[] => [])
  const readText =
    deps.readText ??
    ((path: string): string | undefined => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    })

  if (platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    // 第 1 层：绕过 cmd.exe（node shim）
    const shimText = readText(piPath)
    const relScript = shimText === undefined ? undefined : extractNodeShimScript(shimText)
    if (relScript !== undefined) {
      const scriptPath = p.resolve(p.dirname(piPath), relScript)
      const nodePath =
        deps.nodePath ??
        resolveNodeExecutable(platform, deps.env ?? process.env, fileExists, listDir)
      if (nodePath !== undefined && fileExists(scriptPath)) {
        return {
          command: nodePath,
          prefixArgs: [scriptPath],
          displayPath: piPath,
          launchKind: 'node-shim'
        }
      }
    }

    // 第 2 层：只能经 cmd.exe —— 参数逐个校验后再拼（不安全的实参直接抛 VALIDATION）
    return {
      command: comspec ?? 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c'],
      windowsVerbatimArguments: true,
      commandLine: (args: string[]) => buildCmdCommandLine(piPath, args),
      displayPath: piPath,
      launchKind: 'cmd-shim'
    }
  }
  if (platform === 'win32' && lower.endsWith('.ps1')) {
    return {
      command: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', piPath],
      displayPath: piPath,
      launchKind: 'direct'
    }
  }
  return { command: piPath, prefixArgs: [], displayPath: piPath, launchKind: 'direct' }
}

/** 语义化版本比较：仅比较数值段，忽略预发布后缀 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, '').split('-')[0]?.split('.').map(toInt) ?? []
  const pb = b.trim().replace(/^v/i, '').split('-')[0]?.split('.').map(toInt) ?? []
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export function parseVersion(text: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)
  return match?.[1]
}

function toInt(part: string): number {
  const parsed = Number.parseInt(part, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function createPiLocator(deps: PiLocatorDeps = {}): PiLocator {
  const platform = deps.platform ?? process.platform
  // 路径语义跟随「目标平台」，而不是宿主平台（Windows 上也能对 POSIX 布局做单测）
  const p = platform === 'win32' ? win32 : posix
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const env = deps.env ?? process.env
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path))
  const listDir =
    deps.listDir ??
    ((path: string) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    })
  const captureTimeoutMs = deps.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
  const minVersion = deps.minVersion ?? DEFAULT_MIN_VERSION
  const comspec = deps.comspec ?? env['ComSpec'] ?? env['COMSPEC']
  const runCapture = deps.runCapture ?? defaultRunCapture
  const probeRpc = deps.probeRpc ?? defaultProbeRpc

  let current: PiSelfCheckStatus = { state: 'unknown', message: '尚未自检 pi' }
  let resolved: PiLaunchSpec | undefined

  /** PATH / 常见路径 / 显式路径 → 真实可执行文件 */
  function resolveExecutable(nameOrPath: string): string | undefined {
    const hasSeparator = nameOrPath.includes('/') || nameOrPath.includes('\\')
    if (hasSeparator || /\.(cmd|bat|exe|ps1)$/i.test(nameOrPath)) {
      const absolute = p.resolve(nameOrPath)
      if (fileExists(absolute)) return absolute
      if (platform === 'win32') {
        for (const ext of DEFAULT_PATHEXT) {
          const candidate = `${absolute}${ext.toLowerCase()}`
          if (fileExists(candidate)) return candidate
        }
      }
      return undefined
    }

    const pathValue = env['PATH'] ?? env['Path'] ?? ''
    for (const dir of pathValue.split(pathDelimiter).filter((entry) => entry.length > 0)) {
      const candidate = findInDir(dir, nameOrPath)
      if (candidate) return candidate
    }
    for (const candidate of commonPiPaths(platform, env)) {
      if (fileExists(candidate)) return candidate
    }
    return undefined
  }

  function findInDir(dir: string, name: string): string | undefined {
    if (platform !== 'win32') {
      const candidate = p.join(dir, name)
      return fileExists(candidate) ? candidate : undefined
    }
    // Windows：扩展名全集来自 PATHEXT + 目录实际内容（大小写不敏感）
    const pathext = (env['PATHEXT'] ?? DEFAULT_PATHEXT.join(';'))
      .split(';')
      .map((ext) => ext.trim())
      .filter((ext) => ext.length > 0)
    let entries: string[]
    try {
      entries = listDir(dir)
    } catch {
      return undefined
    }
    for (const ext of pathext) {
      const wanted = `${name}${ext}`.toLowerCase()
      const hit = entries.find((entry) => entry.toLowerCase() === wanted)
      if (hit) return p.join(dir, hit)
    }
    return undefined
  }

  function fail(state: 'missing' | 'failed', message: string): PiSelfCheckStatus {
    resolved = undefined
    current = { state, message, steps: [...steps] }
    return current
  }

  /** M4：三步自检的逐条结果（设置页可视化，§10 A12） */
  const steps: PiSelfCheckStep[] = []

  function recordStep(
    id: PiSelfCheckStep['id'],
    label: string,
    state: PiSelfCheckStep['state'],
    detail?: string
  ): void {
    steps.push({ id, label, state, ...(detail === undefined ? {} : { detail }) })
  }

  function resetSteps(): void {
    steps.length = 0
  }

  return {
    status: () => current,

    launch: () => resolved,

    async locate(explicitPath?: string): Promise<PiSelfCheckStatus> {
      resetSteps()
      const candidateName = explicitPath?.trim()
      const piPath =
        candidateName !== undefined && candidateName.length > 0
          ? resolveExecutable(candidateName)
          : resolveExecutable('pi')

      if (!piPath) {
        recordStep('locate', '定位可执行文件', 'failed', 'PATH 与常见安装路径均未命中')
        recordStep('version', '版本检查', 'skipped')
        recordStep('rpc', 'RPC 连通性', 'skipped')
        return fail(
          'missing',
          candidateName
            ? `找不到 pi 可执行文件：${candidateName}。请在设置中指定 pi 的完整路径（例如 pi.cmd）`
            : 'PATH 与常见安装路径中都找不到 pi。请安装 pi（https://pi.dev）或在设置中指定可执行文件路径'
        )
      }
      recordStep('locate', '定位可执行文件', 'ok', piPath)

      const spec = buildLaunchSpec(piPath, platform, comspec)

      // 第 2 步：版本
      let version: string | undefined
      try {
        const result = await runCapture(spec, ['--version'], captureTimeoutMs)
        version = parseVersion(result.stdout) ?? parseVersion(result.stderr)
        if (result.code !== 0 || !version) {
          recordStep(
            'version',
            '版本检查',
            'failed',
            `--version 失败（code=${String(result.code)}）`
          )
          recordStep('rpc', 'RPC 连通性', 'skipped')
          return fail(
            'failed',
            `pi --version 执行失败（code=${String(result.code)}）：${firstLine(result.stderr) || firstLine(result.stdout) || '无输出'}`
          )
        }
      } catch (error) {
        recordStep('version', '版本检查', 'failed', describe(error))
        recordStep('rpc', 'RPC 连通性', 'skipped')
        return fail('failed', `无法执行 pi --version：${describe(error)}`)
      }

      if (minVersion.length > 0 && compareVersions(version, minVersion) < 0) {
        recordStep('version', '版本检查', 'failed', `版本过旧：${version} < ${minVersion}`)
        recordStep('rpc', 'RPC 连通性', 'skipped')
        return fail(
          'failed',
          `pi 版本过旧（${version} < ${minVersion}）。请升级 pi 后重试（pi update 或重新安装）`
        )
      }
      recordStep('version', '版本检查', 'ok', version)

      // 第 3 步：RPC 连通性
      let probe: PiSelfCheckStatus
      try {
        probe = await probeRpc(spec, captureTimeoutMs)
      } catch (error) {
        recordStep('rpc', 'RPC 连通性', 'failed', describe(error))
        return fail('failed', `--mode rpc 自检失败：${describe(error)}`)
      }
      if (probe.state !== 'ok') {
        recordStep('rpc', 'RPC 连通性', 'failed', probe.message)
        resolved = undefined
        current = {
          state: probe.state,
          ...(version === undefined ? {} : { version }),
          ...(probe.message === undefined ? {} : { message: probe.message }),
          steps: [...steps],
          path: piPath
        }
        return current
      }
      recordStep('rpc', 'RPC 连通性', 'ok', 'get_state 响应正常')

      resolved = spec
      current = {
        state: 'ok',
        version,
        message: `pi ${version} · RPC 自检通过 · ${piPath}`,
        steps: [...steps],
        path: piPath
      }
      return current
    }
  }
}

/* ------------------------------------------------------------------ *
 * 默认实现：捕获执行 + RPC 探测
 * ------------------------------------------------------------------ */

export function defaultRunCapture(
  spec: PiLaunchSpec,
  args: string[],
  timeoutMs: number
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const prefix = spec.prefixArgs ?? []
    const argv = spec.commandLine
      ? [...prefix, spec.commandLine(args)]
      : [...prefix, ...args]
    const child = spawn(spec.command, argv, {
      shell: false,
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    const limit = 64 * 1024

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < limit) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < limit) stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`超时 ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    child.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** `--mode rpc --no-session` 发一次 get_state，首条响应必须是合法 JSON（§3.3） */
export async function defaultProbeRpc(
  spec: PiLaunchSpec,
  timeoutMs: number
): Promise<PiSelfCheckStatus> {
  const transport = new LocalTransport({
    channelId: 'pi-selfcheck',
    launch: spec,
    startTimeoutMs: timeoutMs
  })

  try {
    await transport.start({ cwd: tmpdir(), extraArgs: ['--no-session'] })
  } catch (error) {
    return { state: 'failed', message: `无法启动 pi --mode rpc：${describe(error)}` }
  }

  try {
    const response = await firstResponse(transport, { type: 'get_state' }, timeoutMs)
    if (response === undefined) {
      return {
        state: 'failed',
        message: 'pi --mode rpc 首条记录不是合法 JSON 协议响应（可能被启动横幅污染）'
      }
    }
    if (response.success === false) {
      return {
        state: 'failed',
        message: `pi --mode rpc 自检命令失败：${response.error ?? '未知错误'}`
      }
    }
    return { state: 'ok' }
  } catch (error) {
    const status: PiSelfCheckStatus = {
      state: 'failed',
      message: `pi --mode rpc 自检超时：${describe(error)}`
    }
    return status
  } finally {
    await transport.stop().catch(() => {})
  }
}

async function firstResponse(
  transport: LocalTransport,
  cmd: { type: string },
  timeoutMs: number
): Promise<{ success?: boolean; error?: string } | undefined> {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      unsubscribe()
      reject(new Error(`等待响应超过 ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    const unsubscribe = transport.onRecord((record) => {
      if (done) return
      if (record.type !== 'response') return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(record as { success?: boolean; error?: string })
    })

    transport.send(cmd, 'pi-selfcheck')
  })
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

function describe(error: unknown): string {
  if (error instanceof IpcFailure) return error.message
  return error instanceof Error ? error.message : String(error)
}
