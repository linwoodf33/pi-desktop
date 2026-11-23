import { create } from 'zustand'

import type { AppConfigView, BootState, PiSelfCheckStatus } from '../../shared/contracts/types'
import type { PiApi } from '../../shared/contracts/api'
import type { Result } from '../../shared/contracts/result'

/**
 * 桥接探测结果：M1 用它验证 preload → main IPC 通路是否真的打通。
 * `error` 只保留错误码与消息，不放大对象（renderer 不记录敏感数据）。
 */
export type BridgeStatus =
  | { phase: 'idle' }
  | { phase: 'probing' }
  | { phase: 'ok'; boot: BootState; sessionCount: number }
  | { phase: 'error'; code: string; message: string }

export interface AppStore {
  bridge: BridgeStatus
  /** 当前生效的偏好（`app:getBoot` 初值 + `config:update` 回写） */
  config: AppConfigView | undefined
  /** 属性式函数类型：避免 unbound-method（store 方法会被解构使用） */
  probeBridge: () => Promise<void>
  setConfig: (config: AppConfigView) => void
  /**
   * 回写一次自检结果（A12 收口）。
   *
   * 为什么需要：`piStatus` 原本只在 `app:getBoot` 里取一次，而主进程的启动自检是
   * **异步**的（`void piLocator.locate(...)`），renderer 探测经常早于自检完成 → 头部
   * 一直显示 `pi unknown`；用户点「定位 pi」明明自检通过，界面也毫无变化（既没有
   * 「已就绪」，也没有提示），A12 的「三步内解除阻塞」实际卡在第一步。
   *
   * 语义边界：只更新**已有** boot 视图；桥接未就绪时不动（不伪造 boot）。
   */
  setPiStatus: (piStatus: PiSelfCheckStatus) => void
}

export interface BridgeProbeDeps {
  /** 便于单测注入；生产环境取 globalThis.pi（preload 注入） */
  api?: PiApi | undefined
}

/** 读取 preload 暴露的 `window.pi`；类型上用 globalThis 访问，避免依赖 DOM 库 */
function getGlobalPi(): PiApi | undefined {
  return (globalThis as { pi?: PiApi }).pi
}

/**
 * 探测 preload 桥接：调用一次 `app:getBoot` 与 `session:list`（架构文档 §5.4）。
 *
 * 返回纯数据，由 store 保存；这里不触碰 React，便于单测。
 */
export async function runBridgeProbe(deps: BridgeProbeDeps = {}): Promise<BridgeStatus> {
  const api = 'api' in deps ? deps.api : getGlobalPi()

  if (!api) {
    return {
      phase: 'error',
      code: 'NO_BRIDGE',
      message: 'window.pi 不存在：preload 未加载或 contextIsolation 配置异常'
    }
  }

  try {
    const boot: Result<BootState> = await api.app.getBoot()
    if (!boot.ok) {
      return { phase: 'error', code: boot.error.code, message: boot.error.message }
    }

    const sessions = await api.session.list()
    if (!sessions.ok) {
      return { phase: 'error', code: sessions.error.code, message: sessions.error.message }
    }

    return { phase: 'ok', boot: boot.data, sessionCount: sessions.data.items.length }
  } catch (error) {
    return {
      phase: 'error',
      code: 'IPC_FAILED',
      message: error instanceof Error ? error.message : '未知的 IPC 失败'
    }
  }
}

/**
 * zustand store（§5.5 stores 的 M1 最小版本）。
 * 只保存桥接探测状态；会话/运行态 store 从 M3 起逐步加入。
 */
export function createAppStore(probe: () => Promise<BridgeStatus> = () => runBridgeProbe()) {
  return create<AppStore>()((set, get) => ({
    bridge: { phase: 'idle' },
    config: undefined,
    probeBridge: async () => {
      set({ bridge: { phase: 'probing' } })
      const next = await probe()
      set({
        bridge: next,
        ...(next.phase === 'ok' ? { config: next.boot.config } : {})
      })
    },
    setConfig: (config) => {
      set({ config })
    },
    setPiStatus: (piStatus) => {
      const current = get().bridge
      if (current.phase !== 'ok') return
      set({ bridge: { ...current, boot: { ...current.boot, piStatus } } })
    }
  }))
}

export const useAppStore = createAppStore()
