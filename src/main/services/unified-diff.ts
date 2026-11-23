/**
 * 统一 diff 生成器（M6，非 git 工作区走这里；git 工作区直接用 `git diff` 的输出）。
 *
 * 为什么自己写：非 git 回退链路只有「快照 onth 内容」，没有 git 可用。要求是产出的补丁
 * 与 `git diff` **同一形态**（`diff --git` / `---` / `+++` / `@@`），这样 renderer 只需要
 * 一套 `DiffView` 解析逻辑，两条链路的展示完全一致。
 *
 * 复杂度控制（工整比聪明重要）：
 * - 先裁掉公共前缀/后缀行，只在中间区域做 LCS；
 * - 中间区域过大（默认 > 400×400 行）时退化为「整段替换」单个 hunk——
 *   反正 UI 也只会显示「一大块全删全加」，而 O(n·m) 的内存会把主进程拖爆；
 * - 输出行数超过上限时按行边界截断并显式标记（调用方负责再叠加 2MB 字节上限）。
 */

export interface UnifiedDiffOptions {
  /** 旧路径（相对工作区）；`null` 表示新增文件 */
  oldPath: string | null
  /** 新路径（相对工作区）；`null` 表示删除文件 */
  newPath: string | null
  /** 旧内容；`null` = 文件不存在（新增） */
  before: string | null
  /** 新内容；`null` = 文件不存在（删除） */
  after: string | null
  /** hunk 上下文行数（与 git 默认一致：3） */
  contextLines?: number
  /** 内部 LCS 的规模上限（行数乘积），超过则退化为整段替换 */
  lcsBudget?: number
}

/** 生成 `git diff` 同形的统一 diff 文本（保证以换行结尾，除非为空） */
export function createUnifiedDiff(options: UnifiedDiffOptions): string {
  const contextLines = options.contextLines ?? 3
  const lcsBudget = options.lcsBudget ?? 160_000

  const beforeLines = splitLines(options.before)
  const afterLines = splitLines(options.after)

  const oldPath = options.oldPath ?? options.newPath ?? 'unknown'
  const newPath = options.newPath ?? options.oldPath ?? 'unknown'

  const header: string[] = [`diff --git a/${oldPath} b/${newPath}`]
  if (options.before === null) header.push('new file')
  if (options.after === null) header.push('deleted file')
  header.push(
    options.before === null ? '--- /dev/null' : `--- a/${oldPath}`,
    options.after === null ? '+++ /dev/null' : `+++ b/${newPath}`
  )

  const ops = diffLines(beforeLines, afterLines, lcsBudget)
  const hunks = buildHunks(ops, contextLines)
  if (hunks.length === 0) return ''

  const lines = [...header]
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.lines)
  }
  return `${lines.join('\n')}\n`
}

/** 按行切分：保证 `a\nb\n` 与 `a\nb` 得到同一组行（尾行缺失的换行不制造假差异） */
export function splitLines(text: string | null): string[] {
  if (text === null || text.length === 0) return []
  const lines = text.split('\n')
  // 文本以换行结尾时 split 会产生一个空尾元素，它不是「一行」
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export type DiffOpKind = 'ctx' | 'del' | 'add'

export interface DiffOp {
  kind: DiffOpKind
  text: string
  /** 旧/新行号（1 基），按 kind 取用 */
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  header: string
  lines: string[]
}

/**
 * 行级差异（LCS）。
 *
 * 先裁公共前后缀，再对中间区域做 DP；规模超预算时退化为「先全删再全加」。
 */
export function diffLines(before: string[], after: string[], lcsBudget = 160_000): DiffOp[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)

  const ops: DiffOp[] = []
  let oldLine = 1
  let newLine = 1

  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: 'ctx', text: before[index] ?? '', oldLine: oldLine++, newLine: newLine++ })
  }

  const middle = lcsDiff(oldMiddle, newMiddle, lcsBudget)
  for (const op of middle) {
    if (op.kind === 'del') ops.push({ kind: 'del', text: op.text, oldLine: oldLine++ })
    else if (op.kind === 'add') ops.push({ kind: 'add', text: op.text, newLine: newLine++ })
    else ops.push({ kind: 'ctx', text: op.text, oldLine: oldLine++, newLine: newLine++ })
  }

  for (let index = 0; index < suffix; index += 1) {
    const text = before[before.length - suffix + index] ?? ''
    ops.push({ kind: 'ctx', text, oldLine: oldLine++, newLine: newLine++ })
  }

  return ops
}

function lcsDiff(before: string[], after: string[], budget: number): DiffOp[] {
  if (before.length === 0) return after.map((text) => ({ kind: 'add' as const, text }))
  if (after.length === 0) return before.map((text) => ({ kind: 'del' as const, text }))
  if (before.length * after.length > budget) {
    return [
      ...before.map((text) => ({ kind: 'del' as const, text })),
      ...after.map((text) => ({ kind: 'add' as const, text }))
    ]
  }

  const rows = before.length + 1
  const cols = after.length + 1
  // lengths[i][j] = before[i..] 与 after[j..] 的 LCS 长度
  const lengths: Uint32Array[] = Array.from({ length: rows }, () => new Uint32Array(cols))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = lengths[i]
    const next = lengths[i + 1]
    if (row === undefined || next === undefined) continue
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'ctx', text: before[i] ?? '' })
      i += 1
      j += 1
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: before[i] ?? '' })
      i += 1
    } else {
      ops.push({ kind: 'add', text: after[j] ?? '' })
      j += 1
    }
  }
  while (i < before.length) {
    ops.push({ kind: 'del', text: before[i] ?? '' })
    i += 1
  }
  while (j < after.length) {
    ops.push({ kind: 'add', text: after[j] ?? '' })
    j += 1
  }
  return ops
}

/** 把行级差异切成 hunk（带 3 行上下文，纯 ctx 的尾部/头部剥掉） */
export function buildHunks(ops: readonly DiffOp[], contextLines = 3): DiffHunk[] {
  const changed = ops
    .map((op, index) => (op.kind === 'ctx' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) return []

  const hunks: DiffHunk[] = []
  let cursor = 0
  while (cursor < changed.length) {
    const startIndex = Math.max(0, (changed[cursor] ?? 0) - contextLines)
    let endIndex = Math.min(ops.length - 1, (changed[cursor] ?? 0) + contextLines)
    let next = cursor + 1
    while (next < changed.length && (changed[next] ?? 0) - contextLines <= endIndex + 1) {
      endIndex = Math.min(ops.length - 1, (changed[next] ?? 0) + contextLines)
      next += 1
    }
    const slice = ops.slice(startIndex, endIndex + 1)
    hunks.push(toHunk(slice))
    cursor = next
  }
  return hunks
}

function toHunk(slice: readonly DiffOp[]): DiffHunk {
  const oldLines = slice.filter((op) => op.kind !== 'add').length
  const newLines = slice.filter((op) => op.kind !== 'del').length
  const first = slice[0]
  const oldStart = first?.oldLine ?? 1
  const newStart = first?.newLine ?? 1
  const lines = slice.map((op) => {
    const prefix = op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '
    return `${prefix}${op.text}`
  })
  return {
    header: `@@ -${formatRange(oldStart, oldLines)} +${formatRange(newStart, newLines)} @@`,
    lines
  }
}

/** git 的 hunk 头规则：1 行时省略 `,1`，0 行时用 `,0` */
function formatRange(start: number, count: number): string {
  if (count === 1) return `${start}`
  if (count === 0) return `${start - 1},0`
  return `${start},${count}`
}

/**
 * 按字节上限截断补丁：只在行边界切，截断后补一行显式提示。
 *
 * 返回 `{ patch, truncated }`；调用方决定如何在 UI 上标注（§7 约束 14：不得静默截断）。
 */
export function truncatePatch(
  patch: string,
  maxBytes: number,
  note = '（补丁超过上限，已按行截断）'
): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return { patch, truncated: false }

  const lines = patch.split('\n')
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + lineBytes > maxBytes) break
    kept.push(line)
    bytes += lineBytes
  }
  const body = kept.join('\n')
  return { patch: `${body}${body.length > 0 ? '\n' : ''}${note}\n`, truncated: true }
}
