import { create } from 'zustand'

import type {
  ApprovalChoice,
  ApprovalRequest,
  PermissionHandshake
} from '../../shared/contracts/permission'

/**
 * permissionStore（M5 审批 UI 状态，§5.5）。
 *
 * 状态边界（重要）：
 * - 这里只保存**展示与记忆**所需的东西，不做 IPC（编排在 `lib/actions.ts`）；
 * - `pending` 以 `sessionKey` 分桶：多会话并行时各自排队，UI 只显示当前任务的；
 * - `allowSession` 按 `sessionKey + 工具名` 记忆「本会话允许」：
 *   **仅在本会话有效**，会话 dispose/exit/回收时整桶删除（不跨会话、不跨进程、不落盘）；
 * - `handshake` 保存扩展上报的协议版本；`compatible === false` 时 UI 必须显式告警，
 *   并且客户端会对该会话的审批请求直接回「拒绝」（见 actions.ts），绝不静默放行。
 */

export interface PendingApproval {
  requestId: string
  sessionKey: string
  /** 归属的任务 id（用于选中态判断与展示） */
  taskId: string | undefined
  request: ApprovalRequest
  /** 收到时间（毫秒，便于显示倒计时） */
  receivedAt: number
}

export interface SessionPermissionState {
  pending: PendingApproval[]
  /** 本会话已「允许」的工具名（小写） */
  allowedTools: string[]
  /** 扩展握手结果 */
  handshake: PermissionHandshake | undefined
  compatible: boolean
  /** 因协议不兼容被客户端自动拒绝的次数（诊断用，UI 展示） */
  autoDenied: number
}

const EMPTY_SESSION: SessionPermissionState = {
  pending: [],
  allowedTools: [],
  handshake: undefined,
  compatible: true,
  autoDenied: 0
}

export interface PermissionStoreState {
  sessions: Record<string, SessionPermissionState>

  /** 记录扩展握手（setStatus 载荷） */
  applyHandshake: (sessionKey: string, handshake: PermissionHandshake, compatible: boolean) => void
  /** 入队一条审批请求（同 requestId 不重复入队） */
  pushApproval: (input: {
    sessionKey: string
    taskId: string | undefined
    request: ApprovalRequest
    receivedAt: number
  }) => void
  /** 移除一条审批请求（回答后 / 超时后 / 会话销毁后） */
  removeApproval: (sessionKey: string, requestId: string) => void
  /** 记住「本会话允许」（只在本 sessionKey 内生效） */
  rememberAllowSession: (sessionKey: string, toolName: string) => void
  /** 该会话是否已允许过这个工具 */
  isAllowedInSession: (sessionKey: string, toolName: string) => boolean
  /** 记录一次自动拒绝（协议不兼容等） */
  countAutoDenied: (sessionKey: string) => void
  /** 会话销毁：清空该会话的全部状态（未决请求 + 本会话允许记忆） */
  clearSession: (sessionKey: string) => void
  /** 全部清空（测试 / 退出时） */
  reset: () => void
}

export const usePermissionStore = create<PermissionStoreState>()((set, get) => ({
  sessions: {},

  applyHandshake: (sessionKey, handshake, compatible) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionKey]: {
          ...(state.sessions[sessionKey] ?? EMPTY_SESSION),
          handshake,
          compatible
        }
      }
    }))
  },

  pushApproval: ({ sessionKey, taskId, request, receivedAt }) => {
    set((state) => {
      const current = state.sessions[sessionKey] ?? EMPTY_SESSION
      const existing = current.pending.find((item) => item.requestId === request.requestId)
      if (existing !== undefined) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionKey]: {
            ...current,
            pending: [
              ...current.pending,
              { requestId: request.requestId, sessionKey, taskId, request, receivedAt }
            ]
          }
        }
      }
    })
  },

  removeApproval: (sessionKey, requestId) => {
    set((state) => {
      const current = state.sessions[sessionKey] ?? EMPTY_SESSION
      return {
        sessions: {
          ...state.sessions,
          [sessionKey]: {
            ...current,
            pending: current.pending.filter((item) => item.requestId !== requestId)
          }
        }
      }
    })
  },

  rememberAllowSession: (sessionKey, toolName) => {
    const tool = toolName.toLowerCase()
    set((state) => {
      const current = state.sessions[sessionKey] ?? EMPTY_SESSION
      if (current.allowedTools.includes(tool)) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionKey]: { ...current, allowedTools: [...current.allowedTools, tool] }
        }
      }
    })
  },

  isAllowedInSession: (sessionKey, toolName) => {
    const current = get().sessions[sessionKey]
    return current?.allowedTools.includes(toolName.toLowerCase()) === true
  },

  countAutoDenied: (sessionKey) => {
    set((state) => {
      const current = state.sessions[sessionKey] ?? EMPTY_SESSION
      return {
        sessions: {
          ...state.sessions,
          [sessionKey]: { ...current, autoDenied: current.autoDenied + 1 }
        }
      }
    })
  },

  clearSession: (sessionKey) => {
    set((state) => {
      if (state.sessions[sessionKey] === undefined) return state
      const sessions = { ...state.sessions }
      delete sessions[sessionKey]
      return { sessions }
    })
  },

  reset: () => {
    set({ sessions: {} })
  }
}))

/** 当前选中任务对应的未决审批（无则 undefined） */
export function selectPendingApproval(
  sessions: Record<string, SessionPermissionState>,
  taskId: string | undefined
): PendingApproval | undefined {
  if (taskId === undefined) return undefined
  for (const session of Object.values(sessions)) {
    const hit = session.pending.find((item) => item.taskId === taskId)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 「本会话允许」在 UI 上的文案（工具名列表） */
export function allowedToolsLabel(state: SessionPermissionState | undefined): string | undefined {
  const tools = state?.allowedTools ?? []
  return tools.length === 0 ? undefined : tools.join(', ')
}

export type { ApprovalChoice }
