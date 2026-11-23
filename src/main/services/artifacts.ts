import { open, stat } from 'node:fs/promises'

import { IpcFailure } from '../../shared/contracts/result'
import type { ArtifactList, ReadTextResult, UnifiedDiff } from '../../shared/contracts/types'

import type { AuditLog } from './audit-log'
import {
  detectGitWorkspace,
  gitFileDiff,
  gitListChanges,
  defaultGitRunner,
  type GitRunner,
  type GitWorkspace
} from './git-adapter'
import { normalizeForCompare, resolveInsideAnyRoot, resolveWorkspaceTarget } from './path-guard'
import { createUnifiedDiff, truncatePatch } from './unified-diff'
import {
  compareSnapshots,
  isBinaryBuffer,
  takeSnapshot,
  type SnapshotOptions,
  type WorkspaceSnapshot
} from './workspace-snapshot'
import type { WorkspaceRef, WorkspaceResolver } from './workspace-resolver'

/**
 * 产物服务（M6，架构文档 §5.2 FsBridge 的「产物列表与 diff」、§6.1 产物流、§8.1 M6）。
 *
 * 触发时机**只有两个**：会话 `agent_settled`（renderer 收到事件后调一次）与用户手动刷新。
 * 这里不做轮询、不监听文件系统——非 git 回退链路要扫全树，轮询代价不可接受。
 *
 * 两条链路：
 * - **git 工作区**：`git status --porcelain=v1` 出列表，`git diff`（暂存 + 未暂存）出补丁；
 * - **非 git 工作区**：会话开始快照 → 重扫比对（size + mtime + 前 1MB sha1），
 *   补丁由 `unified-diff.ts` 合成。UI 必须显式标注「非 git 工作区，快照比对」。
 *
 * 全部通道共用 `path-guard.ts` 一个校验器；本模块只负责「拿到根 → 校验 → 产出受限数据」。
 */

/** 列表上限（超出显式标注 truncated，§7 约束 14） */
export const MAX_ARTIFACT_ENTRIES = 1000
/** 单文件 diff 上限 2MB */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024
/** 文本预览上限 64KB */
export const MAX_PREVIEW_BYTES = 64 * 1024
/** 预览默认读取字节数 */
export const DEFAULT_PREVIEW_BYTES = 64 * 1024

export interface ArtifactsLimits {
  maxEntries?: number
  maxDiffBytes?: number
  maxPreviewBytes?: number
}

export interface ArtifactsServiceOptions {
  resolver: WorkspaceResolver
  /** 测试注入：git 执行器 */
  runGit?: GitRunner
  /** 测试注入：realpath */
  realPath?: (path: string) => Promise<string>
  /** `shell.openPath` 语义：返回错误串（空串 = 成功） */
  openPath: (path: string) => Promise<string>
  audit: AuditLog
  now?: () => number
  limits?: ArtifactsLimits
  gitTimeoutMs?: number
  snapshotOptions?: SnapshotOptions
}

export interface ArtifactsService {
  /** 会话开始（`evt:status=starting`）：为**非 git 工作区**建立「会话开始快照」 */
  onSessionStarted(sessionKey: string): void
  list(input: WorkspaceRef): Promise<ArtifactList>
  diff(input: WorkspaceRef & { path: string }): Promise<UnifiedDiff>
  readText(
    input: WorkspaceRef & { path: string; maxBytes?: number; offset?: number }
  ): Promise<ReadTextResult>
  open(input: WorkspaceRef & { path: string }): Promise<{ ok: true }>
  /** 诊断/测试：当前持有快照的根（归一化后） */
  snapshotRoots(): string[]
}

export function createArtifactsService(options: ArtifactsServiceOptions): ArtifactsService {
  const runGit = options.runGit ?? defaultGitRunner
  const now = options.now ?? (() => Date.now())
  const maxEntries = options.limits?.maxEntries ?? MAX_ARTIFACT_ENTRIES
  const maxDiffBytes = options.limits?.maxDiffBytes ?? MAX_DIFF_BYTES
  const maxPreviewBytes = options.limits?.maxPreviewBytes ?? MAX_PREVIEW_BYTES
  const gitTimeoutMs = options.gitTimeoutMs ?? 10_000

  /** 工作区根（归一化） → 会话开始快照 */
  const snapshots = new Map<string, WorkspaceSnapshot>()

  async function detect(root: string): Promise<{ workspace?: GitWorkspace; reason?: string }> {
    try {
      return await detectGitWorkspace({
        workspaceRoot: root,
        run: runGit,
        timeoutMs: Math.min(gitTimeoutMs, 5_000)
      })
    } catch (error) {
      return { reason: `git 探测失败（${describe(error)}），回退到快照比对` }
    }
  }

  async function ensureSnapshot(
    root: string
  ): Promise<{ snapshot: WorkspaceSnapshot; created: boolean }> {
    const key = normalizeForCompare(root)
    const existing = snapshots.get(key)
    if (existing !== undefined) return { snapshot: existing, created: false }
    const snapshot = await takeSnapshot(root, options.snapshotOptions ?? {})
    snapshots.set(key, snapshot)
    return { snapshot, created: true }
  }

  async function snapshotAfter(root: string): Promise<WorkspaceSnapshot> {
    return takeSnapshot(root, options.snapshotOptions ?? {})
  }

  return {
    onSessionStarted(sessionKey) {
      // 异步、不阻塞会话创建；失败静默（首次 list 时会补建快照并在 note 里说明）
      void (async () => {
        const resolved = await options.resolver.resolve({ sessionKey }).catch(() => undefined)
        if (resolved === undefined) return
        const key = normalizeForCompare(resolved.root)
        if (snapshots.has(key)) return
        const git = await detect(resolved.root)
        // git 工作区不需要快照（git 自己知道基线）
        if (git.workspace !== undefined) return
        const snapshot = await takeSnapshot(resolved.root, options.snapshotOptions ?? {})
        if (!snapshots.has(key)) snapshots.set(key, snapshot)
      })()
    },

    async list(input) {
      const resolved = await options.resolver.resolve(input)
      const root = resolved.root
      const notes: string[] = []

      const git = await detect(root)
      if (git.workspace !== undefined) {
        const { entries, totalCount } = await gitListChanges({
          workspace: git.workspace,
          run: runGit,
          timeoutMs: gitTimeoutMs,
          maxEntries
        })
        return {
          items: entries,
          mode: 'git',
          root,
          truncated: totalCount > entries.length,
          totalCount,
          scannedAt: new Date(now()).toISOString()
        }
      }

      const started = await ensureSnapshot(root)
      const after = await snapshotAfter(root)
      if (started.created) {
        notes.push('快照在本次扫描时建立：此前的变更不可见')
      }
      notes.push(git.reason ?? '非 git 工作区，快照比对')
      if (!started.snapshot.complete || !after.complete) {
        notes.push(`快照不完整（超过扫描上限 ${started.snapshot.scanned} 个文件），结果可能遗漏`)
      }

      const { entries } = compareSnapshotPair(started.snapshot, after)
      const totalCount = entries.length
      return {
        items: entries.slice(0, maxEntries),
        mode: 'snapshot',
        root,
        truncated: totalCount > maxEntries,
        totalCount,
        scannedAt: new Date(now()).toISOString(),
        note: notes.join('；')
      }
    },

    async diff(input) {
      const resolved = await options.resolver.resolve(input)
      const root = resolved.root
      const target = await resolveWorkspaceTarget({
        root,
        raw: input.path,
        allowMissing: true,
        ...(options.realPath === undefined ? {} : { realPath: options.realPath })
      })
      const relative = target.relative

      const git = await detect(root)
      if (git.workspace !== undefined) {
        const listed = await gitListChanges({
          workspace: git.workspace,
          run: runGit,
          timeoutMs: gitTimeoutMs,
          maxEntries
        })
        const entry = listed.entries.find(
          (item) => normalizeForCompare(item.path) === normalizeForCompare(relative)
        )
        const result = await gitFileDiff({
          workspace: git.workspace,
          path: relative,
          ...(entry?.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
          ...(entry?.change === undefined ? {} : { change: entry.change }),
          run: runGit,
          timeoutMs: gitTimeoutMs
        })
        const trimmed = truncatePatch(result.patch, maxDiffBytes)
        if (trimmed.patch.trim().length > 0) {
          return {
            path: relative,
            patch: trimmed.patch,
            truncated: trimmed.truncated,
            mode: 'git',
            ...(entry?.change === undefined ? {} : { change: entry.change }),
            ...(entry?.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
            ...(result.binary ? { binary: true } : {})
          }
        }
        // 未跟踪文件没有 index/blob 可比：由文件内容合成「新增文件」补丁
        const synthesized = await synthesizeAddedDiff(root, relative, maxDiffBytes)
        return {
          path: relative,
          patch: synthesized.patch,
          truncated: synthesized.truncated,
          mode: 'git',
          ...(entry?.change === undefined ? {} : { change: entry.change }),
          ...(synthesized.binary ? { binary: true } : {}),
          ...(synthesized.note === undefined ? {} : { note: synthesized.note })
        }
      }

      const started = await ensureSnapshot(root)
      const after = await snapshotAfter(root)
      const { details } = compareSnapshotPair(started.snapshot, after)
      const detail = details.find(
        (item) => normalizeForCompare(item.path) === normalizeForCompare(relative)
      )
      if (detail === undefined) {
        // 文件存在但内容与快照一致：给一个明确的「无变更」，而不是空补丁让人以为出错
        const info = await stat(target.realPath).catch(() => undefined)
        if (info === undefined || !info.isFile()) {
          throw new IpcFailure('NOT_FOUND', '目标文件不存在（可能已被删除）', relative)
        }
        return {
          path: relative,
          patch: '',
          truncated: false,
          mode: 'snapshot',
          change: 'modified',
          note: '与会的会话开始快照相比没有内容变化'
        }
      }

      const binary = detail.after?.binary === true || detail.before?.binary === true
      if (binary) {
        return {
          path: relative,
          patch: '',
          truncated: false,
          mode: 'snapshot',
          change: detail.change,
          binary: true,
          note: '二进制文件：不渲染 diff，请用系统程序打开'
        }
      }

      const needBeforeContent = detail.change !== 'added'
      if (needBeforeContent && detail.before?.content === undefined) {
        return {
          path: relative,
          patch: '',
          truncated: false,
          mode: 'snapshot',
          change: detail.change,
          note: '快照未保留原始内容（文件超过快照内容上限），无法生成逐行 diff'
        }
      }
      if (detail.change !== 'deleted' && detail.after?.content === undefined) {
        return {
          path: relative,
          patch: '',
          truncated: false,
          mode: 'snapshot',
          change: detail.change,
          note: '文件过大或为二进制，快照未保留当前内容，无法生成逐行 diff'
        }
      }

      const patch = createUnifiedDiff({
        oldPath: detail.change === 'added' ? null : detail.path,
        newPath: detail.change === 'deleted' ? null : detail.path,
        before: detail.before?.content ?? null,
        after: detail.after?.content ?? null
      })
      const trimmed = truncatePatch(patch, maxDiffBytes)
      return {
        path: relative,
        patch: trimmed.patch,
        truncated: trimmed.truncated,
        mode: 'snapshot',
        change: detail.change
      }
    },

    async readText(input) {
      const maxBytes = Math.min(input.maxBytes ?? DEFAULT_PREVIEW_BYTES, maxPreviewBytes)
      const offset = input.offset ?? 0
      const target = await resolveForRead(input)

      const info = await stat(target.realPath).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        throw new IpcFailure('NOT_FOUND', '目标不是可预览的文件', target.relative)
      }
      if (offset > info.size) {
        throw new IpcFailure(
          'VALIDATION',
          'offset 超过文件大小',
          `offset=${offset} size=${info.size}`
        )
      }

      const buffer = await readRange(target.realPath, offset, maxBytes)
      const decoded = decodeText(buffer)
      const truncated = offset + buffer.length < info.size
      if (decoded === undefined || isBinaryBuffer(buffer)) {
        return {
          path: target.relative,
          text: '',
          truncated,
          binary: true,
          sizeBytes: info.size,
          offset
        }
      }
      return {
        path: target.relative,
        text: decoded,
        truncated,
        binary: false,
        sizeBytes: info.size,
        offset
      }
    },

    async open(input) {
      const target = await resolveForRead(input).catch((error: unknown) => {
        options.audit.record({
          action: 'artifact:open',
          target: sanitizeAuditPath(input.path),
          outcome: 'denied',
          ...(error instanceof IpcFailure ? { code: error.code } : { code: 'INTERNAL' })
        })
        throw error
      })

      const info = await stat(target.realPath).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        options.audit.record({
          action: 'artifact:open',
          target: target.relative,
          outcome: 'denied',
          code: 'NOT_FOUND'
        })
        throw new IpcFailure('NOT_FOUND', '文件不存在或不是普通文件，无法打开', target.relative)
      }

      const error = await options
        .openPath(target.realPath)
        .catch((cause: unknown) => describe(cause))
      if (error.length > 0) {
        options.audit.record({
          action: 'artifact:open',
          target: target.relative,
          outcome: 'failed',
          code: 'OPEN_FAILED'
        })
        throw new IpcFailure(
          'OPEN_FAILED',
          '系统默认程序无法打开该文件（可用「在文件夹中定位」或手动打开）',
          truncateMessage(error)
        )
      }
      options.audit.record({ action: 'artifact:open', target: target.relative, outcome: 'opened' })
      return { ok: true }
    },

    snapshotRoots() {
      return [...snapshots.keys()]
    }
  }

  /**
   * 读类通道的路径解析：
   * - 有会话引用 → 必须落在**该会话**的工作区内（最严格）；
   * - 没有会话引用 → 必须落在主进程推导的任一已知工作区内（根集合不可由 renderer 新增）。
   */
  async function resolveForRead(
    input: WorkspaceRef & { path: string }
  ): Promise<{ realPath: string; relative: string }> {
    if (input.sessionKey !== undefined || input.sessionFile !== undefined) {
      const resolved = await options.resolver.resolve(input)
      return resolveWorkspaceTarget({
        root: resolved.root,
        raw: input.path,
        ...(options.realPath === undefined ? {} : { realPath: options.realPath })
      })
    }
    const roots = await options.resolver.knownRoots()
    if (roots.length === 0) {
      throw new IpcFailure(
        'PATH_DENIED',
        '尚未打开任何工作区：请先选择任务（需要会话的工作目录）再访问文件'
      )
    }
    return resolveInsideAnyRoot({
      roots,
      raw: input.path,
      ...(options.realPath === undefined ? {} : { realPath: options.realPath })
    })
  }
}

/** 快照对 → 条目 + 明细（集中在这里，保证 list/diff 用同一套判定） */
function compareSnapshotPair(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): ReturnType<typeof compareSnapshots> {
  return compareSnapshots(before, after)
}

/** 未跟踪文件在 git 模式下 diff 为空：用文件内容合成「新增文件」补丁 */
async function synthesizeAddedDiff(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<{ patch: string; truncated: boolean; binary?: boolean; note?: string }> {
  const target = await resolveWorkspaceTarget({ root, raw: relativePath, allowMissing: false })
  const info = await stat(target.realPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    return { patch: '', truncated: false, note: '文件已不存在，无 diff 可显示' }
  }
  const buffer = await readRange(target.realPath, 0, maxBytes)
  if (isBinaryBuffer(buffer)) return { patch: '', truncated: false, binary: true }
  // 同样容忍末尾被切断的多字节字符（合成 diff 也会分页读）
  const text = decodeText(buffer) ?? buffer.toString('utf8')
  const patch = createUnifiedDiff({
    oldPath: null,
    newPath: relativePath,
    before: null,
    after: text
  })
  const trimmed = truncatePatch(patch, maxBytes)
  return {
    patch: trimmed.patch,
    truncated: trimmed.truncated,
    ...(trimmed.truncated ? { note: '文件超过上限，补丁已按行截断' } : {})
  }
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * UTF-8 解码（**对末尾截断容忍**）。
 *
 * 预览是分页读取的（`offset` / `maxBytes`），切点完全可能落在多字节字符中间：
 * 严格解码会因此失败，而旧实现把失败直接当「二进制」→ 整段文本不显示。
 *
 * 策略（不放宽「真二进制」判定）：
 * - 先 `fatal: true` 严格解——完整 UTF-8 直接返回，零代价；
 * - 失败时只看**末尾**：若末尾是一个「被切成半截」的合法序列（lead byte 声明 2/3/4 字节，
 *   但后面的字节不够）→ 丢掉这半截后重试；
 * - 其余情况（中段非法字节、非法 lead byte、末尾完整但内容非法）→ 返回 undefined，仍当二进制。
 *
 * 为什么不能「无脑回退 1..3 字节」：那会把末尾附近的脏字节（如 0xff）当成被切断的尾巴，
 * 于是脏文本被当正文渲染。本实现用 UTF-8 自身的序列长度声明判定「确实是半截」。
 *
 * 语义边界：被丢掉的只是末尾不完整的字符，调用方的 `truncated` 仍按文件大小计算，
 * 因此不丢信息（翻页到下一页就能读到它）。
 */
function decodeText(buffer: Buffer): string | undefined {
  const strict = (bytes: Buffer): string | undefined => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  }
  const whole = strict(buffer)
  if (whole !== undefined) return whole

  const drop = trailingIncompleteLength(buffer)
  if (drop === 0) return undefined
  return strict(buffer.subarray(0, buffer.length - drop))
}

/** UTF-8 序列声明的总字节数；非法 lead byte（含孤立续字节 0x80-0xc1、0xf5-0xff）返回 0 */
function expectedSequenceLength(byte: number): number {
  if (byte < 0x80) return 1
  if (byte >= 0xc2 && byte <= 0xdf) return 2
  if (byte >= 0xe0 && byte <= 0xef) return 3
  if (byte >= 0xf0 && byte <= 0xf4) return 4
  return 0
}

/**
 * 末尾被切断的序列长度（字节数）；`0` = 末尾没有「半截合法序列」。
 *
 * 从末尾回扫最多 4 字节找 lead byte：找到后比较「已有字节数」与「声明的字节数」。
 */
function trailingIncompleteLength(buffer: Buffer): number {
  const max = Math.min(4, buffer.length)
  for (let taken = 1; taken <= max; taken += 1) {
    const byte = buffer[buffer.length - taken]
    if (byte === undefined) return 0
    // 续字节（10xxxxxx）→ 继续往前找 lead
    if ((byte & 0b1100_0000) === 0b1000_0000) continue
    const expected = expectedSequenceLength(byte)
    if (expected === 0) return 0
    return taken < expected ? taken : 0
  }
  // 末尾 4 字节全是续字节：不可能由「一个字符被切断」解释 → 当脏数据
  return 0
}

/** 审计用路径脱敏：只保留文件名级别的信息，避免把绝对路径写进日志 */
function sanitizeAuditPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  return segments.slice(-2).join('/') || '(invalid)'
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

function truncateMessage(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
