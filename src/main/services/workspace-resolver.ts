import { open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'

import { normalizeForCompare } from './path-guard'
import { resolveRealSessionPath, resolveSessionPath } from './session-history'

/**
 * 工作区根解析（M6）：把 renderer 传来的「会话引用」变成**可信的工作区根**。
 *
 * §5.4 的 `fs:*` 只给了 `sessionKey`，但产物面板还要服务两种现实情况：
 * - 活跃会话（有 sessionKey）：cwd 由 SessionService 提供（主进程事实，renderer 无法伪造）；
 * - 历史任务（只回放了 JSONL、没有子进程）：cwd 从会话 JSONL 的 header 读
 *   （路径先按会话根校验，与 `session:history` 同一道闸）。
 *
 * 安全要点：**根集合完全由主进程推导**，renderer 传进来的只有「引用」，不是根。
 * 因此不存在「renderer 指定任意目录 → 读任意文件」的通路（§9.4 S6 的等价项）。
 */

export interface WorkspaceRef {
  sessionKey?: string | undefined
  sessionFile?: string | undefined
}

export interface ResolvedWorkspace {
  /** 已 realpath 归一的工作区根（绝对路径） */
  root: string
  /** 来自哪个会话（诊断/审计用，不含文件内容） */
  source: { kind: 'session' | 'sessionFile'; id: string }
}

export interface WorkspaceResolverOptions {
  /** 活跃会话的 cwd（SessionService 提供）；不存在返回 undefined */
  liveCwd: (sessionKey: string) => string | undefined
  /** 当前全部活跃会话的 cwd（白名单用） */
  liveCwds?: () => readonly string[]
  /** 会话根目录（`SessionIndex.root()`） */
  sessionRoot: () => string
  /** 配置里的额外工作区根（`workspaceRoots`，M6 起参与白名单） */
  configRoots?: () => readonly string[]
  /** 测试注入：realpath */
  realPath?: (path: string) => Promise<string>
  /** 测试注入：读取会话文件头部文本 */
  readHead?: (path: string, maxBytes: number) => Promise<string>
}

export interface WorkspaceResolver {
  /** 解析会话引用 → 工作区根；引用缺失或不可信时抛 PATH_DENIED / NOT_FOUND */
  resolve(ref: WorkspaceRef): Promise<ResolvedWorkspace>
  /**
   * 当前已知的全部合法工作区根（活跃会话 cwd + 解析过的历史会话 cwd + 配置根）。
   * `fs:readText` / `artifact:open` 用绝对路径时按这个集合校验。
   */
  knownRoots(): Promise<string[]>
  /** 供 `evt:status=starting` 预热（记下活跃会话的 cwd，避免每次 realpath） */
  remember(ref: WorkspaceRef): void
}

const HEAD_BYTES = 8 * 1024

export function createWorkspaceResolver(options: WorkspaceResolverOptions): WorkspaceResolver {
  const realPath = options.realPath ?? ((value: string) => realpath(value))
  const readHead = options.readHead ?? readHeadBytes
  /** realpath(root) 缓存：根目录在应用生命周期内极少变化 */
  const rootCache = new Map<string, string>()
  /** 会话文件 → 其 header 里记录的 cwd（已归一） */
  const sessionFileCwd = new Map<string, string>()

  async function normalizeRoot(candidate: string): Promise<string> {
    const key = normalizeForCompare(candidate)
    const cached = rootCache.get(key)
    if (cached !== undefined) return cached
    const real = await realPath(resolve(candidate)).catch(() => {
      throw new IpcFailure('NOT_FOUND', '工作区目录不存在或不可访问', truncate(candidate))
    })
    rootCache.set(key, real)
    return real
  }

  async function resolveSessionKey(sessionKey: string): Promise<ResolvedWorkspace> {
    const cwd = options.liveCwd(sessionKey)
    if (cwd === undefined) {
      throw new IpcFailure(
        'SESSION_NOT_FOUND',
        '会话未在运行：请先继续对话（或改用会话文件引用）后再查看产物',
        'sessionKey 未注册'
      )
    }
    return { root: await normalizeRoot(cwd), source: { kind: 'session', id: sessionKey } }
  }

  async function resolveSessionFile(sessionFile: string): Promise<ResolvedWorkspace> {
    const root = options.sessionRoot()
    // 与会话回放同一道闸：词法收敛 + realpath 前缀校验（§7 约束 8）
    const lexical = resolveSessionPath(root, sessionFile)
    const real = await resolveRealSessionPath(realPath, root, lexical)

    const cached = sessionFileCwd.get(normalizeForCompare(real))
    if (cached !== undefined) {
      return { root: cached, source: { kind: 'sessionFile', id: real } }
    }

    const head = await readHead(real, HEAD_BYTES)
    const header = parseHeader(head)
    const cwd = header['cwd']
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new IpcFailure('PATH_DENIED', '会话文件里没有可用的工作目录记录，拒绝扫描')
    }
    const normalized = await normalizeRoot(cwd)
    sessionFileCwd.set(normalizeForCompare(real), normalized)
    return { root: normalized, source: { kind: 'sessionFile', id: real } }
  }

  return {
    async resolve(ref) {
      if (ref.sessionKey !== undefined && ref.sessionFile !== undefined) {
        throw new IpcFailure('VALIDATION', 'sessionKey 与 sessionFile 不能同时提供')
      }
      if (ref.sessionKey !== undefined) return resolveSessionKey(ref.sessionKey)
      if (ref.sessionFile !== undefined) return resolveSessionFile(ref.sessionFile)
      throw new IpcFailure(
        'VALIDATION',
        '缺少会话引用（sessionKey 或 sessionFile）：无法确定工作区根'
      )
    },

    async knownRoots() {
      const roots = new Set<string>()
      for (const extra of options.configRoots?.() ?? []) {
        if (extra.length === 0) continue
        await normalizeRoot(extra)
          .then((root) => roots.add(root))
          .catch(() => undefined)
      }
      for (const root of sessionFileCwd.values()) roots.add(root)
      // 活跃会话由 SessionService 提供（cwd 可能在会话过程中才出现）
      for (const cwd of options.liveCwds?.() ?? []) {
        await normalizeRoot(cwd)
          .then((root) => roots.add(root))
          .catch(() => undefined)
      }
      return [...roots]
    },

    remember(ref) {
      if (ref.sessionKey === undefined) return
      const cwd = options.liveCwd(ref.sessionKey)
      if (cwd === undefined) return
      const key = normalizeForCompare(cwd)
      if (rootCache.has(key)) return
      void realPath(resolve(cwd))
        .then((real) => rootCache.set(key, real))
        .catch(() => undefined)
    }
  }
}

/** 会话 JSONL 的 header（docs/session-format.md：第一条记录 `{type:'session', cwd, ...}`） */
export function parseHeader(head: string): Record<string, unknown> {
  const line = head.split('\n').find((item) => item.trim().length > 0)
  if (line === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

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

function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
