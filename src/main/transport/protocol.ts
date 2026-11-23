/**
 * pi RPC 协议的**最小**读取侧辅助（字段以 pi 官方文档为准）：
 * - docs/rpc.md：四类记录（command / response / session event / extension UI）
 * - docs/json.md：会话事件与 `message_update.assistantMessageEvent`
 * - docs/rpc-commands.md：命令响应 data 形状（如 prompt 的 disposition）
 *
 * 这里只做类型守卫与取值，不做业务状态机；业务归约在 SessionService。
 */

/** `response` 记录（唯一带 id 关联语义的记录族） */
export interface RpcResponseRecord {
  type: 'response'
  /** 命令带 id 时原样回显；parse 失败产生的 response 没有 id */
  id?: string
  command?: string
  success?: boolean
  data?: unknown
  error?: string
}

export type RpcRecordLike = { type: string; [key: string]: unknown }

export function isRpcRecord(value: unknown): value is RpcRecordLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

export function isRpcResponse(value: unknown): value is RpcResponseRecord {
  return isRpcRecord(value) && value.type === 'response'
}

/** `message_update` 的 `assistantMessageEvent` 中我们关心的一种增量 */
export function readTextDelta(
  record: RpcRecordLike
): { contentIndex: number; delta: string } | undefined {
  if (record.type !== 'message_update') return undefined
  const inner = record['assistantMessageEvent']
  if (typeof inner !== 'object' || inner === null) return undefined
  const event = inner as { type?: unknown; contentIndex?: unknown; delta?: unknown }
  if (event.type !== 'text_delta') return undefined
  if (typeof event.delta !== 'string') return undefined
  return {
    contentIndex: typeof event.contentIndex === 'number' ? event.contentIndex : 0,
    delta: event.delta
  }
}

/** 把合并后的 text_delta 重新包装成一条 `message_update` 记录（渲染侧形状不变） */
export function buildMergedTextDelta(
  contentIndex: number,
  delta: string,
  mergedCount: number
): RpcRecordLike {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex, delta },
    mergedCount
  }
}

const DISPOSITIONS = ['started', 'queued', 'handled'] as const

/** 读取 `prompt` / `steer` / `follow_up` 响应里的 `data.disposition` */
export function readDisposition(data: unknown): 'started' | 'queued' | 'handled' | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as { disposition?: unknown }).disposition
  if (typeof value !== 'string') return undefined
  return (DISPOSITIONS as readonly string[]).includes(value)
    ? (value as 'started' | 'queued' | 'handled')
    : undefined
}

/** 读取 `data.models` / `data.messages` 这类数组字段 */
export function readArrayField(data: unknown, field: string): unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>)[field]
  return Array.isArray(value) ? value : undefined
}

export function readObjectField(data: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>)[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
