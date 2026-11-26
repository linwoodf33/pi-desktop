import { ZodError } from 'zod'

/**
 * 统一 IPC 结果形态（架构文档 §5.4）。
 *
 * `invoke(channel, payload) -> Promise<Result<T>>`：
 * 所有通道（包括未实现与校验失败）都解析为 Result，而不是 reject，
 * 这样 renderer 侧无需 try/catch 区分「传输层异常」与「业务错误」。
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }

/** 错误码枚举：M1 只需要骨架用到的几个，M2+ 按需扩充。 */
export const ERROR_CODES = [
  /** 入参未通过 zod 校验，未进入业务层 */
  'VALIDATION',
  /** 通道不在 §5.4 白名单内 / 未注册 */
  'UNKNOWN_CHANNEL',
  /** 通道在白名单内，但 M1 骨架尚未实现 */
  'NOT_IMPLEMENTED',
  /** 未捕获异常，统一兜底 */
  'INTERNAL',
  /** 超时（§7 约束 13 的超时预算） */
  'TIMEOUT',
  /** 路径逃逸 workspaceRoots（M6 FsBridge） */
  'PATH_DENIED',
  /** 目标不存在（M6：被删除的产物 / 已删除的预览目标）；与 PATH_DENIED 区分，便于给出可操作提示 */
  'NOT_FOUND',
  /** 用系统默认程序打开失败（M6 `artifact:open`；`shell.openPath` 返回的错误串） */
  'OPEN_FAILED',
  /**
   * 删除会话文件失败（A39：回收站不可用 / 文件被占用）。
   * 此时文件与列表都不变，**绝不**降级为永久删除。
   */
  'DELETE_FAILED',
  /** 找不到 / 无法执行 pi */
  'PI_NOT_FOUND',
  /** 协议污染或非法协议记录 */
  'PROTOCOL',
  /** pi 子进程已退出 / 从未就绪 */
  'PI_EXITED',
  /** pi 明确拒绝了该命令（response.success=false） */
  'PI_COMMAND_FAILED',
  /** sessionKey 未注册 / 已释放 */
  'SESSION_NOT_FOUND',
  /** 会话正在运行，prompt 必须带 streamingBehavior（§6.2、§7 约束 5） */
  'SESSION_BUSY',
  /** 活跃会话数达上限且无可回收的已 settled 会话（§8/§10 A8） */
  'LIMIT_EXCEEDED',
  /** 用户主动取消（目录选择等）；renderer 应静默忽略，不展示错误条 */
  'CANCELLED',
  /**
   * 审批请求不存在 / 已过期 / 不属于该会话或该通道（M5，§9.4 S9 同源）。
   * 伪造 requestId 或跳会话回包一律落到这里，并同时写入 `evt:diagnostic`。
   */
  'REQUEST_NOT_FOUND',
  /** 审批扩展不可用或协议不兼容（M5：不静默放行，显式报错） */
  'PERMISSION_UNAVAILABLE',
  /** 已有 pi 更新任务在跑（A34 单飞锁：不排队，直接拒绝） */
  'PI_UPDATE_BUSY',
  /** 该 pi 安装不支持自更新（A34：需用户手动执行返回的 manualCommand） */
  'PI_UPDATE_UNAVAILABLE',
  /** 已有插件安装任务在跑（A37 单飞锁：不排队，直接拒绝） */
  'PKG_INSTALL_BUSY'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface IpcError {
  code: ErrorCode
  message: string
  /** 便于诊断的附加信息（字段路径、stderr 尾部等），不含敏感数据 */
  detail?: string
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail(code: ErrorCode, message: string, detail?: string): Result<never> {
  const error: IpcError = detail === undefined ? { code, message } : { code, message, detail }
  return { ok: false, error }
}

/**
 * 业务代码抛出带错误码的异常，由 router 规范化为 Result。
 * 用法：`throw new IpcFailure('PI_NOT_FOUND', 'PATH 中找不到 pi')`
 */
export class IpcFailure extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'IpcFailure'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** zod 校验错误 → 可读字段路径，例如 `cwd: Expected string, received number` */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * 把任意异常规范化为 IpcError。
 *
 * 安全约束：不把 stack / 原始对象透给 renderer（§7 约束 9、§9.4 S5），
 * 只保留 message 与必要 detail。
 */
export function normalizeError(error: unknown): IpcError {
  if (error instanceof IpcFailure) {
    return error.detail === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, detail: error.detail }
  }

  if (error instanceof ZodError) {
    return { code: 'VALIDATION', message: '入参校验失败', detail: formatZodError(error) }
  }

  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.message || '未捕获的内部错误' }
  }

  if (typeof error === 'string' && error.length > 0) {
    return { code: 'INTERNAL', message: error }
  }

  return { code: 'INTERNAL', message: '未捕获的内部错误' }
}
