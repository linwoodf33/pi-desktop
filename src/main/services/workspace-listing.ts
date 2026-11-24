import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A27：工作区目录列举（应用内「引用文件/文件夹」选择器用）。
 *
 * 为什么需要它：Windows 上原生对话框**不能**同时选文件与文件夹
 * （Electron 文档：`['openFile','openDirectory']` → 只弹目录选择器），
 * 所以「一个按钮、文件与文件夹都能选」只能自己画选择器。
 *
 * 安全：调用方必须先用 `resolveWorkspaceTarget` 把 `path` 收敛成工作区内的真实目录；
 * 这里只做 readdir，不做任何路径拼接判断（边界只有一处：path-guard）。
 */
export interface DirEntry {
  name: string
  kind: 'file' | 'directory'
}

export interface DirListing {
  /** 工作区相对路径（POSIX；根目录为 ''） */
  relative: string
  entries: DirEntry[]
  /** 条目被上限截断（大目录不静默截断） */
  truncated: boolean
  /** 父目录的工作区相对路径；已在根时为 undefined */
  parentRelative?: string
}

/** 单次列举上限：超过就显式 truncated，不静默截断 */
export const MAX_DIR_ENTRIES = 500

export function listDirectoryContent(input: {
  /** 已由 path-guard 校验过的真实目录路径 */
  absoluteDir: string
  /** 该目录的工作区相对路径（POSIX） */
  relative: string
}): DirListing {
  const raw = readdirSync(input.absoluteDir, { withFileTypes: true })
  const entries: DirEntry[] = []
  let truncated = false

  for (const entry of raw) {
    // 符号链接不跟随：既防逃逸也防环（与产物扫描同一口径）
    if (entry.isSymbolicLink()) continue
    const kind: DirEntry['kind'] | undefined = entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : undefined
    if (kind === undefined) continue
    if (entries.length >= MAX_DIR_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: entry.name, kind })
  }

  // 目录在前、同类按名称排序：选择器里「先进目录再看文件」更顺手
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const relative = input.relative
  const parentRelative =
    relative.length === 0
      ? undefined
      : relative.includes('/')
        ? relative.slice(0, relative.lastIndexOf('/'))
        : ''

  return {
    relative,
    entries,
    truncated,
    ...(parentRelative === undefined ? {} : { parentRelative })
  }
}

/** 便于 handler 侧拼路径时保持一致（不在这里做安全判断） */
export function childPath(absoluteDir: string, name: string): string {
  return join(absoluteDir, name)
}
