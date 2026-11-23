import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SessionListOutput, SessionSummary } from '../../shared/contracts/types'

/**
 * SessionIndex（架构文档 §5.2、§10 A3）：只读扫描 pi 的会话 JSONL，产出摘要。
 *
 * 约束：
 * - **只读**，绝不写会话文件；
 * - 每个文件只读头部若干字节（默认 32KB）就够拿到 header / 标题，不把 100MB 会话读进内存（§9.1 U13 同源要求）；
 * - 默认按 mtime 倒序，首屏 20 条，用 offset 游标分页；
 * - 20 条约 20 次 32KB 头部读取，远低于 §10 A3 的 1s 预算。
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
}

export interface SessionIndexOptions {
  /** 会话根目录覆盖（设置项 `sessionDir` / `PI_CODING_AGENT_SESSION_DIR`） */
  sessionDir?: () => string | undefined
  env?: NodeJS.ProcessEnv
  homeDir?: string
  pageSize?: number
  /** 单文件读取上限（头部） */
  headBytes?: number
  /** 摘要缓存上限（默认 5000；超限按「最早插入」淘汰） */
  cacheLimit?: number
  listDir?: (path: string) => Promise<Array<{ name: string; isDirectory: () => boolean }>>
  statFile?: (path: string) => Promise<{ mtimeMs: number }>
  readHead?: (path: string, maxBytes: number) => Promise<string>
}

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_HEAD_BYTES = 32 * 1024
const DEFAULT_CACHE_LIMIT = 5000

/**
 * 摘要缓存条目（§10 A3 的 mtime 缓存）。
 *
 * 会话 JSONL 只追加不重写，mtime 不变 = 头部内容不变，所以可以安全复用上次解析结果。
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
  const listDir = options.listDir ?? (async (path) => readdir(path, { withFileTypes: true }))
  const statFile = options.statFile ?? (async (path) => stat(path))
  const readHead = options.readHead ?? readHeadBytes
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT
  /** filePath → { mtimeMs, summary }（mtime 不变就不重读头部） */
  const cache = new Map<string, CacheEntry>()

  /**
   * 按 mtime 取摘要：命中缓存直接复用；未命中读头部并写入。
   * 缓存是 **per-root** 的（root 变化就清空，避免会话目录覆盖后拿到旧摘要）。
   */
  async function summarizeCached(
    filePath: string,
    mtimeMs: number
  ): Promise<SessionSummary | undefined> {
    const cached = cache.get(filePath)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      // 刷新 LRU 顺序（Map 保插入序，删除后重插即最近使用）
      cache.delete(filePath)
      cache.set(filePath, cached)
      return cached.summary
    }
    const summary = await summarize(filePath, readHead, headBytes, mtimeMs)
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

  /** 上一次 list 用的根；变化时清空缓存（设置页会话目录覆盖后不能拿旧摘要） */
  let cachedRoot: string | undefined

  return {
    root,

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
        files.map(async (filePath) => {
          try {
            const info = await statFile(filePath)
            return { filePath, mtimeMs: info.mtimeMs }
          } catch {
            return { filePath, mtimeMs: 0 }
          }
        })
      )
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)

      const summaries: SessionSummary[] = []
      for (const item of withStats) {
        const summary = await summarizeCached(item.filePath, item.mtimeMs)
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

/** 解析头部字节，产出摘要；header 缺失/损坏的文件直接跳过（不让脏文件拖垮列表） */
async function summarize(
  filePath: string,
  readHead: (path: string, maxBytes: number) => Promise<string>,
  headBytes: number,
  mtimeMs: number
): Promise<SessionSummary | undefined> {
  let head: string
  try {
    head = await readHead(filePath, headBytes)
  } catch {
    return undefined
  }

  const lines = head.split('\n')
  let id: string | undefined
  let cwd: string | undefined
  let headerTimestamp: string | undefined
  let title: string | undefined
  let name: string | undefined

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim().length === 0) continue
    // 头部读取可能截断最后一行，跳过无法解析的行即可
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(entry)
    if (record === undefined) continue

    if (record['type'] === 'session') {
      if (typeof record['id'] === 'string') id = record['id']
      if (typeof record['cwd'] === 'string') cwd = record['cwd']
      if (typeof record['timestamp'] === 'string') headerTimestamp = record['timestamp']
      continue
    }
    if (record['type'] === 'session_info' && typeof record['name'] === 'string') {
      name = record['name']
      continue
    }
    if (title === undefined && record['type'] === 'message') {
      const message = asRecord(record['message'])
      if (message?.['role'] === 'user') {
        const text = extractText(message['content'])
        if (text !== undefined && text.trim().length > 0) title = text.trim().slice(0, 120)
      }
    }
  }

  if (id === undefined) return undefined
  const updatedAt = new Date(mtimeMs).toISOString()
  return {
    id,
    title: name ?? title ?? '(未命名会话)',
    cwd: cwd ?? '',
    updatedAt: headerTimestamp !== undefined && mtimeMs === 0 ? headerTimestamp : updatedAt,
    filePath
  }
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
