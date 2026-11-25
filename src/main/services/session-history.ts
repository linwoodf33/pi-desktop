import { extractAgentFromEntries } from './session-agent'
import { open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'
import type { SessionHistoryOutput, SessionHistoryRecord } from '../../shared/contracts/types'

/**
 * SessionHistory（M3 补充，架构文档 §5.4 注 / §6.1 第 4 步）：
 * **只读**回放会话 JSONL，把持久化条目归一成与 `evt:record` 同形的记录，
 * 交给 renderer 的 `lib/reducer.ts` 渲染时间线。
 *
 * 约束：
 * - 只读，绝不写会话文件；
 * - 不启动 pi 子进程（§6.1：选中历史会话只回放，首次发送消息才 create/resume）；
 * - 路径必须落在会话根目录内：`path.resolve` 做词法收敛，**再用 `fs.realpath` 归一**
 *   后重新校验前缀（否则指向目录外的 junction / 符号链接可绕过，§7 约束 8）；
 * - **例外（M4 复核修复 B1）**：fork 后新会话文件可能尚未落盘（pi 从首条用户消息分叉得到
 *   空会话），此时传 `allowMissing: true` 按空会话返回并带 `fileAbsent: true`；
 *   词法闸与父目录真实路径闸照旧，只是把「文件不存在」与「路径不可信」区分开；
 * - 回放上限 50MB（§7 约束 14）：超限只读**尾部**并显式 `truncated: true`，不静默截断；
 * - 回放条数默认上限 {@link DEFAULT_MAX_RECORDS}（M4：避免 3 万条会话把 renderer 拖成 O(n²)），
 *   只回尾部并显式 `truncated: true` + 给出 `totalRecords`；
 * - 单行超过前 50MB 这种异常输入不会打爆内存（按行切分后丢弃首个不完整行）。
 */

/** §7 约束 14：回放/readAll 上限 50MB */
export const MAX_REPLAY_BYTES = 50 * 1024 * 1024

/**
 * 默认回放条数上限（M4）。
 *
 * 3 万条历史会话全量交给 renderer 既慢又无意义（首屏只看得见最近几屏），
 * 2000 条足够覆盖「继续对话」所需的上下文展示；超出部分显式提示可翻页（后续里程碑）。
 */
export const DEFAULT_MAX_RECORDS = 2000

export interface SessionHistoryOptions {
  /** 会话根目录（由 SessionIndex 提供，用于路径收敛） */
  sessionRoot: () => string
  /** 单次回放字节上限（默认 50MB） */
  maxBytes?: number
  /** 单次回放条数上限（默认 {@link DEFAULT_MAX_RECORDS}，设置项可覆盖） */
  defaultMaxRecords?: () => number | undefined
  /** 测试注入：读取文件尾部若干字节 */
  readTail?: (filePath: string, maxBytes: number) => Promise<{ text: string; size: number }>
  /** 测试注入：realpath 归一（默认 `fs.promises.realpath`） */
  realPath?: (path: string) => Promise<string>
}

export interface SessionHistoryReadInput {
  sessionFile: string
  maxRecords?: number
  /**
   * 容忍「会话文件尚未落盘」（M4 复核修复 B1）。
   *
   * pi 从**第一条用户消息**分叉时会得到空会话（`targetLeafId = null` → `newSession`），
   * 新会话文件直到下一条 prompt 才落盘。只有 fork 编排会传 `true`；
   * 即便如此也**不降低安全闸**：词法闸照旧，realpath 失败时只有 ENOENT 且**父目录真实路径
   * 仍在会话根内**才按「空会话」返回，其余情况依旧 `PATH_DENIED`。
   */
  allowMissing?: boolean
}

export interface SessionHistory {
  read(input: SessionHistoryReadInput): Promise<SessionHistoryOutput>
}

export function createSessionHistory(options: SessionHistoryOptions): SessionHistory {
  const maxBytes = options.maxBytes ?? MAX_REPLAY_BYTES
  const readTail = options.readTail ?? readTailBytes
  const realPath = options.realPath ?? ((value: string) => realpath(value))

  return {
    async read(input) {
      const root = options.sessionRoot()
      const absolute = resolveSessionPath(root, input.sessionFile)
      const allowMissing = input.allowMissing === true
      // §7 约束 8：词法收敛之后还要按真实路径再校一次（junction / 符号链接逃逸）。
      // allowMissing 只放宽「文件还不存在」这一种情形（见 resolveRealSessionPathOrAbsent）。
      let realTarget: string
      let absent = false
      if (allowMissing) {
        const resolved = await resolveRealSessionPathOrAbsent(realPath, root, absolute)
        realTarget = resolved.path
        absent = resolved.absent
      } else {
        realTarget = await resolveRealSessionPath(realPath, root, absolute)
      }
      if (absent) return absentHistory()

      let tail: { text: string; size: number }
      try {
        tail = await readTail(realTarget, maxBytes)
      } catch (error) {
        // realpath 与 read 之间文件仍可能不存在（尚未落盘）：同样按空会话处理
        if (allowMissing && isMissingFile(error)) return absentHistory()
        throw error
      }
      const { text, size } = tail
      const bytesTruncated = size > maxBytes
      const parsed = parseEntries(text, { dropFirstLine: bytesTruncated })
      const records = toReplayRecords(parsed)
      const limit = resolveMaxRecords(input.maxRecords, options.defaultMaxRecords)
      const limited = records.length === 0 ? records : records.slice(-limit)
      // A38：历史任务没有活会话，agent 只能从文件里读——这里已经解析过 entries，
      // 顺手取最后一条 `open-agents-state`/`active_agent`，零额外 IO。
      // 注意：`bytesTruncated` 时窗口外的标记读不到，结果是 `undefined`（未知），
      // 调用方应保持现值，而不是据此认为「没有 agent」。
      const agent = extractAgentFromEntries(parsed)
      return {
        records: limited,
        truncated: bytesTruncated || limited.length < records.length,
        messageCount: limited.length,
        totalRecords: records.length,
        ...(agent === undefined ? {} : { agent })
      }
    }
  }
}

function resolveMaxRecords(
  requested: number | undefined,
  configured: (() => number | undefined) | undefined
): number {
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested)
  }
  const fromConfig = configured?.()
  if (fromConfig !== undefined && Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.floor(fromConfig)
  }
  return DEFAULT_MAX_RECORDS
}

/**
 * 真实路径校验：`fs.realpath` 后重新做前缀判定（§7 约束 8）。
 *
 * - `realpath(根目录)` 失败（目录尚不存在）时退化用词法根，不因此拒掉合法回放；
 * - `realpath(目标)` 失败（文件不存在/不可访问）时 **fail-closed** 返回 `PATH_DENIED`，
 *   避免把无法确认的路径放行（也就不存在 TOCTOU 的宽窗口）。
 */
export async function resolveRealSessionPath(
  realPath: (path: string) => Promise<string>,
  sessionRoot: string,
  lexicalTarget: string
): Promise<string> {
  const realRoot = await resolveRealRoot(realPath, sessionRoot)
  const realTarget = await realPath(lexicalTarget).catch(() => {
    throw new IpcFailure('PATH_DENIED', '会话文件无法解析为真实路径，拒绝回放', 'realpath failed')
  })
  assertInsideRoot(realRoot, realTarget)
  return realTarget
}

/**
 * 容忍「文件尚未落盘」的真实路径校验（M4 复核修复 B1，**不降低安全闸**）。
 *
 * 唯一放宽的情形：`realpath(目标)` 报 **ENOENT**，且 **父目录**的真实路径仍在会话根内。
 * 这时返回 `absent: true`（调用方按空会话处理）。
 * 其余全部照旧 `PATH_DENIED`：
 * - realpath 成功但真实路径在根外（junction / 符号链接逃逸）；
 * - 非 ENOENT 的失败（权限 / 不可访问）；
 * - 父目录本身不存在或其真实路径在根外（这时连「该路径属于本会话根」都无法确认）。
 *
 * 之所以敢放宽这一种情形：pi 从首条用户消息分叉得到的是**空会话**，文件在下次 prompt 前
 * 根本不存在；路径存在与否既不泄露内容，也无法被用来读取站外文件（父目录仍受根约束）。
 */
export async function resolveRealSessionPathOrAbsent(
  realPath: (path: string) => Promise<string>,
  sessionRoot: string,
  lexicalTarget: string
): Promise<{ path: string; absent: boolean }> {
  const realRoot = await resolveRealRoot(realPath, sessionRoot)
  try {
    const realTarget = await realPath(lexicalTarget)
    assertInsideRoot(realRoot, realTarget)
    return { path: realTarget, absent: false }
  } catch (error) {
    if (!isMissingFile(error)) {
      // 非「文件不存在」：保持 fail-closed（与 resolveRealSessionPath 同码同文案）
      throw new IpcFailure('PATH_DENIED', '会话文件无法解析为真实路径，拒绝回放', 'realpath failed')
    }
  }

  // ENOENT：再用**父目录**确认真实路径仍在根内，否则同样拒绝
  const parent = dirname(lexicalTarget)
  const realParent = await realPath(parent).catch(() => {
    throw new IpcFailure(
      'PATH_DENIED',
      '会话文件所在目录无法解析为真实路径，拒绝回放',
      'realpath(parent) failed'
    )
  })
  assertInsideRoot(realRoot, realParent)
  return { path: lexicalTarget, absent: true }
}

/** realpath(根目录)；目录尚不存在时退化用词法根（不因此拒掉合法回放） */
async function resolveRealRoot(
  realPath: (path: string) => Promise<string>,
  sessionRoot: string
): Promise<string> {
  return realPath(resolve(sessionRoot)).catch(() => resolve(sessionRoot))
}

/** 真实路径必须落在（真实）会话根内，否则 `PATH_DENIED` */
function assertInsideRoot(realRoot: string, realTarget: string): void {
  const normalizedRoot = normalizeForCompare(realRoot)
  const normalizedTarget = normalizeForCompare(realTarget)
  const inside =
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
  if (!inside) {
    throw new IpcFailure(
      'PATH_DENIED',
      '会话文件真实路径不在当前会话根目录内（疑似符号链接/junction 逃逸），拒绝回放',
      `realTarget=${truncateForMessage(realTarget)}`
    )
  }
}

/** 「文件/目录不存在」（ENOENT）；其余错误（EACCES 等）不算 */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/** 空会话（fork 后新会话文件尚未落盘）：明确给出 `fileAbsent: true`，不伪造 truncated */
function absentHistory(): SessionHistoryOutput {
  return {
    records: [],
    truncated: false,
    messageCount: 0,
    totalRecords: 0,
    fileAbsent: true
  }
}

/**
 * 词法路径收敛（§7 约束 8 的第一道闸）：只会话根目录内的 `*.jsonl` 可读。
 * 相对路径按会话根解析；任何逃逸（`../`、绝对路径越界）一律 PATH_DENIED。
 *
 * 注意：**这里只做字符串层面判定**，符号链接/junction 需要
 * {@link resolveRealSessionPath} 做真实路径二次校验，两者缺一不可。
 */
export function resolveSessionPath(sessionRoot: string, sessionFile: string): string {
  const root = resolve(sessionRoot)
  const target = isAbsolute(sessionFile) ? resolve(sessionFile) : resolve(root, sessionFile)
  const normalizedRoot = normalizeForCompare(root)
  const normalizedTarget = normalizeForCompare(target)
  const inside =
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
  if (!inside) {
    throw new IpcFailure(
      'PATH_DENIED',
      '会话文件不在当前会话根目录内，拒绝回放',
      `sessionFile=${truncateForMessage(sessionFile)}`
    )
  }
  if (!normalizedTarget.endsWith('.jsonl')) {
    throw new IpcFailure('PATH_DENIED', '只允许回放 .jsonl 会话文件')
  }
  return target
}

/** 比较用归一：正斜杠 + Windows 语义下小写（与 session-index 的 samePath 保持一致） */
function normalizeForCompare(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const windowsLike = /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//')
  return process.platform === 'win32' || windowsLike ? slashed.toLowerCase() : slashed
}

/**
 * 持久化条目 → 回放记录。
 *
 * 只映射会话消息条目：`{type:'message', message}` → `{type:'message_end', message}`。
 * 这样 reducer 只有一条「权威消息」入口，历史回放与实时事件共用同一套归约（§5.5）。
 */
export function toReplayRecords(
  entries: Array<{ type?: unknown; message?: unknown }>
): SessionHistoryRecord[] {
  const records: SessionHistoryRecord[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = asRecord(entry.message)
    if (message === undefined) continue
    records.push({ type: 'message_end', message })
  }
  return records
}

/** 解析 JSONL 文本；`dropFirstLine` 用于尾部回放时丢弃被切半的首行 */
export function parseEntries(
  text: string,
  options: { dropFirstLine?: boolean } = {}
): Array<Record<string, unknown>> {
  const lines = text.split('\n')
  const entries: Array<Record<string, unknown>> = []
  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0 && options.dropFirstLine === true) continue
    const raw = lines[index]
    if (raw === undefined) continue
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 损坏行/被截断的尾行：跳过，不影响其余条目
      continue
    }
    const record = asRecord(parsed)
    if (record === undefined) continue
    entries.push(record)
  }
  return entries
}

async function readTailBytes(
  filePath: string,
  maxBytes: number
): Promise<{ text: string; size: number }> {
  const info = await stat(filePath)
  const size = info.size
  const start = size > maxBytes ? size - maxBytes : 0
  const length = size - start
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size }
  } finally {
    await handle.close()
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function truncateForMessage(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value
}
