import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { INVOKE_CHANNELS, isInvokeChannel, type InvokeChannel } from '../../shared/ipc-channels'
import { getInputSchema } from '../../shared/contracts/schemas'
import { fail, IpcFailure, normalizeError, ok, type Result } from '../../shared/contracts/result'

/**
 * 通道处理器：只接收已通过 zod 校验的数据（架构文档 §5.2 IpcRouter）。
 * 返回值会被包成 ok(data)；抛异常由 router 规范化为 Result。
 */
export type InvokeHandler = (input: unknown) => Promise<unknown>

export type HandlerMap = Partial<Record<InvokeChannel, InvokeHandler>>

export interface IpcRouterOptions {
  handlers: HandlerMap
  /** 记录错误码映射等诊断信息，默认静默；main 侧注入 logger */
  onError?: (channel: string, error: unknown) => void
  /**
   * 按通道的超时预算（§7 约束 13）。超时后返回 TIMEOUT，不再等待处理器。
   * 未列出的通道不设 router 级超时（例如 session:prompt 走事件流，不设总超时）。
   */
  timeouts?: Partial<Record<InvokeChannel, number>>
}

/**
 * IPC 路由：集中注册 + zod 校验 + 错误规范化。
 *
 * 本类不 import electron 的值（只用类型），因此可在 vitest 中直接构造测试。
 */
export class IpcRouter {
  private readonly handlers: HandlerMap
  private readonly onError: (channel: string, error: unknown) => void
  private readonly timeouts: Partial<Record<InvokeChannel, number>>

  constructor(options: IpcRouterOptions) {
    this.handlers = options.handlers
    this.onError = options.onError ?? (() => {})
    this.timeouts = options.timeouts ?? {}
  }

  /**
   * 单次调度的完整管线：
   * 白名单 → zod → 处理器存在性 → 执行 → Result。
   *
   * 所有分支都返回 Result，永不 reject（renderer 侧无需 try/catch）。
   */
  async dispatch(channel: string, payload: unknown): Promise<Result<unknown>> {
    if (!isInvokeChannel(channel)) {
      // 未注册通道一律拒绝（§9.4 S2）
      return fail('UNKNOWN_CHANNEL', `未注册的 IPC 通道: ${channel}`)
    }

    const parsed = getInputSchema(channel).safeParse(payload ?? {})
    if (!parsed.success) {
      // 校验失败不进入业务层（§9.1 U8）
      return fail('VALIDATION', `通道 ${channel} 入参校验失败`, formatIssues(parsed.error))
    }

    const handler = this.handlers[channel]
    if (!handler) {
      return fail('NOT_IMPLEMENTED', `通道 ${channel} 的处理器尚未实现（按里程碑排在后续版本）`)
    }

    try {
      const pending = handler(parsed.data)
      const timeoutMs = this.timeouts[channel]
      const data =
        timeoutMs === undefined ? await pending : await withTimeout(pending, timeoutMs, channel)
      return ok(data)
    } catch (error) {
      this.onError(channel, error)
      return { ok: false, error: normalizeError(error) }
    }
  }

  /** 在给定 IpcMain 上注册全部白名单通道（main/index.ts 传入 ipcMain） */
  registerAll(ipcMain: Pick<IpcMain, 'handle'>): void {
    for (const channel of INVOKE_CHANNELS) {
      ipcMain.handle(channel, (_event: IpcMainInvokeEvent, payload: unknown) =>
        this.dispatch(channel, payload)
      )
    }
  }
}

function formatIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * 通道级超时（§7 约束 13）：超时后返回 `TIMEOUT`。
 * 处理器本身无法取消，但它的迟到结果会被丢弃，renderer 不会永久挂起。
 */
async function withTimeout<T>(pending: Promise<T>, timeoutMs: number, channel: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new IpcFailure(
          'TIMEOUT',
          `通道 ${channel} 超过 ${timeoutMs}ms 未返回`,
          `timeoutMs=${timeoutMs}`
        )
      )
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
