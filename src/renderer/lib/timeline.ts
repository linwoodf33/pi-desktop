import type { ChatMessage } from './reducer'

/**
 * 时间线分组（§5.5 features/chat/Timeline）：按 **assistant turn** 把消息分组。
 *
 * 一轮（turn）= 一条用户消息 + 之后所有 assistant 消息（含各自的工具卡片）。
 * 分组的输入是 reducer 产出的纯数据，因此是纯函数、可单测（U-Timeline）。
 */
/**
 * 展示层的「连续失败」合并项。**不属于 ChatMessage**：它聚合了多条真实消息，
 * 数据本身仍逐条留在 `ChatState.messages` 里（保真），这里只是展示折叠。
 */
export interface TimelineErrorGroup {
  kind: 'error-group'
  /** React key：`errgroup:<组内首条消息 key>` —— 新重试到达时不变（不重挂 DOM、不丢展开状态） */
  key: string
  /** 组内**最后一条**失败消息的 errorMessage（最新诊断最有价值） */
  error: string
  /** 组内连续失败次数（>=1） */
  count: number
  /** 组内每条消息的 key（保真证据：一条都没丢，只是展示合并） */
  keys: string[]
}

export type TimelineItem = ChatMessage | TimelineErrorGroup

/** 收窄联合类型（`ChatMessage` 没有 `kind` 字段，判断安全，无需 `as` 断言） */
export function isErrorGroup(item: TimelineItem): item is TimelineErrorGroup {
  return 'kind' in item && item.kind === 'error-group'
}

export interface TimelineTurn {
  /** 该轮的首条消息 key（用作 React key） */
  id: string
  /** 从 1 开始的轮次序号 */
  index: number
  /** 触发本轮的用户消息（首轮可能没有） */
  user?: ChatMessage
  /**
   * 本轮内的展示项（按到达顺序）：普通项是 `ChatMessage`，
   * 连续的**纯失败**消息折叠成一个 `TimelineErrorGroup`。
   */
  items: TimelineItem[]
}

/**
 * 不可见的非用户消息：无文本、无工具；`aborted` 的空收尾即使带 errorMessage 也算空。
 * 典型来源：中止瞬间 pi 收尾的 `content: []` + `stopReason:'aborted'`。
 * 真实 JSONL 里这条消息**带** `errorMessage: 'This operation was aborted'`
 * （空 content 且带 errorMessage），所以 aborted 判断必须在 `error` 之前，
 * 否则它既躲过丢弃、又会被折进红色错误组 —— 而中止是用户主动行为，不是模型失败。
 * 这类消息旧版会渲染成只有角标的「空气泡」，展示层直接丢弃。
 */
export function isEmptyMessage(message: ChatMessage): boolean {
  if (message.role === 'user') return false
  // 有文本 / 有工具的 aborted 消息不算空（正常展示 +「已中止」注脚）
  if (
    message.stopReason === 'aborted' &&
    message.text.length === 0 &&
    (message.tools?.length ?? 0) === 0
  ) {
    return true
  }
  if (message.error !== undefined) return false
  if (message.text.length > 0) return false
  return (message.tools?.length ?? 0) === 0
}

/**
 * 纯失败消息：assistant + error + 无文本 + 无工具。
 * 只有这种消息会被折叠成「连续失败」；带部分文本 / 工具卡片的失败消息保留为普通气泡
 * （气泡内仍会渲染错误块，信息不丢）。
 */
export function isPureError(message: ChatMessage): message is ChatMessage & { error: string } {
  if (message.role !== 'assistant') return false
  // 双保险：中止不是失败，即便 pi 给 aborted 消息带了 errorMessage 也不能折进错误组
  if (message.stopReason === 'aborted') return false
  if (message.error === undefined || message.error.length === 0) return false
  if (message.text.length > 0) return false
  return (message.tools?.length ?? 0) === 0
}

export function groupTimeline(messages: ChatMessage[]): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  let current: TimelineTurn | undefined

  const flush = (): void => {
    if (current !== undefined) turns.push(current)
    current = undefined
  }

  for (const message of messages) {
    // 空消息（含 aborted 的空收尾，即使带 errorMessage）不进时间线：否则就是一个「空气泡」。
    // 必须在 user 判断之前，且 `isEmptyMessage` 对 user 恒为 false（用户消息永不被丢弃）。
    if (isEmptyMessage(message)) continue

    if (message.role === 'user') {
      flush()
      current = { id: message.key, index: turns.length + 1, user: message, items: [] }
      continue
    }

    if (current === undefined) {
      current = { id: message.key, index: turns.length + 1, items: [] }
    }
    appendItem(current.items, message)
  }

  flush()
  return turns
}

/**
 * 把一条 assistant 消息放进展示项列表：连续的纯失败消息折叠成一组。
 *
 * 累加是**原地修改**（组对象由本函数创建、独占所有权），避免每次重试都复制 keys 数组；
 * 整体仍是一次线性扫描。
 */
function appendItem(items: TimelineItem[], message: ChatMessage): void {
  if (!isPureError(message)) {
    items.push(message)
    return
  }
  const last = items[items.length - 1]
  if (last !== undefined && isErrorGroup(last)) {
    last.count += 1
    last.error = message.error
    last.keys.push(message.key)
    return
  }
  items.push({
    kind: 'error-group',
    key: `errgroup:${message.key}`,
    error: message.error,
    count: 1,
    keys: [message.key]
  })
}

/** 该轮里是否有工具卡片（用于时间线的步骤徽标）；合并项不含工具，计 0 */
export function turnToolCount(turn: TimelineTurn): number {
  return turn.items.reduce(
    (total, item) => total + (isErrorGroup(item) ? 0 : (item.tools?.length ?? 0)),
    0
  )
}
