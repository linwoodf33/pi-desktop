import type { IpcError } from '../../shared/contracts/result'
import { IpcFailure } from '../../shared/contracts/result'
import type { ExtUiResponseInput } from '../../shared/contracts/permission'

/**
 * 未决 `extension_ui_request` 登记表（M5，§9.4 S9/S10 同源防护）。
 *
 * 为什么必须在主进程登记：
 * - `extension_ui_response` 的 `id` 是 pi 侧的请求 id，**没有任何认证**；
 *   如果只按 renderer 传来的 requestId 盲转，被注入的 renderer 就能：
 *   ① 猜/构造一个不存在的 id（骗过 pi 的协议或制造无意义流量）；
 *   ② 用 A 会话的 requestId 去回答 B 会话（跨会话串线，§9.4 S9）；
 *   ③ 在通道已经换过（fork 后同一进程已被新 sessionKey 接管）后回答旧请求。
 * - 因此唯一可信来源是「主进程自己看到的、属于当前通道的、仍然未决的请求」。
 *
 * 语义：
 * - 登记发生在 `SessionService` 收到 `extension_ui_request` 时（此时通道 id 已知）；
 * - 消费（consume）是**一次性**的：同 requestId 只能回答一次；
 * - 会话销毁 / 进程退出时 `clearSession` 清空，并返回需要「回拒绝」的请求列表。
 */

export interface PendingExtUi {
  requestId: string
  sessionKey: string
  /** 产生该请求的通道 id（`PiTransport.channelId`）；请求与通道一一对应 */
  channelId: string
  method: string
  /** select 类请求的合法选项；非 select 为 undefined */
  options?: readonly string[]
}

export interface ExtUiRegistry {
  /** 登记一条未决请求（同一 requestId 重复登记视为覆盖，取最新通道） */
  register(entry: PendingExtUi): void
  /**
   * 取用并移除一条未决请求；校验 sessionKey + 通道 id。
   *
   * 失败时抛出 `IpcFailure`：
   * - `REQUEST_NOT_FOUND`：不存在 / 已过期 / 已回答 / 跨会话 / 通道不匹配。
   */
  consume(input: {
    sessionKey: string
    requestId: string
    currentChannelId: string | undefined
    response: ExtUiResponseInput
  }): PendingExtUi
  /** 某会话全部未决请求（不清空） */
  list(sessionKey: string): PendingExtUi[]
  /**
   * 丢弃一条未决请求（不校验通道、不抛错）。
   *
   * 用途：pi 发来 `extension_ui_cancel`（扩展自己撤销了请求）时清理登记表。
   * 不清理的话，这些条目会随着会话里反复出现的取消一直留在 Map 里直到会话释放
   * （长会话 + 高频拒绝/超时的场景下就是纯内存泄漏），且会让 `size()` 这类诊断数字失真。
   * 返回被丢掉的条目（不存在时 undefined）。
   */
  discard(sessionKey: string, requestId: string): PendingExtUi | undefined
  /** 清空某会话的全部未决请求，返回被清掉的条目（调用方负责回拒绝） */
  clearSession(sessionKey: string): PendingExtUi[]
  /** 当前全部未决请求数（诊断/测试） */
  size(): number
}

export interface ExtUiRegistryOptions {
  /** 记录被拒绝的伪造/过期请求（默认静默；main 侧注入 evt:diagnostic） */
  onReject?: (error: IpcError, context: { sessionKey: string; requestId: string }) => void
}

export function createExtUiRegistry(options: ExtUiRegistryOptions = {}): ExtUiRegistry {
  const bySession = new Map<string, Map<string, PendingExtUi>>()

  function reject(
    message: string,
    detail: string,
    context: { sessionKey: string; requestId: string }
  ): never {
    const error: IpcError = { code: 'REQUEST_NOT_FOUND', message, detail }
    options.onReject?.(error, context)
    throw new IpcFailure('REQUEST_NOT_FOUND', message, detail)
  }

  return {
    register(entry) {
      const existing = bySession.get(entry.sessionKey)
      if (existing === undefined) {
        bySession.set(entry.sessionKey, new Map([[entry.requestId, entry]]))
        return
      }
      existing.set(entry.requestId, entry)
    },

    consume({ sessionKey, requestId, currentChannelId, response }) {
      const context = { sessionKey, requestId }
      const pending = bySession.get(sessionKey)?.get(requestId)
      if (pending === undefined) {
        reject(
          '审批请求不存在、已过期或不属于该会话，已丢弃',
          `requestId=${requestId} sessionKey=${sessionKey}`,
          context
        )
      }
      // 通道一致性：请求必须来自该会话**当前**的通道（fork 后旧请求立即失效）
      if (currentChannelId === undefined || pending.channelId !== currentChannelId) {
        bySession.get(sessionKey)?.delete(requestId)
        reject(
          '审批请求不属于当前通道（可能来自已释放的会话或伪造），已丢弃',
          `requestId=${requestId} channel=${pending.channelId} current=${String(currentChannelId)}`,
          context
        )
      }
      // 选项必须在请求声明的清单里：防伪造非预期响应
      if (response.kind === 'select') {
        const options = pending.options
        if (options === undefined || !options.includes(response.value)) {
          bySession.get(sessionKey)?.delete(requestId)
          reject(
            '审批响应不在请求提供的选项内，已丢弃',
            `requestId=${requestId} value=${response.value.slice(0, 64)}`,
            context
          )
        }
      }
      bySession.get(sessionKey)?.delete(requestId)
      return pending
    },

    list(sessionKey) {
      return [...(bySession.get(sessionKey)?.values() ?? [])]
    },

    discard(sessionKey, requestId) {
      const bucket = bySession.get(sessionKey)
      const entry = bucket?.get(requestId)
      if (bucket === undefined || entry === undefined) return undefined
      bucket.delete(requestId)
      // 空桶直接回收，避免「会话释放后仍留着空 Map」
      if (bucket.size === 0) bySession.delete(sessionKey)
      return entry
    },

    clearSession(sessionKey) {
      const entries = [...(bySession.get(sessionKey)?.values() ?? [])]
      bySession.delete(sessionKey)
      return entries
    },

    size() {
      let total = 0
      for (const entries of bySession.values()) total += entries.size
      return total
    }
  }
}
