import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ArtifactChange, ArtifactEntry } from '../../shared/contracts/types'

import { isInsideRoot, toPosixRelative } from './path-guard'

/**
 * 只读 git 适配层（M6，架构文档 §6.1 产物流第 2 步）。
 *
 * 严格只执行**只读**命令：`git rev-parse`、`git status --porcelain`、`git diff`、`git show`。
 * 全部用 `execFile`（`shell:false`）+ 数组参数，cwd 固定为工作区根，路径一律走
 * `--` 分隔符 + `:(literal)` magic，杜绝参数注入与通配展开（§7 约束 11 同一思路）。
 *
 * 三条关键取舍：
 * 1. **工作区 ≠ 仓库根**时：git 输出的是「仓库根相对」路径。这里用 `rev-parse --show-toplevel`
 *    拿到仓库根，只保留落在工作区内的条目并换算成工作区相对路径，其余一律不显示
 *    （否则 UI 会列出用户根本没在编辑的文件）。
 * 2. **已暂存 + 未暂存都覆盖**：分两次取 `diff --cached`（HEAD→index）与 `diff`（index→worktree）
 *    再按「先暂存后未暂存」顺序拼接。不用 `git diff HEAD`：那要求仓库至少有一次提交，
 *    且对「部分暂存」的中间态不可分辨。
 * 3. **未跟踪文件**没有 index/blob 可比，`git diff` 对它返回空——改为按文件内容在本模块内
 *    合成「新增文件」补丁（`/dev/null` → 全文），与 git 的 `new file` 同形。
 */

export interface GitRunResult {
  code: number
  stdout: Buffer
  stderr: string
}

export type GitRunner = (
  args: readonly string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<GitRunResult>

/** 默认实现：`execFile`（`shell:false`），stdout 用 Buffer 承接（`-z` 输出含 NUL） */
export const defaultGitRunner: GitRunner = (args, options) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer'
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1
        resolvePromise({
          code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
        })
      }
    )
  })

export interface GitWorkspace {
  /** 仓库根（绝对路径，已 realpath） */
  repoRoot: string
  /** 工作区根（绝对路径，已 realpath） */
  workspaceRoot: string
  /** 工作区相对仓库根的前缀（POSIX；仓库根 == 工作区时为 ''） */
  prefix: string
}

export interface DetectGitOptions {
  workspaceRoot: string
  run?: GitRunner
  timeoutMs?: number
}

/**
 * 探测工作区是否在 git 仓库内（只读）。
 *
 * 返回 `undefined` 表示「不是 git 工作区 / git 不可用」——调用方据此回退到快照比对，
 * 并在 `note` 里说明原因（不能静默降级）。
 */
export async function detectGitWorkspace(
  options: DetectGitOptions
): Promise<{ workspace?: GitWorkspace; reason?: string }> {
  const run = options.run ?? defaultGitRunner
  const timeoutMs = options.timeoutMs ?? 5_000
  const workspaceRoot = resolve(options.workspaceRoot)

  const toplevel = await run(['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, timeoutMs })
  if (toplevel.code !== 0) {
    const stderr = toplevel.stderr.trim()
    return {
      reason:
        stderr.includes('not a git repository') || stderr.length === 0
          ? '非 git 工作区，快照比对'
          : `git 不可用（${firstLine(stderr)}），回退到快照比对`
    }
  }
  const repoRoot = resolve(toplevel.stdout.toString('utf8').trim())
  if (!isInsideRoot(repoRoot, workspaceRoot)) {
    return { reason: '工作区不在 git 仓库根内，回退到快照比对' }
  }
  const prefix = toPosixRelative(repoRoot, workspaceRoot)
  return {
    workspace: {
      repoRoot,
      workspaceRoot,
      prefix: prefix === '' || prefix.startsWith('..') ? '' : prefix
    }
  }
}

export interface GitStatusEntry {
  path: string
  change: ArtifactChange
  oldPath?: string
  untracked?: boolean
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出。
 *
 * `-z` 形态：`XY <space?>path\0`，重命名/复制条目额外跟一个 `oldPath\0`
 * （实测顺序是「新路径在前、旧路径在后」，见 tests/unit/git-adapter.test.ts 的真实仓库夹具）。
 */
export function parsePorcelainZ(stdout: Buffer): GitStatusEntry[] {
  const raw = stdout.toString('utf8')
  const tokens = raw.split('\0')
  const entries: GitStatusEntry[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token.length === 0) continue
    const x = token[0] ?? ' '
    const y = token[1] ?? ' '
    // 第 3 个字符是分隔空格（`-z` 下仍保留在 XY 之后）
    const path = token.slice(3)
    if (path.length === 0) continue

    const renamed = x === 'R' || y === 'R' || x === 'C' || y === 'C'
    let oldPath: string | undefined
    if (renamed) {
      index += 1
      const other = tokens[index]
      if (other !== undefined && other.length > 0) oldPath = other
    }

    const untracked = x === '?' && y === '?'
    const change = toChange(x, y, untracked, renamed)
    entries.push({
      path: path.replace(/\\/g, '/'),
      change,
      ...(oldPath === undefined ? {} : { oldPath: oldPath.replace(/\\/g, '/') }),
      ...(untracked ? { untracked: true } : {})
    })
  }
  return entries
}

function toChange(x: string, y: string, untracked: boolean, renamed: boolean): ArtifactChange {
  if (untracked) return 'added'
  if (renamed) return 'renamed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

export interface GitListOptions {
  workspace: GitWorkspace
  run?: GitRunner
  timeoutMs?: number
  /** 大仓库保护：只取前 N 条（调用方负责标记 truncated） */
  maxEntries?: number
}

/** 列出工作区变更（只读 `git status --porcelain=v1 -z --untracked-files=all`） */
export async function gitListChanges(options: GitListOptions): Promise<{
  entries: ArtifactEntry[]
  totalCount: number
}> {
  const run = options.run ?? defaultGitRunner
  const timeoutMs = options.timeoutMs ?? 10_000
  const { workspace } = options

  const result = await run(
    [
      // 不加锁、不改索引：`--no-optional-locks` 保证只读执行不会与用户正在跑的 git 打架
      '--no-optional-locks',
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all'
    ],
    { cwd: workspace.workspaceRoot, timeoutMs }
  )
  if (result.code !== 0) {
    throw new Error(`git status 失败：${firstLine(result.stderr) || `exit ${result.code}`}`)
  }

  const parsed = parsePorcelainZ(result.stdout)
  const filtered = parsed
    .map((entry) => toWorkspaceRelative(workspace, entry))
    .filter((entry): entry is GitStatusEntry => entry !== undefined)

  const sorted = filtered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const maxEntries = options.maxEntries ?? 1000
  const sliced = sorted.slice(0, maxEntries)

  const entries: ArtifactEntry[] = []
  for (const entry of sliced) {
    const sizeBytes = entry.change === 'deleted' ? undefined : await sizeOf(workspace, entry.path)
    entries.push({
      path: entry.path,
      change: entry.change,
      ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(entry.untracked === true ? { untracked: true } : {})
    })
  }
  return { entries, totalCount: sorted.length }
}

/** 仓库根相对路径 → 工作区相对路径；不在工作区内的条目直接丢弃 */
function toWorkspaceRelative(
  workspace: GitWorkspace,
  entry: GitStatusEntry
): GitStatusEntry | undefined {
  const convert = (path: string): string | undefined => {
    if (workspace.prefix.length === 0) return path
    const prefix = `${workspace.prefix}/`
    if (path === workspace.prefix) return ''
    if (!path.startsWith(prefix)) return undefined
    return path.slice(prefix.length)
  }
  const path = convert(entry.path)
  if (path === undefined || path.length === 0) return undefined
  const oldPath = entry.oldPath === undefined ? undefined : convert(entry.oldPath)
  return {
    path,
    change: entry.change,
    ...(oldPath === undefined ? {} : { oldPath }),
    ...(entry.untracked === true ? { untracked: true } : {})
  }
}

async function sizeOf(workspace: GitWorkspace, relativePath: string): Promise<number | undefined> {
  const absolute = join(workspace.workspaceRoot, relativePath)
  if (!isInsideRoot(workspace.workspaceRoot, absolute)) return undefined
  try {
    // 用 `lstat` 而不是 `stat`：产物列表要的是「工作区里这个条目的体积」。
    // 跟随符号链接会把链接目标（可能在工作区外、可能是几条 GB 的数据文件）的尺寸
    // 报成这个条目的尺寸，语义错位；且 `stat` 对悬空链接直接失败 → 尺寸丢失。
    // `lstat` 只描述链接本身；非链接 / 目录（git 只报文件与链接）行为不变。
    const info = await lstat(absolute)
    return info.isFile() || info.isSymbolicLink() ? info.size : undefined
  } catch {
    return undefined
  }
}

export interface GitDiffOptions {
  workspace: GitWorkspace
  path: string
  oldPath?: string
  change?: ArtifactChange
  run?: GitRunner
  timeoutMs?: number
}

export interface GitDiffResult {
  patch: string
  binary: boolean
}

/**
 * 取单个文件的 diff（已暂存 + 未暂存）。
 *
 * - `--cached`：HEAD→index（已暂存）
 * - 无 `--cached`：index→worktree（未暂存）
 *
 * 顺序固定「先暂存后未暂存」，这样 patch 读起来就是「HEAD 一路演进到工作区」。
 * 重命名条目把新旧两条 pathspec 一起给出，`--find-renames` 才能认出 100% 相似度。
 */
export async function gitFileDiff(options: GitDiffOptions): Promise<GitDiffResult> {
  const run = options.run ?? defaultGitRunner
  const timeoutMs = options.timeoutMs ?? 10_000
  const { workspace } = options

  const pathspecs = buildPathspecs(workspace, options)
  const common = ['--no-color', '--no-ext-diff', '--find-renames']

  // 注意：pathspec 必须放在 `--` **之后**，否则 git 会把 `:(literal)xxx` 当成 revision
  // （实测 ``fatal: bad revision ':(literal)a.txt'``）。
  const staged = await run(['diff', '--cached', ...common, '--', ...pathspecs], {
    cwd: workspace.workspaceRoot,
    timeoutMs
  })
  const unstaged = await run(['diff', ...common, '--', ...pathspecs], {
    cwd: workspace.workspaceRoot,
    timeoutMs
  })

  const chunks: string[] = []
  if (staged.code === 0) chunks.push(staged.stdout.toString('utf8'))
  if (unstaged.code === 0) chunks.push(unstaged.stdout.toString('utf8'))
  const patch = chunks.filter((chunk) => chunk.trim().length > 0).join('')

  return {
    patch,
    binary: /^Binary files .* differ$/m.test(patch) || patch.includes('GIT binary patch')
  }
}

/** `:(literal)` 关掉通配展开；pathspec 由 execFile 直传（`shell:false`），不存在 shell 注入面 */
function buildPathspecs(workspace: GitWorkspace, options: GitDiffOptions): string[] {
  const toRepoRelative = (relativePath: string): string =>
    workspace.prefix.length === 0 ? relativePath : `${workspace.prefix}/${relativePath}`

  const specs = [`:(literal)${toRepoRelative(options.path)}`]
  if (options.change === 'renamed' && options.oldPath !== undefined) {
    specs.unshift(`:(literal)${toRepoRelative(options.oldPath)}`)
  }
  return specs
}

function firstLine(value: string): string {
  const line = value.split('\n').find((item) => item.trim().length > 0)
  return (line ?? '').trim().slice(0, 200)
}
