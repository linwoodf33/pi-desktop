import { create } from 'zustand'

import type { RunStatus } from '../../shared/contracts/types'
import type { RunPhase } from '../lib/reducer'

/**
 * runStore（§5.5 stores/runStore）：运行态 + 错误条。
 *
 * - `phase`：`idle / streaming / tool_running / settling`，来源是 reducer 归约结果
 *   （`tool_running` 由 `tool_execution_start` 驱动），以及 `evt:status` 的粗粒度兜底；
 * - `statuses`：按 **sessionKey** 关联的 `evt:status`（M3 多会话前提）；
 * - `banners`：`evt:diagnostic`、IPC 失败（`Result.error`）、渲染期未捕获异常（E6）；
 * - `aborting/aborted`：停止按钮的 300ms 内反馈（E4）。
 */
export type BannerLevel = 'info' | 'warn' | 'error'

export interface Banner {
  id: string
  level: BannerLevel
  message: string
  detail?: string
}

export interface RunStoreState {
  phases: Record<string, RunPhase>
  statuses: Record<string, RunStatus>
  banners: Banner[]
  aborting: Record<string, true>
  aborted: Record<string, true>
  /** 模型/档位切换在途（禁用重复提交，M4） */
  switching: Record<string, true>
  /** 分叉在途（禁用重复提交，M4） */
  forking: Record<string, true>
  /**
   * A36：结束会话在途（`session:dispose` 未返回）。
   * 必须在 await **之前**置位：`exited` 事件可能先于 IPC 响应到达，届时要靠它区分
   * 「用户主动结束」与 A6 的「子进程意外退出」。
   */
  ending: Record<string, true>
  /** `pi:locate` 自检在途（A12 引导按钮的 loading） */
  locating: boolean

  setLocating: (locating: boolean) => void
  setSwitching: (taskId: string, value: boolean) => void
  setForking: (taskId: string, value: boolean) => void
  setEnding: (taskId: string, value: boolean) => void
  setPhase: (taskId: string, phase: RunPhase) => void
  setStatus: (sessionKey: string, status: RunStatus) => void
  /** 由 `evt:status` 推导 phase（tool_running 不会被粗粒度状态覆盖） */
  applyStatus: (taskId: string, status: RunStatus) => void
  pushBanner: (banner: { level: BannerLevel; message: string; detail?: string }) => void
  dismissBanner: (id: string) => void
  clearBanners: () => void
  setAborting: (taskId: string, value: boolean) => void
  markAborted: (taskId: string) => void
  clearAborted: (taskId: string) => void
}

let bannerSeq = 0

/**
 * `evt:status` → phase 的粗粒度映射（§5.4 事件表 / §5.3 连接状态语义）。
 *
 * 只有 reducer 才能给出 `tool_running` 这种细粒度状态，因此这里**不降级**它：
 * `running` 期间保留 `tool_running`，只有 `settled/exited/recycled` 才回 `idle`。
 */
export function phaseFromStatus(current: RunPhase, status: RunStatus): RunPhase {
  switch (status) {
    case 'starting':
      return current === 'settling' ? 'settling' : 'streaming'
    case 'running':
      return current === 'tool_running' ? 'tool_running' : 'streaming'
    case 'settled':
      return 'idle'
    case 'exited':
      return 'idle'
    case 'recycled':
      return 'idle'
    default:
      return current
  }
}

/** 按钮可用的唯一判据：真的可以继续发消息（§7 约束 7：只认 agent_settled） */
export function canSend(phase: RunPhase, options: { aborting: boolean }): boolean {
  if (options.aborting) return false
  return phase === 'idle'
}

export const useRunStore = create<RunStoreState>()((set, get) => ({
  phases: {},
  statuses: {},
  banners: [],
  aborting: {},
  aborted: {},
  switching: {},
  forking: {},
  ending: {},
  locating: false,

  setLocating: (locating) => {
    set({ locating })
  },
  setSwitching: (taskId, value) => {
    set((state) => {
      const switching = { ...state.switching }
      if (value) switching[taskId] = true
      else delete switching[taskId]
      return { switching }
    })
  },
  setForking: (taskId, value) => {
    set((state) => {
      const forking = { ...state.forking }
      if (value) forking[taskId] = true
      else delete forking[taskId]
      return { forking }
    })
  },
  setEnding: (taskId, value) => {
    set((state) => {
      const ending = { ...state.ending }
      if (value) ending[taskId] = true
      else delete ending[taskId]
      return { ending }
    })
  },
  setPhase: (taskId, phase) => {
    set((state) => ({ phases: { ...state.phases, [taskId]: phase } }))
  },

  setStatus: (sessionKey, status) => {
    set((state) => ({ statuses: { ...state.statuses, [sessionKey]: status } }))
  },

  applyStatus: (taskId, status) => {
    const current = get().phases[taskId] ?? 'idle'
    const next = phaseFromStatus(current, status)
    if (next !== current) set((state) => ({ phases: { ...state.phases, [taskId]: next } }))
  },

  pushBanner: ({ level, message, detail }) => {
    bannerSeq += 1
    const banner: Banner = {
      id: `banner-${bannerSeq}`,
      level,
      message,
      ...(detail === undefined ? {} : { detail })
    }
    set((state) => ({
      // 同一条文案重复触发时**替换**而不是追加：连续点「保存设置」不该堆出一摞一样的提示
      banners: [
        ...state.banners.filter(
          (item) => !(item.level === level && item.message === message && item.detail === detail)
        ),
        banner
      ].slice(-5)
    }))
  },

  dismissBanner: (id) => {
    set((state) => ({ banners: state.banners.filter((banner) => banner.id !== id) }))
  },

  clearBanners: () => {
    set({ banners: [] })
  },

  setAborting: (taskId, value) => {
    set((state) => {
      const aborting = { ...state.aborting }
      if (value) aborting[taskId] = true
      else delete aborting[taskId]
      return { aborting }
    })
  },

  markAborted: (taskId) => {
    set((state) => ({ aborted: { ...state.aborted, [taskId]: true } }))
  },

  clearAborted: (taskId) => {
    set((state) => {
      if (state.aborted[taskId] === undefined) return state
      const aborted = { ...state.aborted }
      delete aborted[taskId]
      return { aborted }
    })
  }
}))
