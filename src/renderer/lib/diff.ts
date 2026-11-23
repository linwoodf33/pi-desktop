/**
 * unified diff 解析（M6 产物面板，§5.5 features/artifacts/DiffView）。
 *
 * 只解析**形态**，不做任何求值：输入是主进程给的补丁字符串（git 输出或快照比对合成），
 * 输出是「文件 → hunk → 行」的结构，交给 DiffView 渲染。
 *
 * 安全：这里的产物只进入 React 文本节点（`{line.text}`），没有 HTML sink；
 * 不解析、也不渲染补丁里的任何标记为 HTML（§9.4 S3 同源约束）。
 */

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  /** `--- a/<old>` 里的旧路径（`/dev/null` 时不存在） */
  oldPath?: string
  /** `+++ b/<new>` 里的新路径（`/dev/null` 时不存在） */
  newPath?: string
  /** 首行 `diff --git a/x b/y` 与 hunk 之前的元信息（index / similarity / rename / new file…） */
  meta: string[]
  hunks: DiffHunk[]
}

export interface DiffFileStats {
  additions: number
  deletions: number
}

/** 解析补丁文本；没有 hunk 的块（纯元信息）也算一个文件条目（rename 100% 时就是这种形态） */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  if (patch.length === 0) return files

  let current: DiffFile | undefined
  let hunk: DiffHunk | undefined
  /** 当前文件是否已消化过 `---` / `+++` 这对头（避免把同一文件拆成两条） */
  let sawMoneyHeader = false

  const startFile = (): DiffFile => {
    const file: DiffFile = { meta: [], hunks: [] }
    files.push(file)
    hunk = undefined
    sawMoneyHeader = false
    return file
  }

  for (const rawLine of patch.split('\n')) {
    if (rawLine.endsWith('\r')) continue
    if (rawLine.length === 0) continue

    if (rawLine.startsWith('diff --git ')) {
      current = startFile()
      const paths = parseGitHeaderPaths(rawLine)
      if (paths !== undefined) {
        current.oldPath = paths.oldPath
        current.newPath = paths.newPath
      }
      continue
    }

    if (rawLine.startsWith('--- ')) {
      // 没有 `diff --git` 头的补丁（合成补丁的极简形态）也要能开新文件
      if (current === undefined || sawMoneyHeader) current = startFile()
      sawMoneyHeader = true
      const path = stripPrefix(rawLine.slice(4).trim(), 'a/')
      if (path === '/dev/null') delete current.oldPath
      else current.oldPath = path
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      if (current === undefined) current = startFile()
      const path = stripPrefix(rawLine.slice(4).trim(), 'b/')
      if (path === '/dev/null') delete current.newPath
      else current.newPath = path
      continue
    }

    if (rawLine.startsWith('@@')) {
      if (current === undefined) current = startFile()
      hunk = { header: rawLine, lines: [] }
      current.hunks.push(hunk)
      continue
    }

    const kind = lineKind(rawLine)
    if (hunk === undefined) {
      // hunk 之前的元信息（index / mode / similarity / rename from/to）
      current?.meta.push(rawLine)
      continue
    }
    hunk.lines.push({ kind, text: kind === 'meta' ? rawLine : rawLine.slice(1) })
  }

  return files
}

function lineKind(line: string): DiffLineKind {
  const marker = line[0]
  if (marker === '+') return 'add'
  if (marker === '-') return 'del'
  if (marker === ' ') return 'ctx'
  return 'meta'
}

/** `diff --git a/<old> b/<new>`：路径可能含空格，按 ` b/` 从右侧切 */
function parseGitHeaderPaths(line: string): { oldPath: string; newPath: string } | undefined {
  const body = line.slice('diff --git '.length)
  const separator = body.lastIndexOf(' b/')
  if (separator <= 0) return undefined
  const oldPath = stripPrefix(body.slice(0, separator), 'a/')
  const newPath = stripPrefix(body.slice(separator + 1), 'b/')
  if (oldPath.length === 0 || newPath.length === 0) return undefined
  return { oldPath, newPath }
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** 单个文件的增删行数（UI 徽标用） */
export function diffFileStats(file: DiffFile): DiffFileStats {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1
      else if (line.kind === 'del') deletions += 1
    }
  }
  return { additions, deletions }
}

/** 整个补丁的增删行数 */
export function diffTotals(files: readonly DiffFile[]): DiffFileStats {
  return files.reduce<DiffFileStats>(
    (acc, file) => {
      const stats = diffFileStats(file)
      return {
        additions: acc.additions + stats.additions,
        deletions: acc.deletions + stats.deletions
      }
    },
    { additions: 0, deletions: 0 }
  )
}

/** 文件条目的展示名：优先新路径，删除时用旧路径 */
export function diffFileLabel(file: DiffFile): string {
  if (file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath) {
    return `${file.oldPath} → ${file.newPath}`
  }
  return file.newPath ?? file.oldPath ?? '(unknown)'
}
