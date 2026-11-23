import type { ChatMessage } from './reducer'

/**
 * 时间线分组（§5.5 features/chat/Timeline）：按 **assistant turn** 把消息分组。
 *
 * 一轮（turn）= 一条用户消息 + 之后所有 assistant 消息（含各自的工具卡片）。
 * 分组的输入是 reducer 产出的纯数据，因此是纯函数、可单测（U-Timeline）。
 */
export interface TimelineTurn {
  /** 该轮的首条消息 key（用作 React key） */
  id: string
  /** 从 1 开始的轮次序号 */
  index: number
  /** 触发本轮的用户消息（首轮可能没有） */
  user?: ChatMessage
  /** 本轮内的 assistant 消息（按到达顺序） */
  items: ChatMessage[]
}

export function groupTimeline(messages: ChatMessage[]): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  let current: TimelineTurn | undefined

  const flush = (): void => {
    if (current !== undefined) turns.push(current)
    current = undefined
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush()
      current = { id: message.key, index: turns.length + 1, user: message, items: [] }
      continue
    }

    if (current === undefined) {
      current = { id: message.key, index: turns.length + 1, items: [] }
    }
    current.items.push(message)
  }

  flush()
  return turns
}

/** 该轮里是否有工具卡片（用于时间线的步骤徽标） */
export function turnToolCount(turn: TimelineTurn): number {
  return turn.items.reduce((total, item) => total + (item.tools?.length ?? 0), 0)
}
