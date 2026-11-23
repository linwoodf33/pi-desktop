import { useEffect, useState } from 'react'

import type { ApprovalChoice } from '../../../shared/contracts/permission'
import { respondApproval } from '../../lib/approval'
import { getApi } from '../../lib/client'
import { selectPendingApproval, usePermissionStore } from '../../stores/permissionStore'
import { ApprovalDialog } from './ApprovalDialog'

/**
 * 审批宿主（M5）：把 `permissionStore` 里属于当前任务的未决审批渲染成弹窗。
 *
 * 为什么单独一层：倒计时需要 500ms 一次的 tick，放在 App 里会让整个外壳重渲染；
 * 这里只让弹窗自己重渲染，且未决审批为空时直接返回 null（零开销）。
 */
export interface ApprovalHostProps {
  /** 当前选中任务 id（多会话时只弹当前任务的审批） */
  taskId: string | undefined
  /** 便于单测注入（默认取 `window.pi`） */
  now?: () => number
}

export function ApprovalHost({ taskId, now }: ApprovalHostProps) {
  const sessions = usePermissionStore((state) => state.sessions)
  const pending = selectPendingApproval(sessions, taskId)
  const requestId = pending?.request.requestId
  const [tick, setTick] = useState(() => (now ?? Date.now)())

  // 只在 tick 回调里 setState（不在 effect 体内同步 setState，避免级联渲染）。
  // `tick` 初始为挂载时刻；新请求到达时 tick 可能反而更早，剩余时间按满额展示，
  // 首次 tick（≤500ms）后即正确——不需要为对齐额外触发一次渲染。
  useEffect(() => {
    if (requestId === undefined) return
    const timer = setInterval(() => setTick((now ?? Date.now)()), 500)
    return () => clearInterval(timer)
  }, [requestId, now])

  if (pending === undefined) return null

  const respond = (choice: ApprovalChoice): void => {
    const api = getApi()
    if (api === undefined) return
    void respondApproval(api, pending.request.requestId, choice)
  }

  return (
    <ApprovalDialog pending={pending} elapsedMs={tick - pending.receivedAt} onRespond={respond} />
  )
}
