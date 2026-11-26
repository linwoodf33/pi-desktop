import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SessionListOutput, SessionSummary } from '../../shared/contracts/types'

import {
  DEFAULT_TAIL_MAX_SCAN_BYTES,
  DEFAULT_TAIL_WINDOW_BYTES,
  findLastRecordInTail,
  type RecordPredicate
} from './session-tail'

/**
 * SessionIndex（架构文档 §5.2、§10 A3）：只读扫描 pi 的会话 JSONL，产出摘要。
 *
 * 约束：
 * - **只读**，绝不写会话文件；
 * - 头部窗口（默认 32KB）拿 header / cwd / 早期 `session_info` / 首条用户消息；
 * - 头部拿不到名字时，再**反向扫描尾部**（窗口 128KB、最多 2MB）取**最后一条** `session_info`
 *   —— 改名记录一定落在文件尾（`pi-session-name.ts` 与 pi 的 `set_session_name` 都只 append）；
 * - 头部连「首条用户消息」都没有时（单条记录就能有 50KB+），做**有上限**（512KB）的前向补扫；
 * - 默认按 mtime 倒序，首屏 20 条，用 offset 游标分页；
 * - 20 条约 20 次「32KB 头部（+ 变更文件的尾部窗口）」，远低于 §10 A3 的 1s 预算。
 *
 * 目录布局（docs/session-format.md）：`<sessionsRoot>/--<path>--/<timestamp>_<session-id>.jsonl`。
 */
export interface SessionIndexQuery {
  cwd?: string
  cursor?: string
}

export interface SessionIndex {
  list(query: SessionIndexQuery): Promise<SessionListOutput>
  /** 当前使用的会话根目录（诊断用） */
  root(): string
  /**
   * 丢弃摘要缓存（A23：改名后显式失效）。
   *
   * 不传参数 = 清空全部；传文件路径 = 只删该文件（含 Windows 大小写归一后的等价键）。
   * mtime 缓存本身已能覆盖「append 改名」，但同一毫秒内的两次写 / 粗粒度 FS
   * 会让 mtime 不变，所以调用方写成功后显式失效一次。
   */
  invalidate(filePath?: string): void
}

export interface SessionIndexOptions {
  /** 会话根目录覆盖（设置项 `sessionDir` / `PI_CODING_AGENT_SESSION_DIR`） */
  sessionDir?: () => string | undefined
  env?: NodeJS.ProcessEnv
  homeDir?: string
  pageSize?: number
  /** 单文件读取上限（头部） */
  headBytes?: number
  /** 尾部窗口字节数（改名记录在文件尾；默认 128KB） */
  tailBytes?: number
  /** 尾部最多反向扫描的字节数（默认 2MB；超过就放弃尾部查找） */
  tailMaxScanBytes?: number
  /** 头部什么标题都没拿到时的前向补扫上限（默认 512KB） */
  forwardBytes?: number
  /** 摘要缓存上限（默认 5000；超限按「最早插入」淘汰） */
  cacheLimit?: number
  listDir?: (path: string) => Promise<Array<{ name: string; isDirectory: () => boolean }>>
  statFile?: (path: string) => Promise<{ mtimeMs: number; size?: number }>
  readHead?: (path: string, maxBytes: number) => Promise<string>
  /** 前向补扫读取器（读 [0, maxBytes)）；默认与 `readHead` 同一实现 */
  readForward?: (path: string, maxBytes: number) => Promise<string>
  /** 尾部记录查找（测试注入；默认走 `session-tail.findLastRecordInTail`） */
  findTailRecord?: (
    path: string,
    predicate: RecordPredicate
  ) => Promise<Record<string, unknown> | undefined>
}

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_HEAD_BYTES = 32 * 1024
const DEFAULT_FORWARD_BYTES = 512 * 1024
const DEFAULT_CACHE_LIMIT = 5000

/**
 * 摘要缓存条目（§10 A3 的 mtime 缓存）。
 *
 * 会话 JSONL 只追加不重写，mtime 不变 = 内容不变，所以可安全复用上次解析结果。
 * 万级会话时，命中缓存就不再读那 32KB 头部（A3 要求「万级不退化」）。
 */
interface CacheEntry {
  mtimeMs: number
  summary: SessionSummary | undefined
}

/** `~/.pi/agent/sessions/`（docs/sessions.md 的默认位置） */
export function defaultSessionsRoot(env: NodeJS.ProcessEnv, homeDir: string): string {
  const fromEnv = env['PI_CODING_AGENT_SESSION_DIR']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homeDir, '.pi', 'agent', 'sessions')
}

export function createSessionIndex(options: SessionIndexOptions = {}): SessionIndex {
  const env = options.env ?? process.env
  const home = options.homeDir ?? env['USERPROFILE'] ?? env['HOME'] ?? homedir()
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_WINDOW_BYTES
  const tailMaxScanBytes = options.tailMaxScanBytes ?? DEFAULT_TAIL_MAX_SCAN_BYTES
  const forwardBytes = options.forwardBytes ?? DEFAULT_FORWARD_BYTES
  const listDir = options.listDir ?? (async (path) => readdir(path, { withFileTypes: true }))
  const statFile = options.statFile ?? (async (path) => stat(path))
  const readHead = options.readHead ?? readHeadBytes
  const readForward = options.readForward ?? readHeadBytes
  const findTailRecord =
    options.findTailRecord ??
    ((path: string, predicate: RecordPredicate) =>
      findLastRecordInTail(path, predicate, {
        windowBytes: tailBytes,
        maxScanBytes: tailMaxScanBytes
      }))
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT
  /** filePath → { mtimeMs, summary }（mtime 不变就不重读） */
  const cache = new Map<string, CacheEntry>()

  const summarizeDeps: SummarizeDeps = {
    readHead,
    headBytes,
    findTailRecord,
    readForward,
    forwardBytes
  }

  /**
   * 按 mtime 取摘要：命中缓存直接复用；未命中读头部/尾部并写入。
   * 缓存是 **per-root** 的（root 变化就清空，避免会话目录覆盖后拿到旧摘要）。
   */
  async function summarizeCached(
    filePath: string,
    mtimeMs: number,
    size: number | undefined
  ): Promise<SessionSummary | undefined> {
    const cached = cache.get(filePath)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      // 刷新 LRU 顺序（Map 保插入序，删除后重插即最近使用）
      cache.delete(filePath)
      cache.set(filePath, cached)
      return cached.summary
    }
    const summary = await summarize(filePath, summarizeDeps, mtimeMs, size)
    cache.set(filePath, { mtimeMs, summary })
    if (cache.size > cacheLimit) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    return summary
  }

  function root(): string {
    const configured = options.sessionDir?.()
    if (configured !== undefined && configured.length > 0) return configured
    return defaultSessionsRoot(env, home)
  }

  function invalidate(filePath?: string): void {
    if (filePath === undefined) {
      cache.clear()
      return
    }
    cache.delete(filePath)
    const wanted = normalizeCacheKey(filePath)
    for (const key of [...cache.keys()]) {
      if (normalizeCacheKey(key) === wanted) cache.delete(key)
    }
  }

  /** 上一次 list 用的根；变化时清空缓存（设置页会话目录覆盖后不能拿旧摘要） */
  let cachedRoot: string | undefined

  return {
    root,
    invalidate,

    async list(query) {
      const sessionsRoot = root()
      if (cachedRoot !== sessionsRoot) {
        cache.clear()
        cachedRoot = sessionsRoot
      }
      let groups: Array<{ name: string; isDirectory: () => boolean }>
      try {
        groups = await listDir(sessionsRoot)
      } catch {
        // 还没装过 pi / 没跑过会话：空列表不是错误（§6.1 第 3 步）
        return { items: [] }
      }

      const files: string[] = []
      for (const group of groups) {
        if (!group.isDirectory()) continue
        const groupPath = join(sessionsRoot, group.name)
        let entries: Array<{ name: string; isDirectory: () => boolean }>
        try {
          entries = await listDir(groupPath)
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.isDirectory()) continue
          if (!entry.name.endsWith('.jsonl')) continue
          files.push(join(groupPath, entry.name))
        }
      }

      const withStats = await Promise.all(
        files.map(
          async (filePath): Promise<{ filePath: string; mtimeMs: number; size?: number }> => {
            try {
              const info = await statFile(filePath)
              return {
                filePath,
                mtimeMs: info.mtimeMs,
                ...(info.size === undefined ? {} : { size: info.size })
              }
            } catch {
              return { filePath, mtimeMs: 0 }
            }
          }
        )
      )
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)

      const summaries: SessionSummary[] = []
      for (const item of withStats) {
        const summary = await summarizeCached(item.filePath, item.mtimeMs, item.size)
        if (!summary) continue
        if (query.cwd !== undefined && !samePath(summary.cwd, query.cwd)) continue
        summaries.push(summary)
      }

      // 清理已消失文件的缓存（否则删除会话后缓存只增不减）
      if (cache.size > withStats.length) {
        const alive = new Set(withStats.map((item) => item.filePath))
        for (const filePath of [...cache.keys()]) {
          if (!alive.has(filePath)) cache.delete(filePath)
        }
      }

      const offset = parseCursor(query.cursor)
      const page = summaries.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      return {
        items: page,
        ...(nextOffset < summaries.length ? { nextCursor: String(nextOffset) } : {})
      }
    }
  }
}

interface SummarizeDeps {
  readHead: (path: string, maxBytes: number) => Promise<string>
  headBytes: number
  findTailRecord: (
    path: string,
    predicate: RecordPredicate
  ) => Promise<Record<string, unknown> | undefined>
  readForward: (path: string, maxBytes: number) => Promise<string>
  forwardBytes: number
}

/** 尾部查找的谓词：只认带 `name` 字段的 `session_info`（空名在下面按「没名字」处理） */
const isSessionInfoWithName: RecordPredicate = (record) =>
  record['type'] === 'session_info' && typeof record['name'] === 'string'

/**
 * 解析一段 JSONL 窗口，产出摘要字段。
 *
 * 头部窗口与「前向补扫窗口」共用本函数：两者都是从 offset 0 开始的完整前缀，
 * 遇到更靠后的记录时后者覆盖前者（`session_info` 的后覆盖前语义）。
 */
function scanWindow(text: string): {
  id?: string
  cwd?: string
  headerTimestamp?: string
  title?: string
  name?: string
} {
  const result: {
    id?: string
    cwd?: string
    headerTimestamp?: string
    title?: string
    name?: string
  } = {}

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim().length === 0) continue
    // 窗口可能截断最后一行，跳过无法解析的行即可
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(entry)
    if (record === undefined) continue

    if (record['type'] === 'session') {
      if (typeof record['id'] === 'string') result.id = record['id']
      if (typeof record['cwd'] === 'string') result.cwd = record['cwd']
      if (typeof record['timestamp'] === 'string') result.headerTimestamp = record['timestamp']
      continue
    }
    if (record['type'] === 'session_info' && typeof record['name'] === 'string') {
      result.name = record['name']
      continue
    }
    if (result.title === undefined && record['type'] === 'message') {
      const message = asRecord(record['message'])
      if (message?.['role'] === 'user') {
        const text = extractText(message['content'])
        if (text !== undefined && text.trim().length > 0) result.title = text.trim().slice(0, 120)
      }
    }
  }

  return result
}

/** 解析窗口，产出摘要；header 缺失/损坏的文件直接跳过（不让脏文件拖垮列表） */
async function summarize(
  filePath: string,
  deps: SummarizeDeps,
  mtimeMs: number,
  size: number | undefined
): Promise<SessionSummary | undefined> {
  let head: string
  try {
    head = await deps.readHead(filePath, deps.headBytes)
  } catch {
    return undefined
  }

  const fromHead = scanWindow(head)
  const id = fromHead.id
  if (id === undefined) return undefined
  let title = fromHead.title
  let name = fromHead.name

  /** 头部窗口之外的字节还需要再看一眼（`size` 未知时按「需要」处理，宁多读一次） */
  const beyondHead = size === undefined || size > deps.headBytes

  // 头部 32KB 常常连「首条用户消息」都覆盖不到（实测单条记录就有 52KB+）。
  // 只有头部什么标题都没拿到时才做有上限的前向补扫，正常文件不受影响。
  if (beyondHead && name === undefined && title === undefined) {
    const limit = Math.min(size ?? deps.forwardBytes, deps.forwardBytes)
    if (limit > deps.headBytes) {
      try {
        const forward = scanWindow(await deps.readForward(filePath, limit))
        name = forward.name
        title = forward.title
      } catch {
        // fail-soft：补扫失败就退回「未命名会话」
      }
    }
  }

  // 改名（`/name`、RPC `set_session_name`、历史任务 append）产生的 `session_info`
  // **只追加在文件尾**，头部窗口永远看不到最新值 → 反向扫描尾部，last-wins。
  let tailName: string | undefined
  if (beyondHead) {
    try {
      const record = await deps.findTailRecord(filePath, isSessionInfoWithName)
      tailName = normalizeName(record?.['name'])
    } catch {
      // fail-soft：尾部读失败（删除/权限/写盘中的半行）不影响列表可用性
    }
  }

  const updatedAt = new Date(mtimeMs).toISOString()
  return {
    id,
    title: tailName ?? normalizeName(name) ?? title ?? '(未命名会话)',
    cwd: fromHead.cwd ?? '',
    updatedAt:
      fromHead.headerTimestamp !== undefined && mtimeMs === 0
        ? fromHead.headerTimestamp
        : updatedAt,
    filePath
  }
}

/** 空串 / 纯空白视为「没有名字」（不能把标题清成空白） */
function normalizeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] === 'text' && typeof record['text'] === 'string')
      parts.push(record['text'])
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 只读前 maxBytes 字节（不把大文件读进内存） */
async function readHeadBytes(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * 缓存键归一：Windows 大小写不敏感，`\` 与 `/` 等价。
 * （8.3 短名与长名的等价由调用方 realpath 后传入解决。）
 */
function normalizeCacheKey(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** Windows 大小写不敏感比较 */
function samePath(a: string, b: string): boolean {
  if (a.length === 0) return false
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value
  return normalize(a) === normalize(b)
}
