import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'

/**
 * 会话 JSONL 的**尾部**反向扫描（A23 改名修复）。
 *
 * 为什么需要它：pi 的会话名不是文件头字段，而是 JSONL 里的 `session_info` 记录
 * （`docs/session-format.md`）。`/name`、RPC `set_session_name`、以及本项目的
 * 「历史任务改名」都**只 append**，所以改名记录一定落在**文件尾**；
 * 而 `session-index.ts` 原来只读头部 32KB —— 于是「当场改名生效、重启后变回
 * `(未命名会话)`」。这里提供「从尾向前找最后一条满足谓词的记录」的原语。
 *
 * 语义与边界：
 * - **last-wins**：从后往前走，第一条命中的就是最新的，多条 `session_info` 天然取最后一条；
 * - **截断行容错**：JSON 解析失败就 `continue`（不 break）—— 写盘途中被 list 赶上时
 *   末尾半行会被跳过，回落到上一条完整记录，比返回空名更好；
 * - **UTF-8 边界安全**：只有窗口首行可能被切在半个码点上，而它在 `nextStart > 0` 时总被丢弃；
 * - **CRLF**：与 `session-history.ts` 的 `parseEntries` 同一套规则（strip 尾 `\r`、跳过空行）；
 * - **fail-soft**：文件不存在 / 无读权限 / 任何 IO 异常一律返回 `undefined`，绝不抛。
 *
 * 刻意**不 import `session-history`**：避免 `session-history → session-tail` 的循环依赖，
 * 解析规则以本文件注释 + `tests/unit/session-tail.test.ts` 对齐。
 */
export type RecordPredicate = (record: Record<string, unknown>) => boolean

export interface TailScanOptions {
  /** 每次向前读多少字节（默认 128KB） */
  windowBytes?: number
  /** 最多反向扫描多少字节（默认 2MB；超过就放弃，避免把大文件读进内存） */
  maxScanBytes?: number
}

/** 一次读多少字节作为尾部窗口（常见情况：改名记录就在文件最后一行） */
export const DEFAULT_TAIL_WINDOW_BYTES = 128 * 1024
/** 反向扫描的字节上限（此值内保证「最后一条 session_info 一定找到」） */
export const DEFAULT_TAIL_MAX_SCAN_BYTES = 2 * 1024 * 1024

/** 从文件尾向前找「最后一条满足谓词的记录」；找不到 / 读失败 → undefined（绝不抛） */
export async function findLastRecordInTail(
  filePath: string,
  predicate: RecordPredicate,
  options: TailScanOptions = {}
): Promise<Record<string, unknown> | undefined> {
  const windowBytes = positiveInt(options.windowBytes, DEFAULT_TAIL_WINDOW_BYTES)
  const maxScanBytes = Math.max(
    windowBytes,
    positiveInt(options.maxScanBytes, DEFAULT_TAIL_MAX_SCAN_BYTES)
  )

  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return undefined
  }
  if (size <= 0) return undefined

  const handle = await open(filePath, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    let start = size
    /** 累积的原始字节（**不要**逐块 toString 再拼接：那会在块边界切断多字节码点） */
    let buffer = Buffer.alloc(0)
    while (start > 0 && size - start < maxScanBytes) {
      const remaining = maxScanBytes - (size - start)
      const chunkBytes = Math.min(windowBytes, start, remaining)
      if (chunkBytes <= 0) return undefined
      const nextStart = start - chunkBytes
      const chunk = Buffer.alloc(chunkBytes)
      let bytesRead = 0
      try {
        const result = await handle.read(chunk, 0, chunkBytes, nextStart)
        bytesRead = result.bytesRead
      } catch {
        return undefined
      }
      if (bytesRead <= 0) return undefined
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer])
      const found = scanBufferBackward(buffer, nextStart > 0, predicate)
      if (found !== undefined) return found
      start = nextStart
    }
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 同步版本（与异步版逐行同构；`pi-session-name.lastEntryId` 等同步路径可复用） */
export function findLastRecordInTailSync(
  filePath: string,
  predicate: RecordPredicate,
  options: TailScanOptions = {}
): Record<string, unknown> | undefined {
  const windowBytes = positiveInt(options.windowBytes, DEFAULT_TAIL_WINDOW_BYTES)
  const maxScanBytes = Math.max(
    windowBytes,
    positiveInt(options.maxScanBytes, DEFAULT_TAIL_MAX_SCAN_BYTES)
  )

  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return undefined
  }
  if (size <= 0) return undefined

  try {
    const fd = openSync(filePath, 'r')
    try {
      let start = size
      let buffer = Buffer.alloc(0)
      while (start > 0 && size - start < maxScanBytes) {
        const remaining = maxScanBytes - (size - start)
        const chunkBytes = Math.min(windowBytes, start, remaining)
        if (chunkBytes <= 0) return undefined
        const nextStart = start - chunkBytes
        const chunk = Buffer.alloc(chunkBytes)
        let bytesRead = 0
        try {
          bytesRead = readSync(fd, chunk, 0, chunkBytes, nextStart)
        } catch {
          return undefined
        }
        if (bytesRead <= 0) return undefined
        buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer])
        const found = scanBufferBackward(buffer, nextStart > 0, predicate)
        if (found !== undefined) return found
        start = nextStart
      }
      return undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/**
 * 在「[某段区间, 文件尾) 的完整字节」里从后往前逐行匹配。
 *
 * `dropFirstLine`：窗口起点可能落在半行中间（甚至半个 UTF-8 码点中间），
 * 首行一律丢弃 —— 由调用方在 `nextStart > 0` 时置 true。
 */
function scanBufferBackward(
  buffer: Buffer,
  dropFirstLine: boolean,
  predicate: RecordPredicate
): Record<string, unknown> | undefined {
  const lines = buffer.toString('utf8').split('\n')
  const firstIndex = dropFirstLine ? 1 : 0
  for (let index = lines.length - 1; index >= firstIndex; index -= 1) {
    const raw = lines[index]
    if (raw === undefined) continue
    // CRLF 容错：pi 只写 `\n`，但外部工具/拷贝可能留下 `\r\n`
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 被截断的尾行 / 损坏行：跳过继续向前，不 break
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (predicate(record)) return record
  }
  return undefined
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
