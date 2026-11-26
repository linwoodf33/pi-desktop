/**
 * 审计日志（M6）：只记录「谁在什么时候对哪个工作区相对路径做了什么」，**不记录文件内容**。
 *
 * 为什么需要一个独立字段约定：`artifact:open` 会调起外部程序（真实现副作用），
 * 出问题时必须能回答「打开过哪些文件、是哪次校验放行的、结果如何」，
 * 同时又不能把内容或敏感路径写进日志（§7 约束 9、§9.4 S5）。
 */
export interface AuditEntry {
  /** ISO 8601 时间戳 */
  at: string
  /** 动作：artifact:open（打开产物）/ session:delete（删除会话文件，A39） */
  action: 'artifact:open' | 'session:delete'
  /**
   * - `artifact:open`：工作区相对路径（POSIX）；
   * - `session:delete`：**会话 id**（不写绝对路径/文件名，§7 约束 9）。
   */
  target: string
  /**
   * 结果：
   * - opened 成功打开 / denied 校验拒绝 / failed 打开失败（artifact:open）；
   * - deleted 已移到回收站 / denied 校验拒绝 / failed 回收站失败（session:delete）。
   */
  outcome: 'opened' | 'deleted' | 'denied' | 'failed'
  /** 失败时的错误码（不含路径与内容） */
  code?: string
}

export type AuditSink = (entry: AuditEntry) => void

export interface AuditLogOptions {
  sink?: AuditSink
  now?: () => Date
}

export interface AuditLog {
  record(input: Omit<AuditEntry, 'at'>): void
  /** 最近的若干条（测试与诊断用；不暴露给 renderer） */
  recent(): readonly AuditEntry[]
}

const MAX_RETAINED = 200

export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? (() => new Date())
  const sink =
    options.sink ??
    ((entry: AuditEntry) => {
      // 固定字段顺序，便于 grep；不含绝对路径与内容
      console.info(
        `[audit] ${entry.at} ${entry.action} ${entry.outcome} ${entry.target}${entry.code === undefined ? '' : ` code=${entry.code}`}`
      )
    })
  const retained: AuditEntry[] = []

  return {
    record(input) {
      const entry: AuditEntry = { at: now().toISOString(), ...input }
      retained.push(entry)
      if (retained.length > MAX_RETAINED) retained.shift()
      sink(entry)
    },
    recent() {
      return [...retained]
    }
  }
}
