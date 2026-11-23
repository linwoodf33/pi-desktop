import type { PiApi } from '../../shared/contracts/api'
import {
  PERMISSION_PROTOCOL_VERSION,
  classifyExtUi,
  clientApprovalTimeoutMs,
  optionForChoice,
  type ApprovalChoice,
  type ApprovalRequest
} from '../../shared/contracts/permission'
import type { ExtUiEvent } from '../../shared/contracts/types'

import { usePermissionStore } from '../stores/permissionStore'
import { useRunStore } from '../stores/runStore'
import { useSessionStore } from '../stores/sessionStore'

/**
 * 审批编排（M5，§6.3）：`evt:extui` → 弹窗状态机，用户选择 → `extui:respond`。
 *
 * 全部规则集中在这里，组件只负责渲染与回调：
 *
 * 1. **版本握手**（`setStatus`）：协议不兼容时显式告警，并把该会话标记为不可审批；
 * 2. **不兼容 = 自动拒绝**：不弹窗、不静默放行——直接回 `cancelled`（扩展侧得到 undefined → 拒绝），
 *    同时累计 `autoDenied` 供 UI 展示；
 * 3. **超时先手拒绝**：等待 `request.timeoutMs - LEAD`（同一个时钟，见 contracts/permission.ts），
 *    到点自动回拒绝并提示，不留一个永远挂着的弹窗；
 * 4. **回答一次性**：回答后立刻从 pending 移除并清定时器，重复回答不会二次发送；
 * 5. **本会话允许**：只在内存里按 `sessionKey + 工具名` 记住，会话销毁即清空（不跨会话/进程）。
 */

/** 可勾选的审批工具（与 pi 内置工具名一致；删除类命令由 bash/powershell 覆盖） */
export const APPROVAL_TOOL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'bash', label: 'bash（含删除类命令）' },
  { value: 'powershell', label: 'powershell（含删除类命令）' },
  { value: 'write', label: 'write（写文件）' },
  { value: 'edit', label: 'edit（改文件）' }
]

/**
 * 审批弹窗的剩余秒数（向上取整，最小 0）。
 *
 * 只用于展示：真正的超时判定在主进程/扩展侧（同一个 timeout），这里算错也不会放宽安全语义。
 */
export function remainingSeconds(
  request: { timeoutMs: number },
  receivedAt: number,
  now: number
): number {
  const elapsed = Math.max(0, now - receivedAt)
  return Math.ceil(Math.max(0, request.timeoutMs - elapsed) / 1000)
}

/** requestId → 客户端超时定时器 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(requestId: string): void {
  const timer = timers.get(requestId)
  if (timer === undefined) return
  clearTimeout(timer)
  timers.delete(requestId)
}

/** 清理全部定时器（测试 / 退出时用） */
export function clearApprovalTimers(sessionKey?: string): void {
  if (sessionKey === undefined) {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    return
  }
  for (const [requestId, timer] of timers) {
    const pending = findPending(requestId)
    if (pending !== undefined && pending.sessionKey !== sessionKey) continue
    clearTimeout(timer)
    timers.delete(requestId)
  }
}

function findPending(
  requestId: string
): { sessionKey: string; request: ApprovalRequest } | undefined {
  const sessions = usePermissionStore.getState().sessions
  for (const [sessionKey, session] of Object.entries(sessions)) {
    const hit = session.pending.find((item) => item.requestId === requestId)
    if (hit !== undefined) return { sessionKey, request: hit.request }
  }
  return undefined
}

function banner(input: {
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string
}): void {
  useRunStore.getState().pushBanner(input)
}

/**
 * 发送响应（唯一出口）。
 *
 * - `choice === 'deny'` 或没有对应选项 → 发 `{kind:'cancel'}`（pi 把 select 的取消当 `undefined`，
 *   扩展侧按拒绝处理，fail-closed）；
 * - 成功后移除 pending 并清定时器；`allow_session` 额外记入「本会话允许」。
 */
async function sendResponse(
  api: PiApi,
  sessionKey: string,
  request: ApprovalRequest,
  choice: ApprovalChoice
): Promise<boolean> {
  const value = choice === 'deny' ? undefined : optionForChoice(request, choice)
  const response =
    value === undefined ? ({ kind: 'cancel' } as const) : ({ kind: 'select', value } as const)

  clearTimer(request.requestId)
  usePermissionStore.getState().removeApproval(sessionKey, request.requestId)

  const result = await api.extui.respond({
    sessionKey,
    requestId: request.requestId,
    response
  })
  if (!result.ok) {
    // 主进程拒绝（伪造/过期/跨会话）也要让用户知道：这不是“点了没反应”
    banner({
      level: 'warn',
      message: `审批响应未被接受 [${result.error.code}] ${result.error.message}`,
      ...(result.error.detail === undefined ? {} : { detail: result.error.detail })
    })
    return false
  }
  if (choice === 'allow_session') {
    usePermissionStore.getState().rememberAllowSession(sessionKey, request.meta.tool)
  }
  return true
}

/**
 * 处理一条 `evt:extui`（`client.ts` 订阅后转发到这里）。
 *
 * 返回分类结果，便于单测断言与调用方决定是否记录日志。
 */
export function handleExtUiEvent(
  api: PiApi,
  event: ExtUiEvent,
  now: () => number = () => Date.now()
): 'handshake' | 'approval' | 'auto-denied' | 'ignored' {
  const classified = classifyExtUi(event)

  if (classified.kind === 'handshake') {
    usePermissionStore
      .getState()
      .applyHandshake(event.sessionKey, classified.handshake, classified.compatible)
    if (!classified.compatible) {
      banner({
        level: 'error',
        message: `审批扩展与客户端协议不兼容（扩展 v${classified.handshake.version} · 协议 ${classified.handshake.protocol}，客户端协议 ${PERMISSION_PROTOCOL_VERSION}）：高风险工具请求将被自动拒绝`,
        detail: '请重新安装审批扩展：npm run install:permission（已装版本可能较旧）'
      })
    }
    return 'handshake'
  }

  if (classified.kind === 'ignored') {
    // `notify` 之类的其它扩展 UI 不参与审批，这里不接管（保持 M1–M4 行为不变）
    return 'ignored'
  }

  const request = classified.request
  const sessionKey = event.sessionKey
  const session = usePermissionStore.getState().sessions[sessionKey]

  // 协议不兼容：显式拒绝，不弹窗、不放行（fail-closed）
  if (session?.compatible === false) {
    usePermissionStore.getState().countAutoDenied(sessionKey)
    void sendResponse(api, sessionKey, request, 'deny')
    banner({
      level: 'warn',
      message: `审批扩展协议不兼容，已自动拒绝工具 ${request.meta.tool} 的执行`
    })
    return 'auto-denied'
  }

  const taskId = useSessionStore.getState().taskIdForSession(sessionKey)
  usePermissionStore.getState().pushApproval({
    sessionKey,
    taskId,
    request,
    receivedAt: now()
  })

  // 客户端超时：同一个审批时钟减去提前量，先手回拒绝（结果与扩展侧超时一致）
  const waitMs = clientApprovalTimeoutMs(request.timeoutMs)
  clearTimer(request.requestId)
  const timer = setTimeout(() => {
    timers.delete(request.requestId)
    const pending = usePermissionStore
      .getState()
      .sessions[sessionKey]?.pending.find((item) => item.requestId === request.requestId)
    if (pending === undefined) return
    void sendResponse(api, sessionKey, request, 'deny')
    banner({
      level: 'warn',
      message: `审批超时（${Math.round(request.timeoutMs / 1000)}s），已自动拒绝工具 ${request.meta.tool} 的执行`
    })
  }, waitMs)
  timers.set(request.requestId, timer)

  return 'approval'
}

/** 用户点了「允许一次 / 本会话允许 / 拒绝」 */
export async function respondApproval(
  api: PiApi,
  requestId: string,
  choice: ApprovalChoice
): Promise<boolean> {
  const pending = findPending(requestId)
  if (pending === undefined) return false
  return sendResponse(api, pending.sessionKey, pending.request, choice)
}

/**
 * 会话销毁 / 进程退出：清空该会话的未决审批与「本会话允许」记忆。
 *
 * 主进程侧也会主动对未决请求回拒绝（`SessionService.denyPendingExtUi`），
 * 这里只负责 renderer 侧的状态清理，避免留下永远转圈的弹窗。
 */
export function forgetSession(sessionKey: string): void {
  clearApprovalTimers(sessionKey)
  usePermissionStore.getState().clearSession(sessionKey)
}
