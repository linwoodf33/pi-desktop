import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative as pathRelative, resolve } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'

/**
 * 唯一的工作区路径校验器（M6，架构文档 §7 约束 8 / §9.1 U9 / §9.4 S6）。
 *
 * **所有** `fs:*` 与 `artifact:open` 通道都必须走这里，不允许各通道自己写一套前缀判断
 * （M4 的会话回放闸是本模块的雏形，思路一致：词法闸 + `fs.realpath` 真实路径闸，双闸缺一不可）。
 *
 * 闸门顺序（任一失败即 fail-closed 拒绝）：
 * 1. **词法黑名单**（{@link assertSafeRawPath}）：NUL / 控制字符 / UNC / 设备命名空间 /
 *    NTFS 备用数据流（ADS）/ `..` 段 / 以点或空格结尾的段（Windows 会静默剥离）/
 *    Windows 保留设备名。这些在 `path.resolve` 之前判，避免归一化把攻击面藏起来；
 * 2. **词法根判定**：`resolve(root, raw)` 后必须落在根内（含 Windows 大小写与分隔符归一）；
 * 3. **真实路径闸**：`fs.realpath` 归一后再判一次前缀。
 *    工作区内**指向工作区内的符号链接放行**（realpath 仍在根内），指向根外的一律拒绝
 *    （否则 junction/符号链接可绕过第 2 闸）。
 *
 * 关于「不存在」：`realpath` 报 ENOENT 时，只有**父目录**的真实路径仍在根内才允许
 * `allowMissing`（读已删除文件的 diff 需要它），否则照旧 `PATH_DENIED`。
 */

/** Windows 保留设备名（含带扩展名的变体，如 `CON.txt`） */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\..*)?$/i

/** 控制字符（含 NUL）；换行/制表都不该出现在路径里。逐码点判断，不在正则里写控制字符字面量 */
export function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export class PathDenied extends IpcFailure {
  constructor(message: string, detail?: string) {
    super('PATH_DENIED', message, detail)
    this.name = 'PathDenied'
  }
}

/**
 * 词法黑名单（第一闸）。
 *
 * @throws IpcFailure `VALIDATION`（空路径 / 非字符串）或 `PATH_DENIED`（越权形态）
 */
export function assertSafeRawPath(
  raw: unknown,
  platform: NodeJS.Platform = process.platform
): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new IpcFailure('VALIDATION', '路径不能为空')
  }
  const value = raw

  if (value.includes('\0')) throw new PathDenied('路径包含 NUL 字符，拒绝访问')
  if (hasControlChars(value)) throw new PathDenied('路径包含控制字符，拒绝访问')

  // UNC（`\\server\share`、`//server/share`）与设备命名空间（`\\?\C:\...`、`\\.\PhysicalDrive0`）
  if (/^[\\/]{2}/.test(value)) {
    throw new PathDenied('拒绝 UNC / 设备命名空间路径（\\\\?\\、\\\\.\\、//server）')
  }

  // NTFS 备用数据流：`file.txt:stream`（盘符的冒号除外）
  const withoutDrive = /^[A-Za-z]:/.test(value) ? value.slice(2) : value
  if (withoutDrive.includes(':')) {
    throw new PathDenied('拒绝 NTFS 备用数据流（ADS）路径（file.txt:stream）')
  }

  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..') throw new PathDenied('拒绝包含「..」的相对路径')
    if (segment === '.') continue
    // Windows 会静默剥离结尾的点与空格（`a.txt.` → `a.txt`、`a ` → `a`），
    // 这会让「词法上不同的路径」指向同一文件，破坏前缀判定的确定性。
    if (/[. ]$/.test(segment)) {
      throw new PathDenied('拒绝以点或空格结尾的路径段（Windows 会静默剥离）', segment)
    }
    if (RESERVED_DEVICE_NAME.test(segment)) {
      throw new PathDenied('拒绝 Windows 保留设备名', segment)
    }
  }

  // 平台无关性：`\` 在 POSIX 上是合法文件名字符，但跨平台实现（含本模块的归一化）
  // 会把它们当分隔符，统一在这里拒绝反斜杠与正斜杠混用的怪异形态。
  if (platform !== 'win32' && /[\\/]{2,}/.test(value)) {
    throw new PathDenied('拒绝含连续分隔符的路径')
  }
}

/**
 * 比较用归一：正斜杠 + 折叠重复分隔符 + 去尾随分隔符 + Windows 语义下小写。
 *
 * 与 `services/session-history.ts#normalizeForCompare` 保持同一套规则（大小写不敏感的事实来源
 * 是「看起来像 Windows 路径」而不是运行平台，因为单测会在 Linux 上跑 Windows 用例）。
 */
export function normalizeForCompare(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
  const windowsLike =
    platform === 'win32' || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
  return windowsLike ? normalized.toLowerCase() : normalized
}

/** `target` 是否等于根或落在根内（大小写/分隔符已归一） */
export function isInsideRoot(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedRoot = normalizeForCompare(root, platform)
  const normalizedTarget = normalizeForCompare(target, platform)
  if (normalizedRoot.length === 0) return false
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(`${normalizedRoot}/`)
}

export interface ResolveTargetOptions {
  /** 已校验的工作区根（绝对路径） */
  root: string
  /** renderer 传来的路径：工作区相对路径或绝对路径 */
  raw: string
  /** 允许目标暂时不存在（读已删除文件的 diff）：ENOENT 时改判父目录真实路径 */
  allowMissing?: boolean
  /** 测试注入：realpath 归一 */
  realPath?: (path: string) => Promise<string>
  platform?: NodeJS.Platform
}

export interface ResolvedTarget {
  /** realpath 归一后的绝对路径（不存在且 allowMissing 时是词法绝对路径） */
  realPath: string
  /** 未归一的绝对路径（诊断用） */
  absolute: string
  /** 相对工作区根的 POSIX 路径（展示口径） */
  relative: string
}

/**
 * 把 renderer 传来的路径收敛成「根内的真实绝对路径」。
 *
 * @throws IpcFailure `VALIDATION` | `PATH_DENIED` | `NOT_FOUND`（allowMissing=false 且文件不存在）
 */
export async function resolveWorkspaceTarget(
  options: ResolveTargetOptions
): Promise<ResolvedTarget> {
  const platform = options.platform ?? process.platform
  const realPath = options.realPath ?? ((value: string) => realpath(value))
  const allowMissing = options.allowMissing === true

  assertSafeRawPath(options.raw, platform)

  const root = resolve(options.root)
  const absolute = isAbsolute(options.raw) ? resolve(options.raw) : resolve(root, options.raw)
  if (!isInsideRoot(root, absolute, platform)) {
    throw new PathDenied('路径不在当前会话工作目录内，拒绝访问', truncate(absolute))
  }

  const realRoot = await realPath(root).catch(() => root)
  try {
    const realTarget = await realPath(absolute)
    if (!isInsideRoot(realRoot, realTarget, platform)) {
      throw new PathDenied(
        '路径的真实位置在工作区之外（疑似符号链接/junction 逃逸），拒绝访问',
        truncate(realTarget)
      )
    }
    return { realPath: realTarget, absolute, relative: toPosixRelative(realRoot, realTarget) }
  } catch (error) {
    if (error instanceof IpcFailure) throw error
    if (!isMissing(error)) {
      // 非 ENOENT（EACCES / ENOTDIR / 循环链接…）一律 fail-closed
      throw new PathDenied('路径无法解析为真实路径，拒绝访问', describeError(error))
    }
  }

  if (!allowMissing) {
    throw new IpcFailure('NOT_FOUND', '文件不存在（可能已被删除或移动）', truncate(absolute))
  }

  // ENOENT 且调用方允许缺失：父目录的真实路径必须仍在根内，否则连「属于本工作区」都无法确认
  const parent = dirname(absolute)
  const realParent = await realPath(parent).catch(() => {
    throw new PathDenied('文件所在目录无法解析为真实路径，拒绝访问', truncate(parent))
  })
  if (!isInsideRoot(realRoot, realParent, platform)) {
    throw new PathDenied('文件所在目录的真实位置在工作区之外，拒绝访问', truncate(realParent))
  }
  return { realPath: absolute, absolute, relative: toPosixRelative(root, absolute) }
}

/**
 * 多根白名单校验（`fs:readText` / `artifact:open` 没有会话上下文时用）。
 *
 * 根集合**只能由主进程推导**（活跃会话 cwd / 会话文件里记录的 cwd / 配置里的 workspaceRoots），
 * renderer 无法自己新增根。
 */
export async function resolveInsideAnyRoot(
  options: Omit<ResolveTargetOptions, 'root'> & { roots: readonly string[] }
): Promise<ResolvedTarget> {
  const platform = options.platform ?? process.platform
  assertSafeRawPath(options.raw, platform)
  const absolute = isAbsolute(options.raw) ? resolve(options.raw) : undefined
  if (absolute === undefined) {
    throw new PathDenied('未提供会话上下文时必须使用绝对路径')
  }
  let lastError: unknown
  for (const root of options.roots) {
    try {
      return await resolveWorkspaceTarget({
        ...options,
        root,
        ...(platform === undefined ? {} : { platform })
      })
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof IpcFailure) throw lastError
  throw new PathDenied('路径不在任何已知工作区内，拒绝访问', truncate(absolute))
}

/** 绝对路径 → 相对根的 POSIX 路径（不在根内时退回文件名） */
export function toPosixRelative(root: string, absolute: string): string {
  const rel = pathRelative(root, absolute)
  // rel === ''：两者是同一路径（工作区本身就是仓库根时很常见）→ 相对路径就是空串
  if (rel.length === 0) return ''
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return basename(absolute).replace(/\\/g, '/')
  }
  return rel.replace(/\\/g, '/')
}

/** 展示用截断（路径可能很长；不做任何内容泄漏） */
export function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string') return code
  }
  return 'realpath failed'
}
