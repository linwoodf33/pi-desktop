import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { IpcFailure } from '../../shared/contracts/result'

/**
 * 修改会话显示名（A23）。
 *
 * pi 的会话名**不是文件头字段**，而是会话 JSONL 里的 `session_info` 记录
 * （`docs/session-format.md`：`{"type":"session_info","name":"..."}`，由 `/name`、
 * `--name` 或扩展 `setSessionName()` 写入）。因此两条路径：
 *
 * 1. **活跃会话**：走 RPC `set_session_name`（SessionService 发命令），pi 自己落盘；
 * 2. **历史（回放）任务**：进程已不在，这里**追加**一条 `session_info` ——
 *    与 pi 的写法同形，且**只 append、不改旧行**（不重写用户数据）。
 *
 * 校验：只允许改 `.jsonl` 且必须存在；会话根校验由调用方完成。
 */
export interface AppendSessionNameOptions {
  /** 会话文件真实路径（调用方已 realpath + 根校验） */
  sessionFile: string
  /** 新名字（调用方已 trim/限长） */
  name: string
  /** 注入：测试用 */
  now?: () => Date
}

export interface AppendSessionNameResult {
  /** 追加的记录（便于调用方/测试断言） */
  record: Record<string, unknown>
}

/**
 * `session_info` 的 id：pi 用 **8 位十六进制**（实测 `{"id":"acd34421"}`），这里对齐。
 */
function newEntryId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * 读取文件最后一条记录的 `id`，作为 `session_info.parentId`。
 *
 * 为什么不能写 `null`：实测 pi 的 RPC `set_session_name` 写出来的是
 * `parentId = <最后一条记录的 id>`。想做到「与 /name 完全一致」，就必须接上这条链。
 * 只读尾部 8KB，避免为大文件整读。
 */
function lastEntryId(sessionFile: string): string | null {
  const TAIL_BYTES = 8 * 1024
  const size = statSync(sessionFile).size
  const start = Math.max(0, size - TAIL_BYTES)
  const fd = openSync(sessionFile, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer
      .toString('utf8')
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    // 从后往前找第一条能解析且带 id 的记录（尾部可能正好切在半个 JSON 上）
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const raw = lines[index]
      if (raw === undefined) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const id = (parsed as Record<string, unknown>)['id']
          if (typeof id === 'string' && id.length > 0) return id
        }
      } catch {
        continue
      }
    }
    return null
  } finally {
    closeSync(fd)
  }
}

export function appendSessionName(options: AppendSessionNameOptions): AppendSessionNameResult {
  const { sessionFile } = options
  const name = options.name.trim()
  if (name.length === 0) throw new IpcFailure('VALIDATION', '会话名不能为空')
  if (!sessionFile.toLowerCase().endsWith('.jsonl')) {
    throw new IpcFailure('VALIDATION', '只能修改 .jsonl 会话文件', sessionFile)
  }
  if (!existsSync(sessionFile)) {
    throw new IpcFailure('NOT_FOUND', '会话文件不存在（可能已被删除）', sessionFile)
  }
  if (!statSync(sessionFile).isFile()) {
    throw new IpcFailure('VALIDATION', '会话路径不是文件', sessionFile)
  }

  const now = (options.now ?? (() => new Date()))()
  const record: Record<string, unknown> = {
    type: 'session_info',
    id: newEntryId(),
    parentId: lastEntryId(sessionFile),
    timestamp: now.toISOString(),
    name
  }
  // 只追加一行；不改写任何既有内容
  appendFileSync(sessionFile, `${JSON.stringify(record)}\n`, 'utf8')
  return { record }
}
