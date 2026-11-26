import { lstat as lstatDefault } from 'node:fs/promises'
import { resolve } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'
import type { SessionSummary } from '../../shared/contracts/types'

import type { AuditLog } from './audit-log'
import { realpathNative } from './realpath-native'

/**
 * SessionDelete（架构文档 §5.2、A39）：删除**本地会话 JSONL**（移到系统回收站）。
 *
 * 为什么单独成服务而不是塞进 `session:setName` 附近：
 * - 这是**破坏性且应用内不可撤销**的操作，判定顺序即错误码优先级，必须集中在一处且可测；
 * - 授权事实只有一个：`SessionIndex.find` 认同的会话文件（见 §10 防错清单——
 *   不复用 `path-guard.ts` 的 workspace 根语义，也不复用「先 list 再比对」的旧写法）；
 * - 与 pi 进程完全无关：不 dispose、不结束会话、不依赖 `ending` 事件链；
 * - pi 侧没有会话索引需要同步（官方删除方式就是删 `.jsonl`，`/resume` 实时扫目录），
 *   所以本服务**不**提供「同步删除」之类的第二语义。
 *
 * 安全边界（顺序固定，改动顺序等于改错误码语义）：
 * 1. `realpathNative` 归一（展开 Windows 8.3 短名 / 大小写 / junction）；
 * 2. 活跃会话持有同一文件 → `SESSION_BUSY`（pi 还在往这个文件追加，删掉会让它写盘失败）；
 * 3. `findSession` 布局闸（根内、深度恰好 2、`.jsonl`、可解析会话）；
 * 4. 可选 `sessionId` 一致性（同一路径可能已被换成另一个会话）；
 * 5. `lstat` 必须是**普通文件**（符号链接一律拒绝）；
 * 6. `trash`（`shell.trashItem`）；失败**绝不**降级为 unlink；
 * 7. 审计（只记会话 id，绝不记路径，§7 约束 9）。
 */
export interface SessionDeleteOptions {
  /**
   * 会话根（`SessionIndex.root()`；随 `sessionDir` / `PI_CODING_AGENT_SESSION_DIR` 变化）。
   *
   * 注意：删除的边界事实由 `findSession` 提供，本服务**不**自写第二套前缀判断
   * （§10：单独通道不得自写前缀判断）。这个钩子保留为装配锚点，让调用方显式表达
   * 「当前根」这件事，便于诊断与将来扩审计字段时取上下文。
   */
  sessionRoot: () => string
  /** 索引成员查询（见 `SessionIndex.find`）；不在布局内 / 不可解析 → undefined */
  findSession: (filePath: string) => Promise<SessionSummary | undefined>
  /** 活跃会话持有的会话文件（`sessionService.keys()` 映射 `sessionFileOf` 后过滤 undefined） */
  activeSessionFiles: () => readonly string[]
  /** 移到回收站（main 注入 `(p) => shell.trashItem(p)`；测试注入 spy） */
  trash: (absPath: string) => Promise<void>
  audit?: AuditLog
  /** 测试注入（默认 `realpathNative`） */
  realPath?: (value: string) => Promise<string>
  /** 测试注入（默认 `fs.promises.lstat`） */
  lstat?: (value: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean }>
}

export interface SessionDeleteInput {
  /** 绝对路径（`TaskItem.filePath`）；相对路径也接受，按 `resolve` 处理 */
  sessionFile: string
  /** 可选一致性校验：必须等于该文件当前解析出的会话 id（防「同路径被换成另一个会话」） */
  sessionId?: string
}

export interface SessionDeleteResult {
  id: string
  /** 真实路径（长名），供调用方 `invalidate` 与测试断言 */
  filePath: string
}

export interface SessionDelete {
  remove(input: SessionDeleteInput): Promise<SessionDeleteResult>
}

/** 审计里的占位目标：路径一律不写进审计（§7 约束 9），解析不出会话 id 时用这个 */
const UNKNOWN_TARGET = '(unknown)'

export function createSessionDelete(options: SessionDeleteOptions): SessionDelete {
  const realPath = options.realPath ?? realpathNative
  const lstat = options.lstat ?? lstatDefault

  /** 拒绝路径上的审计：只写会话 id（或占位）+ 错误码，绝不写路径 */
  function recordDenied(code: string, target: string): void {
    options.audit?.record({ action: 'session:delete', target, outcome: 'denied', code })
  }

  return {
    async remove(input) {
      // 1. 真实路径归一：renderer 给的可能是 8.3 短名 / 混用分隔符 / 相对路径
      const requested = resolve(input.sessionFile)
      let realFile: string
      try {
        realFile = await realPath(requested)
      } catch {
        // 文件不存在 / 不可访问：renderer 按「已删除」处理（幂等语义由上层决定）
        throw new IpcFailure('NOT_FOUND', '会话文件不存在', input.sessionFile)
      }

      // 2. 活跃会话持有该文件 → 拒绝。两边都 realpath 后再比，避免分隔符/大小写/短名误判。
      //    包括 LRU 挂起但未释放的会话：只要 pi 子进程还活着，它就可能继续 append。
      const wanted = normalizeForCompare(realFile)
      for (const activeFile of options.activeSessionFiles()) {
        const realActive = await realPath(activeFile).catch(() => activeFile)
        if (normalizeForCompare(realActive) === wanted) {
          recordDenied('SESSION_BUSY', UNKNOWN_TARGET)
          throw new IpcFailure('SESSION_BUSY', '会话仍在运行：请先「结束」再删除')
        }
      }

      // 3. 布局闸：只有索引认同的会话文件才可删（根内 + 深度恰好 2 + .jsonl + 可解析）
      const summary = await options.findSession(realFile)
      if (summary === undefined) {
        recordDenied('PATH_DENIED', UNKNOWN_TARGET)
        throw new IpcFailure('PATH_DENIED', '只能删除本地会话索引里的会话文件', input.sessionFile)
      }

      // 4. 一致性：同一路径可能已被外部替换成另一个会话（复用文件名 / 恢复旧文件）
      if (input.sessionId !== undefined && input.sessionId !== summary.id) {
        recordDenied('NOT_FOUND', summary.id)
        throw new IpcFailure('NOT_FOUND', '会话文件内容已变化，请刷新任务列表后重试')
      }

      // 5. 普通文件闸：符号链接可能指向会话根外（realpath 已归一，这里再堵一层）
      let info: { isFile: () => boolean; isSymbolicLink: () => boolean }
      try {
        info = await lstat(realFile)
      } catch {
        recordDenied('NOT_FOUND', summary.id)
        throw new IpcFailure('NOT_FOUND', '会话文件不存在', input.sessionFile)
      }
      if (info.isSymbolicLink()) {
        recordDenied('PATH_DENIED', summary.id)
        throw new IpcFailure('PATH_DENIED', '只允许删除普通 .jsonl 会话文件')
      }
      if (!info.isFile()) {
        recordDenied('NOT_FOUND', summary.id)
        throw new IpcFailure('NOT_FOUND', '会话文件不存在', input.sessionFile)
      }

      // 6. 只走系统回收站。失败**绝不**降级为 unlink：回收站是唯一的恢复渠道。
      try {
        await options.trash(realFile)
      } catch (error) {
        const code = errorCodeOf(error)
        options.audit?.record({
          action: 'session:delete',
          target: summary.id,
          outcome: 'failed',
          code
        })
        throw new IpcFailure(
          'DELETE_FAILED',
          '删除失败：文件可能被占用或系统回收站不可用，未删除任何内容',
          code
        )
      }

      // 7. 审计只记会话 id（不含绝对路径/文件名）；失败分支已在上一步记过
      options.audit?.record({ action: 'session:delete', target: summary.id, outcome: 'deleted' })
      return { id: summary.id, filePath: realFile }
    }
  }
}

/** 取系统错误码（EPERM / EBUSY / ENOENT …）作为审计与 detail 的唯一内容 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'UNKNOWN'
}

/** Windows 上 `\` 与 `/`、大小写都等价；比较前统一（与 session-index 的缓存键范式一致） */
function normalizeForCompare(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}
