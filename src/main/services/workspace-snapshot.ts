import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { ArtifactEntry } from '../../shared/contracts/types'

import { toPosixRelative, normalizeForCompare } from './path-guard'

/**
 * 工作区快照比对（M6，非 git 工作区的回退链路；架构文档 §6.1 第 5 步 / §8.1 M6）。
 *
 * 语义：**会话开始快照 → 重扫**，按 `size + mtime + 前 1MB sha1` 判定变更。
 *
 * 为什么不是纯 mtime：`git` 之外的目录里，工具经常「重写内容但保留 mtime」或
 * 「touch 一下但内容没变」。只看 mtime 会同时产生漏报与误报，所以：
 * - `size` 变 → 一定算变化；
 * - `size` 不变但 `mtime` 变 → 用前 1MB 的 sha1 复核，**hash 相同就当没变**（不误报）；
 * - `mtime` 与 `size` 都不变但 hash 变了（极小概率的手工篡改 mtime）→ 也算变化。
 *
 * 边界（明确的取舍，不是遗漏）：
 * - **不跟随符号链接**（避免把工作区外的树拉进快照，也避免循环链接）。
 *   判定一律走 `lstat`（看**链接本身**，不解析目标）：`readdir` 的 dirent 与 `lstat` 双重把关，
 *   因为 dirent 与后续 stat 之间存在 TOCTOU 窗口（文件可能在两次调用之间被换成链接）；
 * - 链接 / 目录 / 设备等**非普通文件**不进入快照，只计入 `skippedSymlinks` / `skippedNonRegular`
 *   统计，且**不**把快照标记为不完整（这是设计上的跳过，不是扫描失败）；
 * - 跳过 VCS 与依赖目录（`.git` / `node_modules` 等），并把 `truncated` 标出来；
 * - 文件数/深度/耗时都有上限，超限 `complete: false`，UI 必须显式说明「快照不完整」。
 */

/** 默认跳过的目录（VCS 与依赖目录：体积大且不是产物） */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage'
]

/** 前 1MB 参与 sha1（§M6 约定），避免大文件把扫描拖成 IO 密集 */
export const HASH_LIMIT_BYTES = 1024 * 1024
/** 单文件内容保留上限：超过就只留 hash（diff 会显式标注「原始内容未保留」） */
export const DEFAULT_CONTENT_LIMIT_BYTES = 256 * 1024
/** 内容保留总预算（超过后只留 hash，防止快照吃满内存） */
export const DEFAULT_CONTENT_BUDGET_BYTES = 32 * 1024 * 1024
/** 快照文件数上限 */
export const DEFAULT_MAX_FILES = 5000
/** 目录深度上限 */
export const DEFAULT_MAX_DEPTH = 8

export interface SnapshotFileEntry {
  /** 文件大小（字节） */
  size: number
  /** mtime（毫秒） */
  mtimeMs: number
  /** 前 1MB 的 sha1（hex） */
  hash: string
  /** 文本内容（仅小文本文件且预算够时保留；用于生成 unified diff） */
  content?: string
  /** 判定为二进制（前 8KB 含 NUL / UTF-8 解码失败） */
  binary?: boolean
}

export interface WorkspaceSnapshot {
  /** 已归一的工作区根（绝对路径） */
  root: string
  /** 拍摄时间（毫秒） */
  takenAt: number
  files: Map<string, SnapshotFileEntry>
  /** 达到文件数/深度/耗时上限，快照不完整 */
  complete: boolean
  /** 扫描到的文件总数（含被跳过内容保留的部分） */
  scanned: number
  /** 被跳过的符号链接/junction 数量（不跟随、不记入 files，也不算「不完整」） */
  skippedSymlinks: number
  /** 被跳过的其他非普通文件数量（目录 / 设备 / 管道等） */
  skippedNonRegular: number
}

export interface SnapshotOptions {
  maxFiles?: number
  maxDepth?: number
  maxContentBytes?: number
  contentBudgetBytes?: number
  skipDirs?: readonly string[]
  timeoutMs?: number
  now?: () => number
}

/** 拍摄一次工作区快照（只读；不跟随符号链接） */
export async function takeSnapshot(
  root: string,
  options: SnapshotOptions = {}
): Promise<WorkspaceSnapshot> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_CONTENT_LIMIT_BYTES
  const contentBudget = options.contentBudgetBytes ?? DEFAULT_CONTENT_BUDGET_BYTES
  const skipDirs = new Set((options.skipDirs ?? DEFAULT_SKIP_DIRS).map((dir) => dir.toLowerCase()))
  const now = options.now ?? (() => Date.now())
  const deadline = now() + (options.timeoutMs ?? 5_000)

  const files = new Map<string, SnapshotFileEntry>()
  let complete = true
  let contentBudgetLeft = contentBudget
  let skippedSymlinks = 0
  let skippedNonRegular = 0

  type QueueItem = { dir: string; depth: number }
  const queue: QueueItem[] = [{ dir: root, depth: 0 }]

  while (queue.length > 0) {
    if (now() > deadline) {
      complete = false
      break
    }
    const item = queue.shift()
    if (item === undefined) break
    let dirents
    try {
      dirents = await readdir(item.dir, { withFileTypes: true })
    } catch {
      // 目录不可读（权限/已删除）：跳过，但不宣称快照完整
      complete = false
      continue
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      if (files.size >= maxFiles) {
        complete = false
        break
      }
      // deadline 逐文件检查：大目录下不必等整个目录扫完才认超时（单次读取已被 HASH_LIMIT_BYTES 限定）
      if (now() > deadline) {
        complete = false
        break
      }
      const absolute = join(item.dir, dirent.name)
      // 第一道关：dirent 已标明是链接（Windows 的 junction 也走这里）→ 只统计，不跟随
      if (dirent.isSymbolicLink()) {
        skippedSymlinks += 1
        continue
      }
      if (dirent.isDirectory()) {
        if (skipDirs.has(dirent.name.toLowerCase())) continue
        if (item.depth + 1 > maxDepth) {
          complete = false
          continue
        }
        queue.push({ dir: absolute, depth: item.depth + 1 })
        continue
      }
      if (!dirent.isFile()) {
        skippedNonRegular += 1
        continue
      }

      const result = await describeFile(absolute, maxContentBytes, contentBudgetLeft)
      // 第二道关（lstat）：dirent 说是普通文件，但此刻可能已被换成链接/目录 ——
      // 既不跟随（不读目标内容），也不据此宣称快照不完整，只计入统计。
      if (result.kind === 'symlink') {
        skippedSymlinks += 1
        continue
      }
      if (result.kind === 'nonRegular') {
        skippedNonRegular += 1
        continue
      }
      if (result.kind === 'error') {
        complete = false
        continue
      }
      const entry = result.entry
      if (entry.content !== undefined) contentBudgetLeft -= entry.content.length
      files.set(toPosixRelative(root, absolute), entry)
    }
  }

  return {
    root,
    takenAt: now(),
    files,
    complete,
    scanned: files.size,
    skippedSymlinks,
    skippedNonRegular
  }
}

type DescribeResult =
  | { kind: 'entry'; entry: SnapshotFileEntry }
  | { kind: 'symlink' }
  | { kind: 'nonRegular' }
  | { kind: 'error' }

/**
 * 描述一个候选文件。
 *
 * **必须用 `lstat`**：`stat` 会解析符号链接/junction，等于把工作区外的目标内容
 * （可能很大、可能在网络盘、可能是循环链接）拉进快照；`lstat` 只看链接本身，
 * 链接按「非普通文件」返回 `symlink`，由调用方跳过并计数、但不判快照不完整。
 *
 * 残留风险（已知、可接受）：从 `lstat` 到 `open` 之间仍有极短 TOCTOU 窗口；
 * 那一段由 `readFilePrefix` 的定点读限定上限（最多 HASH_LIMIT_BYTES），不会整读。
 */
async function describeFile(
  absolute: string,
  maxContentBytes: number,
  contentBudgetLeft: number
): Promise<DescribeResult> {
  let info
  try {
    info = await lstat(absolute)
  } catch {
    return { kind: 'error' }
  }
  // 先判链接：Windows 上 junction 的 isDirectory() 也可能为真，必须优先按链接处理
  if (info.isSymbolicLink()) return { kind: 'symlink' }
  if (!info.isFile()) return { kind: 'nonRegular' }

  let buffer: Buffer
  try {
    // 只读 `min(size, HASH_LIMIT_BYTES)` 字节：唯一读取路径，永远有上限
    // （即使文件在 lstat 与读取之间被追加，也不会变成整读）
    buffer = await readFilePrefix(absolute, Math.min(info.size, HASH_LIMIT_BYTES))
  } catch {
    return { kind: 'error' }
  }

  const hash = createHash('sha1').update(buffer).digest('hex')
  const binary = isBinaryBuffer(buffer)
  const entry: SnapshotFileEntry = { size: info.size, mtimeMs: info.mtimeMs, hash, binary }

  if (
    !binary &&
    info.size <= maxContentBytes &&
    contentBudgetLeft >= info.size &&
    info.size === buffer.length
  ) {
    entry.content = buffer.toString('utf8')
  }
  return { kind: 'entry', entry }
}

/**
 * 只读文件前 `length` 字节（`length` 由调用方夹取到 `HASH_LIMIT_BYTES` 以内）。
 *
 * **必须是定点读**：`open` + `handle.read(buffer, 0, length, 0)` 一次只分配/读取 `length` 字节，
 * 与 `artifacts.ts#readRange` 同款实现。绝不能 `readFile` 整读再 `subarray` —— 那样主进程
 * 内存会随文件大小线性上涨（数据集/镜像/日志很常见），而快照是在 `evt:status=starting`
 * 时**自动**触发的，用户无从感知，5s deadline 也救不了单次整读。
 * 句柄在 finally 中关闭，读取抛错也不泄漏 fd。
 */
async function readFilePrefix(absolute: string, length: number): Promise<Buffer> {
  const handle = await open(absolute, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 二进制判定：前 8KB 含 NUL 即判二进制（与 git 的启发式同源） */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8 * 1024)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

export interface SnapshotComparison {
  entries: ArtifactEntry[]
  /** 逐条变更的细节（用于 diff：需要 before/after 内容与二进制标记） */
  details: SnapshotChange[]
}

export interface SnapshotChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
  before?: SnapshotFileEntry
  after?: SnapshotFileEntry
}

/**
 * 比对两次快照。
 *
 * 变化判定见模块注释：size 变 → 变化；size 不变但 mtime 变 → 用 hash 复核；
 * hash 变但 mtime/size 都没变 → 也算变化（保守地不漏报）。
 */
export function compareSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  platform: NodeJS.Platform = process.platform
): SnapshotComparison {
  const details: SnapshotChange[] = []
  const beforeKeys = new Map<string, string>()
  for (const key of before.files.keys()) beforeKeys.set(normalizeForCompare(key, platform), key)

  for (const [path, afterEntry] of after.files) {
    const beforeKey = beforeKeys.get(normalizeForCompare(path, platform))
    const beforeEntry = beforeKey === undefined ? undefined : before.files.get(beforeKey)
    if (beforeEntry === undefined) {
      details.push({ path, change: 'added', after: afterEntry })
      continue
    }
    beforeKeys.delete(normalizeForCompare(path, platform))
    if (isChanged(beforeEntry, afterEntry)) {
      details.push({ path, change: 'modified', before: beforeEntry, after: afterEntry })
    }
  }

  // 剩下没被匹配的 before 条目 = 删除（用原始 key，保持旧路径口径）
  for (const originalKey of beforeKeys.values()) {
    const beforeEntry = before.files.get(originalKey)
    if (beforeEntry === undefined) continue
    details.push({ path: originalKey, change: 'deleted', before: beforeEntry })
  }

  details.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    entries: details.map((item) => {
      const sizeBytes = item.after?.size ?? item.before?.size
      const binary = item.after?.binary ?? item.before?.binary
      return {
        path: item.path,
        change: item.change,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(binary === true ? { binary: true } : {})
      }
    }),
    details
  }
}

function isChanged(before: SnapshotFileEntry, after: SnapshotFileEntry): boolean {
  if (before.size !== after.size) return true
  if (before.hash !== after.hash) return true
  // mtime 变了但 hash/size 都没变 → 内容确实没变（避免 touch 造成的误报）
  return false
}
